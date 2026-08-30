import { existsSync } from "node:fs";
import type { LibraryBook } from "@ebook-reader/shared";
import { coverOwnerId, coverPathFor } from "../../common/paths.js";
import type { BookConvertFields, NewBookRow } from "./library.types.js";

/**
 * The one place a `books` row becomes the `LibraryBook` the wire carries.
 * Everything outward of the service layer sees only the mapped shape — which is
 * what keeps on-disk locations off the wire (D25).
 */

/**
 * The reading state this listing is for, as the caller's per-profile lookup
 * found it. Declared structurally rather than imported from the profiles module
 * on purpose: the library does not depend on how progress is stored, only on
 * these three fields, and a type import here would be the first thread of a
 * cycle between two modules that have no business knowing each other.
 */
export interface BookProgress {
  /** 0..1, drives the cover progress bar. */
  progress: number;
  /** Opaque resume position: PDF page number (string) or EPUB CFI; null if unset. */
  locator: string | null;
  /** ISO timestamp of the profile's last write, or absent if never opened. */
  updated_at?: string | null;
}

/** A profile that has never opened the book: no row, so no position. */
const UNREAD: BookProgress = { progress: 0, locator: null };

/** Decode the JSON `subjects` column to a `string[]` (empty on null/garbage). */
function parseSubjects(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Map a DB row to the wire shape (strips on-disk paths; D25). Progress + the
 * resume locator are per-profile, so they're passed in from the caller's
 * `reading_progress` lookup; absent means this profile hasn't opened the book.
 */
export function toLibraryBook(
  row: NewBookRow & Partial<BookConvertFields>,
  progress: BookProgress = UNREAD,
): LibraryBook {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format,
    series: row.series,
    seriesIndex: row.series_index,
    subjects: parseSubjects(row.subjects),
    // The DERIVED cover file, stat'd on the spot — not a stored `cover_path`.
    // A row that claimed a cover whose file was gone (a library DB carried
    // between machines, a thumbnail removed out of band) used to make the
    // client fire a request that could only 404, which a cross-origin <img>
    // surfaces as the noisy ERR_BLOCKED_BY_ORB; a startup reconcile existed
    // solely to null those paths back out. Asking the disk instead makes the
    // drift impossible rather than correctable, which is why that machinery is
    // gone. One `existsSync` per book per listing, knowingly paid: it is a stat
    // on a path we just computed, and correctness here is worth more than a
    // cache that would reintroduce exactly the staleness we removed.
    //
    // `converted_from` is optional on this parameter type (a freshly-built
    // upload row has not got one), so it is normalised explicitly rather than
    // by widening `coverOwnerId` — see the note on that function for why the
    // key is required there.
    hasCover: existsSync(
      coverPathFor(coverOwnerId({ id: row.id, converted_from: row.converted_from ?? null })),
    ),
    sizeBytes: row.size_bytes,
    progress: progress.progress,
    locator: progress.locator,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    durationSeconds: row.duration_seconds,
    // Both link directions come off the row the caller already has: the read
    // queries resolve `converted_to` in the same SELECT (`selectBooks`), so
    // rendering a library of N books is still one query, not N+1.
    //
    // The fallbacks are for the upload/import paths, which hand a row they just
    // built rather than one read back: a book being inserted is never a
    // conversion and has never been converted, which is exactly what the SQL
    // defaults say too.
    convertedFrom: row.converted_from ?? null,
    convertedTo: row.converted_to ?? null,
    convertStatus: row.convert_status ?? "none",
    convertError: row.convert_error ?? null,
    // The active profile's `reading_progress.updated_at` for this row, or null
    // when they've never opened it (brief 34 step 7's pre-authorised addition —
    // the wire previously exposed no progress timestamp at all). Lets the client
    // compare a linked pair's two rows and reopen whichever this reader used
    // last, without a second per-book request.
    lastReadAt: progress.updated_at ?? null,
  };
}
