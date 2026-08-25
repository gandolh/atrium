import { z } from "zod";
// Import from the leaf module, not ./index.js, to avoid an import cycle
// (index.js re-exports this file). `fileTypeSchema` === the format enum
// (pdf | epub | mp3 | mp4 | webm); `mediaKindSchema` === book | audio | video.
import { type FileType, fileTypeSchema, mediaKindSchema } from "./file-validation.js";

/**
 * Library book contract (decisions.md D24) — the shape the API returns for a
 * saved book and the client renders as a cover card. Shared so apps/web and
 * apps/api can't drift (D11).
 *
 * The API owns storage (SQLite row + files on disk, D25); this is the *wire*
 * shape only. `filePath`/`coverPath` stay server-side and are NOT exposed —
 * the client fetches bytes via `/library/:id/file` and `/library/:id/cover`.
 */

/**
 * Where a library book came from: a user `upload` (the default) or a catalog
 * `import` (brief 22). Stored on the row and surfaced on the wire so the client
 * can badge imported books and cross-reference them against a catalog id.
 */
export const BOOK_SOURCES = ["upload", "gutenberg"] as const;
export const bookSourceSchema = z.enum(BOOK_SOURCES);
export type BookSource = z.infer<typeof bookSourceSchema>;

/**
 * Where a book sits in the convert machine (D34, brief 34). `none` is every
 * book that has never been converted; `running` means a job is in flight;
 * `ready` and `poor` both mean a **converted book** exists and opens — `poor`
 * only adds "this looks scanned, expect little text", which the UI *warns*
 * about and never blocks on (decision 12). `failed` carries a reason and a
 * retry.
 *
 * The status lives on the **source book**, not on the converted book: it
 * describes the conversion, and the source is the row the reader is looking at
 * when it asks for one.
 */
export const CONVERT_STATUSES = ["none", "running", "ready", "poor", "failed"] as const;
export const convertStatusSchema = z.enum(CONVERT_STATUSES);
export type ConvertStatus = z.infer<typeof convertStatusSchema>;

/**
 * The format a **convert** of `format` produces — `pdf → epub`, `epub → pdf`,
 * and **null for mp3/mp4/webm**, which have no conversion target at all.
 *
 * One source of truth for the pair, deliberately shaped like `kindForFormat`:
 * the API turns the null into a 400 and the client uses it to decide whether to
 * offer the button and what to call it, and those two must never disagree about
 * what a given format converts to.
 */
export function convertTargetForFormat(format: FileType): FileType | null {
  switch (format) {
    case "pdf":
      return "epub";
    case "epub":
      return "pdf";
    default:
      return null;
  }
}

/** A book as seen by the client (no server-side paths). */
export const libraryBookSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Author, or null when it couldn't be extracted. */
  author: z.string().nullable(),
  format: fileTypeSchema,
  /**
   * Media kind (brief 23) derived from `format` at upload: "book" for pdf/epub,
   * "audio" for mp3, "video" for mp4/webm. Drives the gallery type filter and
   * whether the reader or a media player opens. Existing rows migrate to "book".
   */
  kind: mediaKindSchema,
  /**
   * Playback length in seconds for audio/video, or null (books, or when the
   * container didn't expose a duration). The audio/video sibling of a page
   * count — drives the `mm:ss` caption and resume math.
   */
  durationSeconds: z.number().nullable(),
  /**
   * Provenance (brief 22): "upload" for user uploads (the default so existing
   * rows and the upload path stay correct), "gutenberg" for catalog imports.
   */
  source: bookSourceSchema.default("upload"),
  /**
   * Upstream id within `source` — the Project Gutenberg id (as a string) for a
   * "gutenberg" import, null for an upload. The `/discover` UI matches this
   * against catalog results to show an "In library" badge.
   */
  sourceId: z.string().nullable(),
  /** Series name (e.g. "Mistborn"), or null when the file carries none. */
  series: z.string().nullable(),
  /** Position within `series` (e.g. 2 for book two), or null when unknown. */
  seriesIndex: z.number().nullable(),
  /** All subject/genre tags (dc:subject / PDF Subject+Keywords); [] when none. */
  subjects: z.array(z.string()),
  /** Whether a cover thumbnail was extracted (drives fallback tile in the UI). */
  hasCover: z.boolean(),
  /** Original file size in bytes. */
  sizeBytes: z.number().int().nonnegative(),
  /**
   * Reading progress, 0..1, for the CURRENT user (progress is per-user; the
   * library itself is shared). Drives the cover's progress bar — the coarse
   * "how far in", distinct from the exact resume position in `locator`.
   */
  progress: z.number().min(0).max(1),
  /**
   * The current user's exact resume position, or null if they haven't opened
   * the book. Opaque locator: a page number (as a string) for PDF, an epub.js
   * CFI for EPUB. The reader seeds its starting position from this so a refresh
   * / reopen lands back where the user left off.
   */
  locator: z.string().nullable(),
  /** ISO timestamp the book was added. */
  createdAt: z.string(),
  /** ISO timestamp the book was last opened, or null if never opened. */
  lastOpenedAt: z.string().nullable(),
  /**
   * The **source book** this row was converted from, or null when this row is
   * itself a source (D34). Non-null marks a **converted book** — a row the
   * library grid, search, chips and counts never show, reached only by the
   * reader's format switch.
   */
  convertedFrom: z.string().nullable(),
  /**
   * The **converted book** produced from this row, or null when no conversion
   * exists. The reverse of `convertedFrom`, resolved server-side, so the reader
   * can offer the format switch from either side of the pair without a second
   * request.
   */
  convertedTo: z.string().nullable(),
  /** Where this book sits in the convert machine — see `CONVERT_STATUSES`. */
  convertStatus: convertStatusSchema,
  /**
   * Why the last conversion failed, in words a reader can act on, or null.
   * Only meaningful while `convertStatus` is "failed": the button shows this
   * next to its retry, and a row reaped after an API restart says so here (the
   * job's child process is gone, so it can only be re-run — D34 decision 7).
   */
  convertError: z.string().nullable(),
});
export type LibraryBook = z.infer<typeof libraryBookSchema>;

/** `GET /library` response: the gallery list. */
export const libraryListSchema = z.array(libraryBookSchema);

/** `PATCH /library/:id/progress` request body. */
export const updateProgressSchema = z.object({
  progress: z.number().min(0).max(1),
  /** Exact resume position (see `LibraryBook.locator`). Omitted/null leaves the
   * stored locator untouched. */
  locator: z.string().min(1).nullish(),
  /**
   * The profile this reading was recorded *as* (brief 35). Omitted on a normal
   * live PATCH — the route resolves the profile from the session, which is
   * always right when the write happens as it's made.
   *
   * It exists for the offline queue (brief 35 step 7). A record queued while
   * profile A was reading may only flush after a switch to B, and the session
   * by then says B — so without this the flush would silently re-attribute A's
   * reading to B, which is the exact bug that step exists to prevent. The
   * flusher names the recording profile here instead.
   *
   * Safe under D35: the account is the security boundary, the profile is not,
   * so writing as another profile *on the same account* is no more privileged
   * than switching to it and writing normally. The route still verifies the id
   * belongs to the caller's account — an unchecked client-supplied id would be
   * a cross-*account* write, which is a different and real thing.
   */
  profileId: z.string().optional(),
});
export type UpdateProgressRequest = z.infer<typeof updateProgressSchema>;

/** Sort options for the gallery (mirrors the mockup's "Sort by" control). */
export const LIBRARY_SORTS = ["recent", "title", "author"] as const;
export const librarySortSchema = z.enum(LIBRARY_SORTS);
export type LibrarySort = z.infer<typeof librarySortSchema>;

/** Grouping options for the gallery ("none" = today's flat gallery). */
export const LIBRARY_GROUPS = ["none", "author", "series", "subject"] as const;
export const libraryGroupSchema = z.enum(LIBRARY_GROUPS);
export type LibraryGroup = z.infer<typeof libraryGroupSchema>;
