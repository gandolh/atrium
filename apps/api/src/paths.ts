import { join } from "node:path";
import type { FileType } from "@ebook-reader/shared";
import { LIBRARY_FILES_DIR, THUMBNAILS_DIR } from "./config.js";

/**
 * Where a book's bytes live on disk (decisions.md D24/D25), derived from the
 * row rather than read back from it.
 *
 * This module is the single definition of where a file is. The `books` table
 * used to carry `file_path`/`cover_path` columns alongside it; they were
 * dropped once nothing read them (see `dropLegacyPathColumns` in `db.ts`).
 * That is safe because **every write has always derived its path** from the
 * same two facts these functions take: the row's id and its format. Upload,
 * catalog import and conversion all name their output `<id>.<ext>` under
 * `LIBRARY_FILES_DIR` and their thumbnail `<id>.jpg` under `THUMBNAILS_DIR`;
 * none of them has ever had a way to put a file somewhere else and then record
 * where it went. A stored path could therefore only ever agree with this
 * derivation — or disagree with it, which is what a stale absolute path
 * carried over from another machine is. Deriving on read removes the second
 * possibility: the disk becomes the single source of truth, so the DB cannot
 * drift from it.
 *
 * One convention lives here, not three: `library-routes.ts`, `catalog-routes.ts`,
 * `convert-jobs.ts` and `db.ts` all import from this module.
 */

/** The original uploaded/imported/converted file: `library/<id>.<ext>`. */
export function filePathFor(id: string, format: FileType): string {
  return join(LIBRARY_FILES_DIR, `${id}.${format}`);
}

/**
 * The cover thumbnail: `images/thumbnails/<coverOwnerId>.jpg`.
 *
 * Takes the **cover owner's** id, not just any book id — see `coverOwnerId`.
 * A converted book's cover is **reused, never re-extracted** (brief 34 keeps
 * `extract.ts` out of the convert path entirely), so a converted pair is one
 * thumbnail file with two rows pointing at it. Deleting only the conversion
 * must therefore delete the converted FILE and leave the thumbnail alone, or
 * the source loses its cover to a delete that had nothing to do with it.
 */
export function coverPathFor(coverOwnerId: string): string {
  return join(THUMBNAILS_DIR, `${coverOwnerId}.jpg`);
}

/**
 * Which row a book's thumbnail file is named after: itself, or — when this row
 * is a **converted book** — the source it was converted from.
 *
 * `converted_from ?? id` is the ownership rule, and it needs no new column
 * because it is not new information: `insertConvertedBook` has always given the
 * conversion the source's cover path verbatim, so "the two rows share one file"
 * and "the file is named after the source" were already the same statement.
 * `converted_from` is exactly the link that says which row that is.
 *
 * The consequences the delete paths depend on:
 *  - a converted book and its source both report `hasCover: true`, resolving to
 *    the *source's* file;
 *  - a row only owns its thumbnail when `converted_from === null`, so deleting
 *    a conversion never unlinks it;
 *  - deleting the source unlinks its own thumbnail, and its conversion's row is
 *    already gone by cascade — so neither delete can strip a surviving row's
 *    cover.
 *
 * `converted_from` is a REQUIRED key (nullable value), deliberately. Made
 * optional, this signature is satisfied by anything carrying an `id` — including
 * the wire-shaped `LibraryBook`, which spells the link `convertedFrom`. Such a
 * call compiles cleanly and silently resolves to the conversion's own id, which
 * on a read means a cover that never loads and on a delete means unlinking the
 * wrong file. Requiring the key makes that a compile error instead.
 */
export function coverOwnerId(row: { id: string; converted_from: string | null }): string {
  return row.converted_from ?? row.id;
}
