import type { BookSource, ConvertStatus, FileType, MediaKind } from "@ebook-reader/shared";

/**
 * The `books` row shapes. Kept beside the model that reads and writes them
 * rather than in a shared types file: a row shape is the model's contract with
 * the table, and the only code entitled to see one is the service layer sitting
 * directly on top. Everything further out speaks `LibraryBook` from
 * `@ebook-reader/shared` — see `library.mapper.ts`, which is the one place the
 * two meet.
 */

/**
 * The convert half of a book row (brief 34, D34). Split out from `BookRow` so
 * the upload/import paths can build a row without them — they all take their
 * SQL defaults, and a book nobody has converted is the overwhelming case.
 *
 * `converted_from` is the whole architecture: a **converted book** is its own
 * `books` row pointing back at its **source book**, not an alternate file on
 * the source's row. The status columns describe the *conversion*, so they live
 * on the source — that is the row the reader is looking at when it asks for one.
 */
export interface BookConvertFields {
  /**
   * The **source book** this row was converted from, or null when this row is
   * itself a source. Non-null = a converted book, which the three list
   * statements hide (see `NOT_CONVERTED` in `library.model.ts`).
   *
   * `REFERENCES books(id) ON DELETE CASCADE`: deleting a source removes its
   * converted book's ROW for free. Its FILE is `DELETE /library/:id`'s job —
   * the cascade happens inside SQLite where no unlink can run, so a route that
   * deletes only the row it was given orphans the converted file on disk.
   */
  converted_from: string | null;
  /** Where this book sits in the convert machine (`CONVERT_STATUSES`). */
  convert_status: ConvertStatus;
  /** Why the last conversion failed, in words a reader can act on, or null. */
  convert_error: string | null;
  /**
   * ISO timestamp the running job started, or null. Kept after the job ends —
   * it is what a 24h ceiling (D34) and any "converting since…" copy measure
   * against, and `markConvertRunning` overwrites it on the next run anyway.
   */
  convert_started_at: string | null;
  /**
   * The **converted book** made from this row, or null when none exists.
   *
   * NOT a column — it is the reverse of `converted_from`, resolved by the same
   * SELECT (see `selectBooks`). The wire contract needs both link directions on
   * every row so the reader can offer the format switch from either side, and
   * looking it up per row inside `toLibraryBook` would turn one library listing
   * into N+1 queries.
   */
  converted_to: string | null;
}

/** The raw DB row (server-side; includes on-disk paths that never hit the wire). */
export interface BookRow extends BookConvertFields {
  id: string;
  title: string;
  author: string | null;
  format: FileType;
  size_bytes: number;
  progress: number;
  created_at: string;
  last_opened_at: string | null;
  /** Series name, or null when the file carries none (brief 21). */
  series: string | null;
  /** Position within `series`, or null when unknown (brief 21). */
  series_index: number | null;
  /**
   * JSON-encoded `string[]` of subject/genre tags (brief 21), or null for a row
   * that predates the column and hasn't been backfilled yet — the backfill uses
   * `subjects IS NULL` as its "needs re-scan" sentinel, so a scanned-but-empty
   * book stores `'[]'`, never null.
   */
  subjects: string | null;
  /**
   * Provenance (brief 22): "upload" for user uploads, "gutenberg" for catalog
   * imports. Column has `DEFAULT 'upload'` so existing rows and the upload path
   * are correct without a backfill.
   */
  source: BookSource;
  /** Upstream id within `source` (the Gutenberg id for imports), else null. */
  source_id: string | null;
  /**
   * Media kind (brief 23), derived from `format` at upload: "book" for pdf/epub,
   * "audio" for mp3, "video" for mp4/webm. Column has `DEFAULT 'book'` so
   * pre-media rows migrate to books with no backfill.
   */
  kind: MediaKind;
  /** Playback length in seconds for audio/video, or null (books / unknown). */
  duration_seconds: number | null;
}

/**
 * A row as the upload/import paths build it: everything except the convert
 * fields, which the column defaults supply (`convert_status` = 'none', the rest
 * NULL). A **converted book** is never inserted this way — it goes through
 * `insertConvertedBook`, the only place `converted_from` is written.
 */
export type NewBookRow = Omit<BookRow, keyof BookConvertFields>;
