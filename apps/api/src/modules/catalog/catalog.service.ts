import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { kindForFormat, type CatalogSearchParams, type CatalogSearchResponse } from "@ebook-reader/shared";
import { LIBRARY_FILES_DIR, MAX_UPLOAD_BYTES, THUMBNAILS_DIR } from "../../common/config.js";
import { coverPathFor, filePathFor } from "../../common/paths.js";
import { extractMeta } from "../library/extract.service.js";
import { insertBook } from "../library/library.model.js";
import type { NewBookRow } from "../library/library.types.js";
import {
  OverCapError,
  cacheGet,
  cacheKey,
  cacheSet,
  downloadCapped,
  fetchCatalog,
  resolveGutenbergBook,
} from "./gutendex.service.js";

/**
 * Catalog rules (brief 22): the cached search, and the import that turns a
 * Gutenberg book into an ordinary library row.
 *
 * The import deliberately runs the **same** extract→store pipeline the upload
 * route uses. A catalog book is not a special kind of book — it is a book with
 * `source: 'gutenberg'` and an upstream id recorded, so the /discover UI can
 * badge it as already in the library. Everything downstream (the reader, the
 * grid, convert, offline) treats it exactly like an upload, and that is the
 * point.
 */

export type SearchResult =
  | { ok: true; data: CatalogSearchResponse; cached: boolean }
  | { ok: false; reason: "UPSTREAM"; cause: unknown };

export type ImportResult =
  | { ok: true; row: NewBookRow }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "NO_EPUB" }
  | { ok: false; reason: "TOO_LARGE" }
  | { ok: false; reason: "RESOLVE_FAILED"; cause: unknown }
  | { ok: false; reason: "DOWNLOAD_FAILED"; cause: unknown };

/** Search the catalog, serving a repeat query from the TTL cache. */
export async function searchCatalog(params: CatalogSearchParams): Promise<SearchResult> {
  const key = cacheKey(params);
  const cached = cacheGet(key);
  if (cached) return { ok: true, data: cached, cached: true };

  try {
    const data = await fetchCatalog(params);
    cacheSet(key, data);
    return { ok: true, data, cached: false };
  } catch (cause) {
    return { ok: false, reason: "UPSTREAM", cause };
  }
}

/**
 * Resolve, download and store one Gutenberg book, returning the inserted row.
 *
 * Four upstream failures, all of them ordinary answers rather than bugs: no
 * such book, no EPUB edition, an EPUB over the upload cap, and the network. The
 * caller maps each to its status code.
 */
export async function importGutenbergBook(
  gutenbergId: number,
  log: FastifyBaseLogger,
): Promise<ImportResult> {
  // 1. Resolve metadata + the EPUB URL via Gutendex.
  let resolved;
  try {
    resolved = await resolveGutenbergBook(gutenbergId);
  } catch (cause) {
    return { ok: false, reason: "RESOLVE_FAILED", cause };
  }
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  if (!resolved.epubUrl) return { ok: false, reason: "NO_EPUB" };
  const { book, epubUrl } = resolved;

  // 2. Download the EPUB (the one gutenberg.org request per the robot policy;
  //    size-capped at the upload limit, so memory stays bounded).
  let bytes: Buffer;
  try {
    bytes = await downloadCapped(epubUrl, MAX_UPLOAD_BYTES);
  } catch (cause) {
    if (cause instanceof OverCapError) return { ok: false, reason: "TOO_LARGE" };
    return { ok: false, reason: "DOWNLOAD_FAILED", cause };
  }

  // 3. Run the EXISTING extract→store pipeline (mirrors the upload route).
  const id = randomUUID();
  const format = "epub" as const;
  await mkdir(LIBRARY_FILES_DIR, { recursive: true });
  // Derived location, not stored — same as the upload route (D39).
  await writeFile(filePathFor(id, format), bytes);

  let meta;
  try {
    meta = await extractMeta(bytes, format, `${book.title}.epub`);
    if (meta.cover) {
      await mkdir(THUMBNAILS_DIR, { recursive: true });
      await writeFile(coverPathFor(id), meta.cover);
    }
  } catch (err) {
    // A book with no cover is still a book. Fall back to what Gutendex already
    // told us rather than failing an import over a thumbnail.
    log.warn({ err }, "cover/metadata extraction failed for import");
    meta = {
      title: book.title,
      author: book.authors[0] ?? null,
      series: null,
      seriesIndex: null,
      subjects: book.subjects,
      cover: null,
    };
  }

  const row: NewBookRow = {
    id,
    title: meta.title,
    author: meta.author,
    format,
    size_bytes: bytes.length,
    progress: 0,
    created_at: new Date().toISOString(),
    last_opened_at: null,
    series: meta.series,
    series_index: meta.seriesIndex,
    subjects: JSON.stringify(meta.subjects),
    // Catalog provenance: remember where it came from + its Gutenberg id so the
    // /discover UI can badge it as "In library".
    source: "gutenberg",
    source_id: String(gutenbergId),
    // Catalog imports are always EPUB books (brief 23); no playback duration.
    kind: kindForFormat(format),
    duration_seconds: null,
  };
  await insertBook(row);
  return { ok: true, row };
}
