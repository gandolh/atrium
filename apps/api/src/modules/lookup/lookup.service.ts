import sharp from "sharp";
import {
  LOOKUP_MAX_CANDIDATES,
  isLookupCoverRef,
  lookupSourceForKind,
  lookupSourceSchema,
  type LookupApplyRequest,
  type LookupCandidate,
  type LookupSearchParams,
  type LookupSearchResponse,
  type LookupSource,
} from "@ebook-reader/shared";
import { getBook } from "../library/library.model.js";
import { setBookCover, updateBookMetadataFields } from "../library/library.service.js";
import { NoCoverError, TtlCache, fetchImage } from "./lookup-http.js";
import { coverArtArchiveUrl, searchMusicBrainz, searchWords } from "./musicbrainz.service.js";
import { openLibraryCoverUrl, searchOpenLibrary } from "./openlibrary.service.js";

/**
 * Metadata lookup rules (brief 100, D59): search the right source for one
 * item, write back the fields a person kept, and serve the candidates'
 * thumbnails. Only ever on request — nothing here runs on upload, and nothing
 * calls it but the routes in `lookup.controller.ts`.
 *
 * Music asks MusicBrainz, books ask Open Library, video asks nobody
 * (`lookupSourceForKind`): a film lookup needs a TMDb key, which D59 leaves
 * out until the owner registers one.
 */

/** Repeat searches inside 15 minutes are answered here and never reach the source. */
const searchCache = new TtlCache<LookupCandidate[]>(15 * 60 * 1000, 200);
/** Thumbnails, and the knowledge that a source has none (`null`), for as long. */
const thumbnailCache = new TtlCache<Buffer | null>(15 * 60 * 1000, 100);

/** For tests: forget every cached search and thumbnail. */
export function clearLookupCaches(): void {
  searchCache.clear();
  thumbnailCache.clear();
}

type Upstream = { ok: false; reason: "UPSTREAM"; source: LookupSource; cause: unknown };

export type LookupSearchResult =
  | { ok: true; data: LookupSearchResponse; cached: boolean }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "NO_SOURCE" }
  | { ok: false; reason: "EMPTY_QUERY" }
  | Upstream;

export type LookupApplyResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "NO_SOURCE" }
  | { ok: false; reason: "WRONG_SOURCE" }
  | { ok: false; reason: "NO_COVER" }
  | { ok: false; reason: "BAD_COVER" }
  | Upstream;

export type LookupThumbnailResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "BAD_REF" }
  | { ok: false; reason: "NO_COVER" }
  | Upstream;

function coverUrl(source: LookupSource, ref: string, size: "thumb" | "full"): string {
  return source === "musicbrainz" ? coverArtArchiveUrl(ref, size) : openLibraryCoverUrl(ref, size);
}

// --- Search ------------------------------------------------------------------

/**
 * Search the item's source. The item's own title and author are the query
 * unless the person typed one: if either `title` or `author` is given, both
 * come from the request (an empty one is left out of the query).
 */
export async function searchForItem(id: string, params: LookupSearchParams): Promise<LookupSearchResult> {
  const row = await getBook(id);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  const source = lookupSourceForKind(row.kind);
  if (!source) return { ok: false, reason: "NO_SOURCE" };

  const typed = params.title !== undefined || params.author !== undefined;
  const title = searchWords(typed ? params.title : row.title);
  const author = searchWords(typed ? params.author : row.author);
  if (!title && !author) return { ok: false, reason: "EMPTY_QUERY" };

  const key = JSON.stringify([source, title.toLowerCase(), author.toLowerCase()]);
  const hit = searchCache.get(key);
  if (hit) return { ok: true, data: { source, candidates: hit }, cached: true };

  try {
    const candidates =
      source === "musicbrainz"
        ? await searchMusicBrainz(title, author, LOOKUP_MAX_CANDIDATES)
        : await searchOpenLibrary(title, author, LOOKUP_MAX_CANDIDATES);
    searchCache.set(key, candidates);
    return { ok: true, data: { source, candidates }, cached: false };
  } catch (cause) {
    return { ok: false, reason: "UPSTREAM", source, cause };
  }
}

// --- Apply -------------------------------------------------------------------

/**
 * Write the ticked fields of the chosen candidate onto the item.
 *
 * **A failure changes nothing.** The cover is fetched first and decoded
 * second, both before any write: a source that is down, a cover that turns
 * out not to exist, or bytes that are not an image all return before the row
 * or the thumbnail is touched. The cover goes through `setBookCover`, the
 * library's one cover setter (D40), so sharp re-encodes it and the source's
 * bytes are never stored as they came.
 *
 * The candidate arrives from the browser, which is fine for its text: the
 * person could type the same values. Its cover is not a URL but an id the
 * shared schema has already checked, and the URL is built here.
 */
export async function applyLookup(id: string, body: LookupApplyRequest): Promise<LookupApplyResult> {
  const row = await getBook(id);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  const source = lookupSourceForKind(row.kind);
  if (!source) return { ok: false, reason: "NO_SOURCE" };
  const { candidate, fields } = body;
  if (candidate.source !== source) return { ok: false, reason: "WRONG_SOURCE" };

  if (fields.cover && candidate.coverRef !== null) {
    let bytes: Buffer;
    try {
      bytes = await fetchImage(coverUrl(source, candidate.coverRef, "full"));
    } catch (cause) {
      if (cause instanceof NoCoverError) return { ok: false, reason: "NO_COVER" };
      return { ok: false, reason: "UPSTREAM", source, cause };
    }
    const set = await setBookCover(row, bytes);
    if (!set.ok) return { ok: false, reason: "BAD_COVER" };
  }

  await updateBookMetadataFields(row, {
    title: fields.title ? candidate.title : undefined,
    author: fields.author ? (candidate.author ?? undefined) : undefined,
    series: fields.series ? (candidate.series ?? undefined) : undefined,
    seriesIndex: fields.seriesIndex ? (candidate.seriesIndex ?? undefined) : undefined,
  });
  return { ok: true };
}

// --- Thumbnails --------------------------------------------------------------

/** The dialog's thumbnail size: a bound, not a crop. */
const THUMBNAIL_BOUND = 300;

/**
 * A candidate's cover, small, for the dialog. Fetched by the API so the
 * person's browser never contacts the source, and re-encoded so whatever the
 * source sent is not what the browser gets.
 */
export async function lookupThumbnail(rawSource: string, ref: string): Promise<LookupThumbnailResult> {
  const parsedSource = lookupSourceSchema.safeParse(rawSource);
  if (!parsedSource.success || !isLookupCoverRef(parsedSource.data, ref)) {
    return { ok: false, reason: "BAD_REF" };
  }
  const source = parsedSource.data;
  const key = `${source}/${ref}`;
  const hit = thumbnailCache.get(key);
  if (hit !== undefined) return hit ? { ok: true, bytes: hit } : { ok: false, reason: "NO_COVER" };

  let bytes: Buffer;
  try {
    bytes = await fetchImage(coverUrl(source, ref, "thumb"));
  } catch (cause) {
    if (cause instanceof NoCoverError) {
      thumbnailCache.set(key, null);
      return { ok: false, reason: "NO_COVER" };
    }
    return { ok: false, reason: "UPSTREAM", source, cause };
  }

  const thumbnail = await sharp(bytes, { limitInputPixels: 40_000_000 })
    .resize(THUMBNAIL_BOUND, THUMBNAIL_BOUND, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer()
    .catch(() => null);
  thumbnailCache.set(key, thumbnail);
  return thumbnail ? { ok: true, bytes: thumbnail } : { ok: false, reason: "NO_COVER" };
}
