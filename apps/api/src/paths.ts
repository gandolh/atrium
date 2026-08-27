import { join } from "node:path";
import type { FileType } from "@ebook-reader/shared";
import {
  DOCUMENT_VERSIONS_DIR,
  LATEX_PROJECTS_DIR,
  LIBRARY_FILES_DIR,
  THUMBNAILS_DIR,
} from "./config.js";

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
 *
 * Brief 38's LaTeX paths join the same rule (D39, correction of 2026-08-27):
 * `document_versions` was specified with `pdf_path`/`source_zip_path` columns
 * and they were removed **before they were ever written**, so the derivations
 * at the bottom of this file are not a cache of a column — they are the only
 * definition of where a version's bytes live. There is nothing to disagree
 * with them, by construction.
 *
 * Everything here takes a **trusted, server-generated id** and returns a path.
 * Nothing here validates untrusted input; a project-relative path that came
 * from a client goes through `latex-paths.ts` first, which is the security
 * boundary. Keeping the two apart is deliberate: this module is a pure
 * function of ids, that one touches the filesystem and can say no.
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

/**
 * Guard that an id is really a server-generated `randomUUID()` before it is
 * used as a path component.
 *
 * The library derivations above don't do this, and the difference is real
 * rather than an inconsistency: they interpolate an id into a *filename*
 * (`<id>.pdf`), where a traversing id could at worst name a sibling file
 * inside an existing root. `projectDirFor` interpolates one into a *directory*
 * that then becomes the **confinement root** every client-supplied path in
 * that project is checked against (`latex-paths.ts`). An id containing `..`
 * would not escape the root — it would silently move the root, and every
 * subsequent confinement check would faithfully confine writes to the wrong
 * place. That failure mode is worth one regex.
 *
 * Every id these functions receive is a `randomUUID()` this server minted, so
 * this can only ever fire on a programming error — which is why it throws
 * rather than returning a result. Routes must still look the row up (scoped to
 * the profile, 404 not 403) before deriving anything from a URL parameter.
 */
function assertUuid(id: string, what: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`${what} is not a UUID: ${JSON.stringify(id)}`);
  }
}

/**
 * A LaTeX project's working tree: `latex/<projectId>/` (brief 38).
 *
 * This is the draft — mutable, per-project, never in the gallery — and it is
 * the directory `confineProjectPath` in `latex-paths.ts` confines every
 * client-supplied path to. **Never `join()` an untrusted path onto this
 * return value.** That is precisely the "one unchecked join is an arbitrary
 * file write" the brief warns about.
 */
export function projectDirFor(projectId: string): string {
  assertUuid(projectId, "project id");
  return join(LATEX_PROJECTS_DIR, projectId);
}

/**
 * A published version's PDF: `versions/<versionId>.pdf` (brief 38 step 6).
 *
 * Flat, one directory, named by the version's own id — the same shape as
 * `library/<id>.<ext>`, on purpose. The *newest* version's bytes also exist as
 * `filePathFor(bookId, "pdf")` so that `GET /library/:id/file` needs no special
 * case; that duplication is the deliberate price of not branching the single
 * derivation D39 unified.
 */
export function versionPdfPathFor(versionId: string): string {
  assertUuid(versionId, "version id");
  return join(DOCUMENT_VERSIONS_DIR, `${versionId}.pdf`);
}

/**
 * A published version's source archive: `versions/<versionId>.zip`.
 *
 * A zip of the whole project tree as it was at publish time — the owner's
 * "so it's easy to resume". A version that cannot be rebuilt is not a version,
 * which is why this sits beside the PDF rather than being optional.
 */
export function versionZipPathFor(versionId: string): string {
  assertUuid(versionId, "version id");
  return join(DOCUMENT_VERSIONS_DIR, `${versionId}.zip`);
}
