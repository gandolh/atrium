import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import {
  isFileSizeValid,
  kindForFormat,
  type FileType,
  type LibraryBook,
  type LibrarySort,
} from "@ebook-reader/shared";
import { LIBRARY_FILES_DIR, MAX_UPLOAD_BYTES, THUMBNAILS_DIR } from "../../common/config.js";
import {
  coverOwnerId,
  coverPathFor,
  filePathFor,
  versionPdfPathFor,
  versionZipPathFor,
} from "../../common/paths.js";
import { listDocumentVersions } from "../latex/latex.model.js";
import { getProfileProgress, listProfileProgress } from "../profiles/profiles.model.js";
import { cancelConvert, isConverting, startConvert } from "./convert.service.js";
import { extractMeta, toVideoThumbnail } from "./extract.service.js";
import { toLibraryBook } from "./library.mapper.js";
import {
  deleteBook,
  getBook,
  getConvertedBook,
  insertBook,
  listBooks,
  resetConvert,
} from "./library.model.js";
import type { BookRow, NewBookRow } from "./library.types.js";

/**
 * Library rules (D24–D26, D34). The API owns storage: originals at
 * `library/<id>.<ext>`, cover thumbnails at `images/thumbnails/<id>.jpg` (D25),
 * metadata rows in SQLite. Where a file *is* is never stored — it is derived
 * from the row by `paths.ts` (D39).
 *
 * The controller owns HTTP: ranges, ETags, status codes, streaming. This owns
 * what happens to bytes and rows.
 */

export type UploadResult =
  | { ok: true; book: LibraryBook }
  | { ok: false; reason: "TOO_LARGE" };

export type SetCoverResult =
  | { ok: true }
  | { ok: false; reason: "NOT_AN_IMAGE" };

// --- Upload ------------------------------------------------------------------

/**
 * Store an uploaded file and insert its row.
 *
 * The stream goes to disk **before** anything looks at it: a 50MB book cannot
 * be held in memory to be inspected first, so the file is written, then sized,
 * then read back for extraction. An over-cap upload is unlinked before it can
 * become a row — a row whose file was deleted would be a card that 404s.
 */
export async function uploadBook(
  file: Readable & { truncated: boolean },
  filename: string,
  format: FileType,
  log: FastifyBaseLogger,
): Promise<UploadResult> {
  const id = randomUUID();
  const filePath = filePathFor(id, format);
  await mkdir(LIBRARY_FILES_DIR, { recursive: true });

  await pipeline(file, createWriteStream(filePath));
  if (file.truncated) {
    await rm(filePath, { force: true });
    return { ok: false, reason: "TOO_LARGE" };
  }
  const { size } = await stat(filePath);
  if (!isFileSizeValid(size, MAX_UPLOAD_BYTES)) {
    await rm(filePath, { force: true });
    return { ok: false, reason: "TOO_LARGE" };
  }

  // Extract metadata + cover from the file we just wrote (best-effort — a book
  // with no cover is still a book).
  let meta;
  try {
    const bytes = await readFile(filePath);
    meta = await extractMeta(bytes, format, filename);
    if (meta.cover) {
      await mkdir(THUMBNAILS_DIR, { recursive: true });
      // Written to the derived location and not recorded anywhere: whether a
      // book has a cover is answered by stat'ing this same path on read.
      await writeFile(coverPathFor(id), meta.cover);
    }
  } catch (err) {
    log.warn({ err }, "cover/metadata extraction failed");
    meta = {
      title: filename,
      author: null,
      series: null,
      seriesIndex: null,
      subjects: [],
      cover: null,
      durationSeconds: null,
    };
  }

  const row: NewBookRow = {
    id,
    title: meta.title,
    author: meta.author,
    format,
    size_bytes: size,
    progress: 0,
    created_at: new Date().toISOString(),
    last_opened_at: null,
    series: meta.series,
    series_index: meta.seriesIndex,
    // Stored as a JSON array; never null on insert so it isn't mistaken for a
    // pre-column row by the metadata backfill.
    subjects: JSON.stringify(meta.subjects),
    // Uploads are the default provenance (brief 22); imports set 'gutenberg'.
    source: "upload",
    source_id: null,
    // Media kind is derived from the format; duration comes from extraction
    // (null for books and unknown-duration media) — brief 23.
    kind: kindForFormat(format),
    duration_seconds: meta.durationSeconds,
  };
  await insertBook(row);
  return { ok: true, book: toLibraryBook(row) };
}

// --- Reads -------------------------------------------------------------------

/**
 * The gallery list for one profile, with each card's reading position merged in.
 *
 * A card stands for the BOOK, not for one of its two rows. Reading happens
 * against whichever format you opened, and for a converted book that row is
 * hidden from this list — so without merging the pair here, reading the EPUB
 * twin of a PDF for a week left the card sitting at 0% and never surfaced it in
 * the Continue strip, which needs `progress > 0 && progress < 1`. The pair's
 * identity is already resolved by whichever row was read more recently (that is
 * how brief 34 step 7 picks the format to reopen), so the same comparison
 * decides which position the card shows. Costs nothing: both rows are already
 * in the map.
 */
export async function listLibraryForProfile(
  profileId: string,
  sort: LibrarySort,
): Promise<LibraryBook[]> {
  const [rows, progress] = await Promise.all([listBooks(sort), listProfileProgress(profileId)]);
  const progressByBook = new Map(progress.map((p) => [p.book_id, p]));

  return rows.map((row) => {
    const own = progressByBook.get(row.id);
    const twin = row.converted_to ? progressByBook.get(row.converted_to) : undefined;
    const newer =
      twin && (!own || (twin.updated_at ?? "") > (own.updated_at ?? "")) ? twin : own;
    return toLibraryBook(row, newer ?? { progress: 0, locator: null });
  });
}

/** One book as this profile sees it, or undefined. */
export async function getBookForProfile(
  profileId: string,
  id: string,
): Promise<LibraryBook | undefined> {
  const row = await getBook(id);
  if (!row) return undefined;
  const progress = await getProfileProgress(profileId, id);
  return toLibraryBook(row, progress ?? { progress: 0, locator: null });
}

// --- Covers ------------------------------------------------------------------

/**
 * Store a client-supplied image as this item's cover, re-encoded server-side
 * (brief 42, D40).
 *
 * **Client bytes are never stored as-is.** They are decoded and re-encoded by
 * `toVideoThumbnail`, the same sharp path the extractor uses, so this is not a
 * second definition of cover geometry — and that re-encode is also the
 * sanitiser: EXIF, anything appended past the image data, and a payload that is
 * not an image at all do not survive it.
 *
 * Writes THROUGH to the COVER OWNER's thumbnail — `coverOwnerId(row)`, i.e.
 * `converted_from ?? id` — not to `row.id`. Two reasons, the first decisive:
 *
 *  1. It is the only path that is *visible*. `GET /library/:id/cover` and
 *     `hasCover` both resolve the owner, so a cover written to
 *     `coverPathFor(row.id)` for a converted row would be an orphan file
 *     nothing ever reads: the route would answer 200 and change nothing
 *     observable, which is the worst failure on offer.
 *  2. It is also the right answer. D34's model is ONE card per book with both
 *     formats sharing it, so a cover set from either side belongs to the pair.
 *     The delete paths guard this same shared file for a reason that does not
 *     apply to a setter: deleting a conversion would DESTROY a cover the source
 *     still needs, with nothing left to restore it from. Setting instead
 *     *produces* a cover the pair then shows together, and either row can set
 *     it again (last-write-wins), so a bad choice is one more POST away from
 *     being fixed.
 */
export async function setBookCover(row: BookRow, bytes: Buffer): Promise<SetCoverResult> {
  // `null` is the catch-and-null contract shared with `toThumbnail` /
  // `toSquareThumbnail`: not a decodable image. A clear refusal — never a 500,
  // and never a broken file written to the cover path where the old cover (or
  // the fallback tile) was working fine a moment ago.
  const thumbnail = await toVideoThumbnail(bytes);
  if (!thumbnail) return { ok: false, reason: "NOT_AN_IMAGE" };

  const coverPath = coverPathFor(coverOwnerId(row));
  await mkdir(THUMBNAILS_DIR, { recursive: true });
  // Temp file + rename, so replacing a cover is atomic. `GET` streams this
  // exact path, and last-write-wins must not mean a concurrent reader can be
  // served half of the new cover on top of half of the old one.
  const temp = `${coverPath}.upload-${randomUUID()}`;
  try {
    await writeFile(temp, thumbnail);
    await rename(temp, coverPath);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
  // Nothing is recorded in the DB: `hasCover` is a stat of the path we just
  // wrote (brief 41), so the write IS the state change.
  return { ok: true };
}

// --- Convert (D34, brief 34) -------------------------------------------------

/**
 * Start a conversion, optionally forcing over an existing one.
 *
 * `force` re-runs even when a conversion already exists. There is a UNIQUE
 * index on `converted_from`, so inserting a fresh conversion over an existing
 * one throws — the old row and its FILE must be gone before `startConvert`
 * runs, not cleaned up after.
 */
export async function requestConvert(row: BookRow, force: boolean) {
  if (force) {
    const existing = await getConvertedBook(row.id);
    if (existing) {
      await rm(filePathFor(existing.id, existing.format), { force: true });
      // NEVER touch the cover — a converted book's thumbnail is its SOURCE's
      // file (`coverPathFor` derives it from `converted_from`), and this row IS
      // that source, so unlinking it here would strip its own cover.
      await deleteBook(existing.id);
    }
  }
  return startConvert(row);
}

export type CancelConvertResult =
  | { ok: true; what: "cancelled" | "deleted" }
  | { ok: false; reason: "NOTHING_TO_DO" };

/**
 * Cancel a running conversion, or delete a finished one. `id` is always the
 * SOURCE book — the convert status lives there, and `cancelConvert` /
 * `isConverting` are keyed on it the same way.
 */
export async function cancelOrDeleteConversion(id: string): Promise<CancelConvertResult> {
  if (isConverting(id)) {
    await cancelConvert(id);
    return { ok: true, what: "cancelled" };
  }

  const converted = await getConvertedBook(id);
  if (!converted) return { ok: false, reason: "NOTHING_TO_DO" };

  await rm(filePathFor(converted.id, converted.format), { force: true });
  // NEVER remove the cover — `coverPathFor(coverOwnerId(converted))` is the
  // SAME file as the source's cover (a conversion reuses it, never
  // re-extracts). Deleting it here would strip the cover off the source book,
  // which this request never touched.
  await deleteBook(converted.id);
  await resetConvert(id);
  return { ok: true, what: "deleted" };
}

// --- Delete ------------------------------------------------------------------

/**
 * Delete a book: its row, its file, its thumbnail, its published versions'
 * artifacts, and whatever its convert link leaves dangling.
 *
 * Shared with `DELETE /library/:id/versions/:versionId` in the latex module,
 * which deletes the library entry when its LAST version goes (brief 38 step 7 —
 * an entry with no versions has nothing to show). One code path rather than two
 * that can drift: every rule below was learned the hard way, and a second copy
 * would relearn them.
 */
export async function deleteBookWithArtifacts(
  row: BookRow,
  log: FastifyBaseLogger,
): Promise<void> {
  const id = row.id;

  // Brief 38 / D39: `document_versions.book_id` is ON DELETE CASCADE, so the
  // rows go on their own — and SQLite cascades ROWS, NEVER FILES. After
  // `deleteBook` there is nothing left that knows these version ids, and the
  // per-version PDFs and zips would be unreachable bytes forever. Enumerate
  // them BEFORE the row goes; the paths are derived from the version id, which
  // only this listing still has.
  const versions = await listDocumentVersions(id);

  // A converted book shares its source's cover file outright (never its own) —
  // so resolve the OTHER half of the pair before deleting anything:
  // - if `row` is a source, its converted book's ROW is `ON DELETE CASCADE`, so
  //   nothing will be left pointing at that FILE afterwards unless we grab it
  //   now.
  // - if `row` is itself a converted book, its source stays alive and must not
  //   lose its `ready`/`poor` status pointing at a conversion that's about to
  //   stop existing.
  const linkedConverted = row.converted_from === null ? await getConvertedBook(id) : undefined;

  // Kill any conversion this delete would otherwise strand. The job runner keys
  // its single-flight slot on the SOURCE row, and nothing else tells it the
  // book is gone: delete a source mid-conversion and the child keeps running,
  // the slot stays claimed, and every other conversion in the app is refused
  // with a 409 naming a book that no longer exists — with no way out, because
  // the cancel route resolves `getBook(id)` first and now 404s. The slot would
  // then stay blocked until the 24h ceiling expired or the API was restarted,
  // which is precisely the "no other recourse" decision 5 exists to prevent.
  if (row.converted_from === null && isConverting(id)) {
    await cancelConvert(id);
  }

  await deleteBook(id);
  await rm(filePathFor(row.id, row.format), { force: true });
  // Only unlink the cover when this row OWNS it. Ownership is
  // `converted_from ?? id` (`coverOwnerId`): a converted book's thumbnail is
  // its source's file, so `converted_from === null` is exactly the test for
  // "the derived path names this row" — removing it otherwise would strip the
  // cover off a source book this request never touched. `rm --force` covers the
  // book that simply never had a thumbnail.
  if (row.converted_from === null) {
    await rm(coverPathFor(row.id), { force: true });
  }

  if (linkedConverted) {
    // Its row is already gone via the cascade; only its FILE is still ours to
    // clean up. Never its cover — that derives to the SAME thumbnail as `row`'s,
    // already handled above.
    await rm(filePathFor(linkedConverted.id, linkedConverted.format), { force: true });
  } else if (row.converted_from !== null && !isConverting(row.converted_from)) {
    // `row` was the converted book: its source is still around and must not
    // keep claiming a conversion that no longer exists.
    //
    // Guarded on `isConverting` because a source can be mid-conversion while an
    // older conversion of it is deleted — resetting it to `none` here would
    // drop a live job's `running` status on the floor, leaving the button
    // offering "Convert" for a conversion already in flight. The running job
    // owns that row's status until it finishes.
    await resetConvert(row.converted_from);
  }

  for (const version of versions) {
    await rm(versionPdfPathFor(version.id), { force: true });
    await rm(versionZipPathFor(version.id), { force: true });
  }
  if (versions.length > 0) {
    log.info(
      { bookId: id, versions: versions.length },
      "deleted a published document and its versions",
    );
  }
}
