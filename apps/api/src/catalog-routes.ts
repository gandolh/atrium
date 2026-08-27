import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  catalogSearchParamsSchema,
  importRequestSchema,
  kindForFormat,
  type CatalogBook,
  type CatalogSearchParams,
  type CatalogSearchResponse,
} from "@ebook-reader/shared";
import {
  GUTENDEX_BASE_URL,
  LIBRARY_FILES_DIR,
  MAX_UPLOAD_BYTES,
  THUMBNAILS_DIR,
} from "./config.js";
import { insertBook, toLibraryBook } from "./db.js";
import { coverPathFor, filePathFor } from "./paths.js";
import { extractMeta } from "./extract.js";

/**
 * Catalog (Project Gutenberg) proxy + import routes — brief 22.
 *
 * - `GET /catalog/gutenberg` proxies the public Gutendex `/books` endpoint
 *   (search / topic / language / page, popular by default), maps its response
 *   to the shared `catalogBook` wire shape, and serves repeats from a short
 *   in-memory TTL cache so we stay polite to the community instance.
 * - `POST /library/import { gutenbergId }` resolves one book via Gutendex,
 *   downloads its EPUB (the single gutenberg.org request per the robot policy,
 *   size-capped), then runs the EXISTING extract→store pipeline and inserts a
 *   normal library row with `source: 'gutenberg'`.
 *
 * Both routes sit behind the app-wide auth guard (index.ts) — no bespoke auth.
 * Errors match the library routes' JSON shape: `{ error: string }`.
 */

// Upstream request budgets. Kept generous enough for a real book download but
// finite so a stalled upstream surfaces as a clean 502 instead of a hung
// request (AbortSignal.timeout rejects the fetch).
const GUTENDEX_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// A descriptive UA is polite and helps upstreams attribute traffic.
const USER_AGENT = "ebook-reader/0.1 (personal library; brief-22 catalog)";

// --- In-memory TTL cache -----------------------------------------------------
// Keyed on the normalized query; entries expire after CACHE_TTL_MS. Capped in
// size (oldest-out) so a long-running server can't grow it unbounded. A repeat
// query inside the TTL is served from here and never re-hits Gutendex.
const CACHE_TTL_MS = 15 * 60 * 1000; // ~15 minutes
const CACHE_MAX_ENTRIES = 200;
const catalogCache = new Map<string, { data: CatalogSearchResponse; expires: number }>();

/** Normalized, order-stable cache key for a set of search params. */
function cacheKey(params: CatalogSearchParams): string {
  return JSON.stringify({
    q: params.q?.toLowerCase() ?? "",
    topic: params.topic?.toLowerCase() ?? "",
    languages: params.languages?.toLowerCase() ?? "",
    page: params.page ?? 1,
    sort: params.sort ?? "popular",
  });
}

function cacheGet(key: string): CatalogSearchResponse | null {
  const hit = catalogCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    catalogCache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key: string, data: CatalogSearchResponse): void {
  catalogCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
  if (catalogCache.size > CACHE_MAX_ENTRIES) {
    // Map preserves insertion order — drop the oldest entry.
    const oldest = catalogCache.keys().next().value;
    if (oldest !== undefined) catalogCache.delete(oldest);
  }
}

// --- Gutendex upstream shape (parsed defensively) ---------------------------
const gutendexBookSchema = z.object({
  id: z.number(),
  title: z.string().default("Untitled"),
  authors: z.array(z.object({ name: z.string() })).default([]),
  subjects: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  formats: z.record(z.string(), z.string()).default({}),
  download_count: z.number().nullable().default(0),
});
type GutendexBook = z.infer<typeof gutendexBookSchema>;

const gutendexResponseSchema = z.object({
  count: z.number().default(0),
  next: z.string().nullable().default(null),
  previous: z.string().nullable().default(null),
  results: z.array(gutendexBookSchema).default([]),
});

/** The Gutendex cover URL (`image/jpeg` format entry), or null. */
function coverUrlFrom(formats: Record<string, string>): string | null {
  for (const [mime, url] of Object.entries(formats)) {
    if (mime.startsWith("image/jpeg")) return url;
  }
  return null;
}

/**
 * The EPUB download URL, preferring the `.images` variant. Gutendex typically
 * exposes a single `application/epub+zip` entry (already the images epub3
 * build); the `.images` preference is defensive in case more ever appear.
 */
function epubUrlFrom(formats: Record<string, string>): string | null {
  const epubs = Object.entries(formats).filter(([mime]) =>
    mime.startsWith("application/epub+zip"),
  );
  if (epubs.length === 0) return null;
  const images = epubs.find(([, url]) => url.includes(".images"));
  return (images ?? epubs[0])[1];
}

/** Map one Gutendex book to our catalog wire shape. */
function mapBook(book: GutendexBook): CatalogBook {
  return {
    id: book.id,
    title: book.title,
    authors: book.authors.map((a) => a.name),
    subjects: book.subjects,
    languages: book.languages,
    coverUrl: coverUrlFrom(book.formats),
    downloadCount: book.download_count ?? 0,
    epubAvailable: epubUrlFrom(book.formats) !== null,
  };
}

/** Parse the 1-based page number out of Gutendex's `next` URL, or null. */
function pageFromUrl(url: string | null): number | null {
  if (!url) return null;
  try {
    const page = new URL(url).searchParams.get("page");
    const n = page ? Number(page) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `books/` against the configured Gutendex base. RELATIVE (no leading
 * slash) so a mirror hosted under a sub-path (e.g. https://example.com/mirror)
 * keeps that sub-path — a root-absolute "/books/" would discard it. The base
 * is normalized with a trailing slash first so the relative resolve lands
 * alongside the sub-path instead of replacing it.
 */
function gutendexBooksUrl(): URL {
  return new URL("books/", `${GUTENDEX_BASE_URL}/`);
}

/** Build the Gutendex `/books/` request URL for a set of search params. */
function gutendexSearchUrl(params: CatalogSearchParams): string {
  const url = gutendexBooksUrl();
  if (params.q) url.searchParams.set("search", params.q);
  if (params.topic) url.searchParams.set("topic", params.topic);
  if (params.languages) url.searchParams.set("languages", params.languages);
  if (params.page) url.searchParams.set("page", String(params.page));
  // Popular (most-downloaded) is our default ordering, incl. the empty landing.
  url.searchParams.set("sort", params.sort ?? "popular");
  return url.toString();
}

/** Fetch + map a Gutendex search page. Throws on network/HTTP/timeout error. */
async function fetchCatalog(params: CatalogSearchParams): Promise<CatalogSearchResponse> {
  const res = await fetch(gutendexSearchUrl(params), {
    signal: AbortSignal.timeout(GUTENDEX_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Gutendex responded ${res.status}`);
  const upstream = gutendexResponseSchema.parse(await res.json());
  return {
    results: upstream.results.map(mapBook),
    count: upstream.count,
    nextPage: pageFromUrl(upstream.next),
  };
}

/**
 * Resolve a single Gutenberg book by id via Gutendex (`?ids=`). Returns the
 * mapped catalog book plus the raw EPUB URL (needed for the download, which the
 * mapped shape doesn't carry). null when Gutendex knows no such id.
 */
async function resolveGutenbergBook(
  id: number,
): Promise<{ book: CatalogBook; epubUrl: string | null } | null> {
  const url = gutendexBooksUrl();
  url.searchParams.set("ids", String(id));
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(GUTENDEX_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Gutendex responded ${res.status}`);
  const upstream = gutendexResponseSchema.parse(await res.json());
  const raw = upstream.results.find((b) => b.id === id);
  if (!raw) return null;
  return { book: mapBook(raw), epubUrl: epubUrlFrom(raw.formats) };
}

/** Thrown when a download exceeds the byte cap (mapped to a 413). */
class OverCapError extends Error {}

/**
 * Download `url` into memory, aborting if it exceeds `maxBytes`. Buffers (like
 * the upload path, which reads the whole file for extraction) rather than
 * streaming to a temp file — the cap is the upload limit, so memory is bounded.
 * Rejects a too-large Content-Length up front, and re-checks while streaming in
 * case the header lies or is absent.
 */
async function downloadCapped(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Download responded ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new OverCapError();
  if (!res.body) throw new Error("Download response had no body");

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new OverCapError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const UPSTREAM_ERROR = "Project Gutenberg's catalog (Gutendex) is unavailable. Please retry.";

export function registerCatalogRoutes(app: FastifyInstance): void {
  // --- GET /catalog/gutenberg — proxy + TTL cache ---------------------------
  app.get("/catalog/gutenberg", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = catalogSearchParamsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid catalog query." });
    }
    const params = parsed.data;
    const key = cacheKey(params);

    const cached = cacheGet(key);
    if (cached) {
      request.log.info({ key }, "catalog cache hit (served from TTL cache)");
      return reply.send(cached);
    }

    try {
      const data = await fetchCatalog(params);
      cacheSet(key, data);
      request.log.info({ key }, "catalog cache miss (fetched from Gutendex)");
      return reply.send(data);
    } catch (err) {
      request.log.error({ err }, "Gutendex catalog request failed");
      return reply.status(502).send({ error: UPSTREAM_ERROR });
    }
  });

  // --- POST /library/import — pull a Gutenberg book into the library ---------
  app.post("/library/import", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = importRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "gutenbergId must be a positive integer." });
    }
    const { gutenbergId } = parsed.data;

    // 1. Resolve metadata + the EPUB URL via Gutendex.
    let resolved: { book: CatalogBook; epubUrl: string | null } | null;
    try {
      resolved = await resolveGutenbergBook(gutenbergId);
    } catch (err) {
      request.log.error({ err, gutenbergId }, "Gutendex resolve failed");
      return reply.status(502).send({ error: UPSTREAM_ERROR });
    }
    if (!resolved) {
      return reply.status(404).send({ error: `No Project Gutenberg book #${gutenbergId}.` });
    }
    if (!resolved.epubUrl) {
      return reply.status(422).send({ error: "This book has no EPUB edition to import." });
    }
    const { book, epubUrl } = resolved;

    // 2. Download the EPUB (the one gutenberg.org request; size-capped).
    let bytes: Buffer;
    try {
      bytes = await downloadCapped(epubUrl, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof OverCapError) {
        return reply.status(413).send({ error: "The book's EPUB exceeds the size limit." });
      }
      request.log.error({ err, gutenbergId }, "Gutenberg EPUB download failed");
      return reply.status(502).send({ error: "Downloading the EPUB from Project Gutenberg failed. Please retry." });
    }

    // 3. Run the EXISTING extract→store pipeline (mirrors the upload route).
    const id = randomUUID();
    const format = "epub" as const;
    const filePath = filePathFor(id, format);
    await mkdir(LIBRARY_FILES_DIR, { recursive: true });
    await writeFile(filePath, bytes);

    let meta;
    try {
      meta = await extractMeta(bytes, format, `${book.title}.epub`);
      if (meta.cover) {
        await mkdir(THUMBNAILS_DIR, { recursive: true });
        // Derived location, not stored — same as the upload route.
        await writeFile(coverPathFor(id), meta.cover);
      }
    } catch (err) {
      request.log.warn({ err }, "cover/metadata extraction failed for import");
      meta = {
        title: book.title,
        author: book.authors[0] ?? null,
        series: null,
        seriesIndex: null,
        subjects: book.subjects,
        cover: null,
      };
    }

    const now = new Date().toISOString();
    const row = {
      id,
      title: meta.title,
      author: meta.author,
      format,
      size_bytes: bytes.length,
      progress: 0,
      created_at: now,
      last_opened_at: null,
      series: meta.series,
      series_index: meta.seriesIndex,
      subjects: JSON.stringify(meta.subjects),
      // Catalog provenance: remember where it came from + its Gutenberg id so
      // the /discover UI can badge it as "In library".
      source: "gutenberg" as const,
      source_id: String(gutenbergId),
      // Catalog imports are always EPUB books (brief 23); no playback duration.
      kind: kindForFormat(format),
      duration_seconds: null,
    };
    insertBook(row);

    return reply.status(201).send(toLibraryBook(row));
  });
}
