import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  detectFileType,
  isFileSizeValid,
  kindForFormat,
  librarySortSchema,
  updateProgressSchema,
  type FileType,
} from "@ebook-reader/shared";
import { LIBRARY_FILES_DIR, MAX_UPLOAD_BYTES, THUMBNAILS_DIR } from "./config.js";
import {
  deleteBook,
  getBook,
  getConvertedBook,
  getDocumentVersion,
  getProfile,
  getProfileProgress,
  insertBook,
  listBooks,
  listBooksNeedingMetadata,
  listDocumentVersions,
  listProfileProgress,
  resetConvert,
  toLibraryBook,
  touchOpened,
  updateBookMetadata,
  upsertProfileProgress,
  type BookRow,
} from "./db.js";
import { cancelConvert, isConverting, startConvert } from "./convert-jobs.js";
import {
  coverOwnerId,
  coverPathFor,
  filePathFor,
  versionPdfPathFor,
  versionZipPathFor,
} from "./paths.js";
import { extractMeta, toVideoThumbnail } from "./extract.js";

/**
 * Library CRUD routes (decisions.md D24). The API owns storage: originals at
 * `library/<id>.<ext>`, cover thumbnails at `images/thumbnails/<id>.jpg`
 * (D25), metadata rows in SQLite. The wire shape never exposes on-disk paths.
 */

const CONTENT_TYPE: Record<FileType, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** A resolved single byte-range, an unsatisfiable marker, or null (no/ignored range). */
type RangeResult = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parse a single-range `Range: bytes=` header against a known total `size`.
 *
 * Supports `bytes=start-end`, `bytes=start-` (open-ended), and `bytes=-suffix`
 * (last N bytes). Returns:
 *  - `null` when there is no Range, or it's malformed / multi-range — the caller
 *    then serves the full 200 (ignoring the header is valid per RFC 7233).
 *  - `"unsatisfiable"` when the range lies entirely outside the file → 416.
 *  - `{ start, end }` (inclusive, clamped to the file) for a 206.
 */
function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multi-range or malformed → full 200
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "" && endRaw === "") return null; // "bytes=-" → full 200

  let start: number;
  let end: number;
  if (startRaw === "") {
    // Suffix form: the last `suffix` bytes.
    const suffix = Number.parseInt(endRaw, 10);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === "" ? size - 1 : Math.min(Number.parseInt(endRaw, 10), size - 1);
  }

  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function registerLibraryRoutes(app: FastifyInstance): void {
  // --- POST /library — upload + store + extract cover ------------------------
  app.post("/library", async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: "No file field found in upload." });
    }

    const format = detectFileType(data.filename, data.mimetype);
    if (format === null) {
      return reply.status(400).send({
        error: "Unsupported file type. Accepted formats: PDF, EPUB, MP3, MP4, WebM.",
      });
    }

    const id = randomUUID();
    const filePath = filePathFor(id, format);
    await mkdir(LIBRARY_FILES_DIR, { recursive: true });

    // Stream the upload to disk (mirrors the convert route's TOO_LARGE handling).
    await pipeline(data.file, createWriteStream(filePath));
    if (data.file.truncated) {
      await rm(filePath, { force: true });
      return reply.status(413).send({ error: "File exceeds the upload size limit." });
    }
    const { size } = await stat(filePath);
    if (!isFileSizeValid(size, MAX_UPLOAD_BYTES)) {
      await rm(filePath, { force: true });
      return reply.status(413).send({ error: "File exceeds the upload size limit." });
    }

    // Extract metadata + cover from the file we just wrote (best-effort).
    let meta;
    try {
      const bytes = await readFile(filePath);
      meta = await extractMeta(bytes, format, data.filename);
      if (meta.cover) {
        await mkdir(THUMBNAILS_DIR, { recursive: true });
        // Written to the derived location and not recorded anywhere: whether a
        // book has a cover is answered by stat'ing this same path on read.
        await writeFile(coverPathFor(id), meta.cover);
      }
    } catch (err) {
      request.log.warn({ err }, "cover/metadata extraction failed");
      meta = {
        title: data.filename,
        author: null,
        series: null,
        seriesIndex: null,
        subjects: [],
        cover: null,
        durationSeconds: null,
      };
    }

    const now = nowIso();
    const row = {
      id,
      title: meta.title,
      author: meta.author,
      format,
      size_bytes: size,
      progress: 0,
      created_at: now,
      last_opened_at: null,
      series: meta.series,
      series_index: meta.seriesIndex,
      // Stored as a JSON array; never null on insert so it isn't mistaken for a
      // pre-column row by the metadata backfill (db.ts).
      subjects: JSON.stringify(meta.subjects),
      // Uploads are the default provenance (brief 22); imports set 'gutenberg'.
      source: "upload" as const,
      source_id: null,
      // Media kind is derived from the format; duration comes from extraction
      // (null for books and unknown-duration media) — brief 23.
      kind: kindForFormat(format),
      duration_seconds: meta.durationSeconds,
    };
    insertBook(row);

    return reply.status(201).send(toLibraryBook(row));
  });

  // --- GET /library — the gallery list ---------------------------------------
  app.get("/library", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = request.authProfile;
    if (!profile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const sort = librarySortSchema.catch("recent").parse(
      (request.query as { sort?: string } | undefined)?.sort,
    );
    // Progress/locator are per-profile (brief 35); fetch this profile's rows
    // once and merge.
    const progressByBook = new Map(
      listProfileProgress(profile.id).map((p) => [p.book_id, p]),
    );
    return reply.send(
      listBooks(sort).map((row) => {
        const own = progressByBook.get(row.id);
        // A card stands for the BOOK, not for one of its two rows. Reading
        // happens against whichever format you opened, and for a converted book
        // that row is hidden from this list — so without merging the pair here,
        // reading the EPUB twin of a PDF for a week left the card sitting at 0%
        // and never surfaced it in the Continue strip, which needs
        // `progress > 0 && progress < 1`. The pair's identity is already
        // resolved by whichever row was read more recently (that is how brief
        // 34 step 7 picks the format to reopen), so the same comparison decides
        // which position the card should show. Costs nothing: both rows are
        // already in `progressByBook`.
        const twin = row.converted_to ? progressByBook.get(row.converted_to) : undefined;
        const newer =
          twin && (!own || (twin.updated_at ?? "") > (own.updated_at ?? "")) ? twin : own;
        return toLibraryBook(row, newer ?? { progress: 0, locator: null });
      }),
    );
  });

  // --- GET /library/:id — one book, with both convert link directions --------
  // Unlike the list, `getById` (behind `getBook`) does NOT filter out derived
  // rows — a converted book must be individually readable so the reader can
  // offer the switch from either side of the pair (D34). `toLibraryBook`
  // resolves `convertedFrom`/`convertedTo`/`convertStatus`/`convertError` off
  // the same row (no extra query — see `BOOK_COLUMNS` in db.ts).
  app.get("/library/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = request.authProfile;
    if (!profile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    return reply.send(
      toLibraryBook(row, getProfileProgress(profile.id, id) ?? { progress: 0, locator: null }),
    );
  });

  // --- GET /library/:id/file — stream the original for the reader ------------
  //
  // `?version=<id>` (brief 38 step 7) selects one published VERSION of the book
  // instead of the current library file. Everything below — ETag, range, 304,
  // the recorded open — is the same machinery; only the identity and the path
  // change, and both change together.
  app.get("/library/:id/file", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    // Record the open (drives "recently opened" ordering) even on a cache hit.
    touchOpened(id, nowIso());

    // No `?version=` means the NEWEST, and the newest needs no lookup at all:
    // publish copies it to `filePathFor(bookId, "pdf")`, the same derived
    // location every uploaded book uses (D39). That is the whole reason this
    // route has no "is this a published document?" branch.
    const requestedVersion = (request.query as { version?: unknown } | undefined)?.version;
    let version;
    if (typeof requestedVersion === "string" && requestedVersion !== "") {
      version = getDocumentVersion(requestedVersion);
      // `getDocumentVersion` looks up by id ALONE, so the `book_id` comparison
      // is what stops one book's URL streaming another's bytes. Both an unknown
      // id and a foreign one answer 404 — never 403, which would confirm the id
      // exists somewhere (brief 35's rule).
      if (!version || version.book_id !== id) {
        return reply.status(404).send({ error: "Version not found." });
      }
    }

    // The stored bytes for an id never change — a re-upload gets a fresh id — so
    // the id doubles as a strong validator. `no-cache` makes the browser
    // revalidate on every open, but a matching If-None-Match short-circuits to a
    // 304 (no multi-MB re-download of the book) while the touch above still
    // runs. Without this the reader re-streams the whole file on every refresh.
    // `Accept-Ranges: bytes` is always advertised — media players (and Safari's
    // `bytes=0-1` probe) require it to enable seek/scrub (brief 23).
    //
    // A version's id is the same kind of validator for the same reason, and a
    // stronger one: a version artifact is IMMUTABLE by construction (publishing
    // again mints a new id rather than rewriting one). Deriving the ETag from
    // the version's own identity — the identity its path is derived from — is
    // what stops v2 being served out of a cache entry filled by v3.
    const etag = `"${version ? version.id : id}"`;
    reply
      .header("Cache-Control", "private, no-cache")
      .header("ETag", etag)
      .header("Accept-Ranges", "bytes");
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }

    // A version is always a PDF — publishing produces nothing else.
    const contentType = version ? CONTENT_TYPE.pdf : CONTENT_TYPE[row.format];
    const disposition = `inline; filename="${version ? `${version.id}.pdf` : `${id}.${row.format}`}"`;

    // Total size from disk — needed for Content-Range and to clamp the range.
    // We never read the whole file into memory: `createReadStream({start,end})`
    // streams only the requested window.
    // Derived, never read back from the row — see `paths.ts` for why the two
    // can only ever have agreed.
    const filePath = version ? versionPdfPathFor(version.id) : filePathFor(row.id, row.format);
    let size: number;
    try {
      ({ size } = await stat(filePath));
    } catch {
      return reply
        .status(404)
        .send({ error: version ? "Version file not found." : "Book file not found." });
    }

    const range = parseRange(request.headers.range, size);
    if (range === "unsatisfiable") {
      return reply
        .status(416)
        .header("Content-Range", `bytes */${size}`)
        .send({ error: "Requested range not satisfiable." });
    }

    if (range) {
      const { start, end } = range;
      reply
        .status(206)
        .header("Content-Type", contentType)
        .header("Content-Disposition", disposition)
        .header("Content-Range", `bytes ${start}-${end}/${size}`)
        .header("Content-Length", String(end - start + 1));
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", disposition)
      .header("Content-Length", String(size));
    return reply.send(createReadStream(filePath));
  });

  // --- GET /library/:id/cover — stream the thumbnail -------------------------
  app.get("/library/:id/cover", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) {
      return reply.status(404).send({ error: "No cover for this book." });
    }
    // The thumbnail belongs to the cover OWNER — for a converted book that is
    // its source, which is the row the file was extracted from and named after
    // (`coverPathFor`). Asking for the conversion's cover therefore serves the
    // source's file, which is the same file the source itself serves.
    const coverPath = coverPathFor(coverOwnerId(row));
    // Whether a book HAS a cover is "is that file on disk" and nothing else
    // (`toLibraryBook`'s `hasCover` asks the same question), so the existence
    // check is the only gate here. Doing it up front makes a missing thumbnail
    // a clean 404 the <img> can fall back from, rather than a mid-stream 500
    // (which a cross-origin <img> surfaces as the noisy ERR_BLOCKED_BY_ORB).
    try {
      await stat(coverPath);
    } catch {
      return reply.status(404).send({ error: "No cover for this book." });
    }
    reply.header("Content-Type", "image/jpeg").header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(coverPath));
  });

  // --- POST /library/:id/cover — set the thumbnail from a client-sent image --
  /**
   * Store a client-supplied image as this item's cover, re-encoded server-side
   * (brief 42, D40).
   *
   * It exists because video is the one kind with no server-side cover path:
   * the frame is decoded in the **browser** — the only video decoder we have,
   * since the ffmpeg binary stays declined (brief 23, upheld by D40) — and
   * posted here. Nothing about the route is video-specific, though. D40
   * decision 2 makes it a **dumb generic setter, last-write-wins**, so a future
   * "pick a different frame" affordance needs no replace flag: only-if-absent
   * with a 409 was rejected there because it would block a legitimate replace
   * in order to defend against a client bug.
   *
   * **Client bytes are never stored as-is.** They are decoded and re-encoded by
   * `toVideoThumbnail`, the same sharp path the extractor uses, so the route is
   * not a second definition of cover geometry — and that re-encode is also the
   * sanitiser: EXIF, anything appended past the image data, and a payload that
   * is not an image at all do not survive it. The bytes are held in memory and
   * never hit the disk in their original form (unlike the upload route above,
   * which must stream a 50MB book to a file before it can look at it).
   *
   * No ownership check, and that is a decision rather than an omission (D40
   * decision 3, recorded so it is not re-asked): `books` has no `user_id`, the
   * library is install-wide, and only `reading_progress`/`notes` are
   * profile-scoped (D35 — the account is the security boundary, the profile is
   * not). Setting a cover is strictly *less* privileged than the delete route,
   * which is already unscoped. The app-wide auth guard has already required a
   * live session by the time this handler runs, so there is nothing to add.
   */
  app.post("/library/:id/cover", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    // 404 on an unknown id, same as every other `/library/:id/*` route.
    if (!row) return reply.status(404).send({ error: "Book not found." });

    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "Send the image as a multipart upload." });
    }
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: "No file field found in upload." });
    }

    // The part's declared content type is NOT checked, deliberately: it is a
    // client-supplied label, so it can lie in both directions — a real JPEG
    // posted as `application/octet-stream` would be refused for nothing, and a
    // mislabelled non-image would sail through anyway. The decode below is the
    // only statement about these bytes that is actually derived from the bytes.
    let bytes: Buffer;
    try {
      bytes = await data.toBuffer();
    } catch (err) {
      // `@fastify/multipart` is registered app-wide with
      // `limits.fileSize: MAX_UPLOAD_BYTES` and its default
      // `throwFileSizeLimit`, so an oversized part makes `toBuffer()` throw
      // instead of quietly handing back truncated bytes. That is the mirror
      // image of the upload route above, which streams to disk and inspects
      // `file.truncated` itself; same ceiling, and here too nothing is written.
      if (data.file.truncated) {
        return reply.status(413).send({ error: "Image exceeds the upload size limit." });
      }
      throw err;
    }

    // `null` is the catch-and-null contract shared with `toThumbnail` /
    // `toSquareThumbnail`: not a decodable image. A clear 400 — never a 500,
    // and never a broken file written to the cover path where the old cover (or
    // the fallback tile) was working fine a moment ago.
    const thumbnail = await toVideoThumbnail(bytes);
    if (!thumbnail) {
      return reply
        .status(400)
        .send({ error: "That payload is not a decodable image." });
    }

    // Write THROUGH to the COVER OWNER's thumbnail — `coverOwnerId(row)`, i.e.
    // `converted_from ?? id` — not to `row.id`. Two reasons, the first
    // decisive:
    //
    //  1. It is the only path that is *visible*. `GET /library/:id/cover` and
    //     `hasCover` (db.ts) both resolve the owner, so a cover written to
    //     `coverPathFor(row.id)` for a converted row would be an orphan file
    //     nothing ever reads: the route would answer 200 and change nothing
    //     observable, which is the worst failure on offer.
    //  2. It is also the right answer. D34's model is ONE card per book with
    //     both formats sharing it, so a cover set from either side belongs to
    //     the pair. The delete paths below guard this same shared file for a
    //     reason that does not apply to a setter: deleting a conversion would
    //     DESTROY a cover the source still needs, with nothing left to restore
    //     it from. Setting instead *produces* a cover the pair then shows
    //     together, and either row can set it again (last-write-wins), so a bad
    //     choice is one more POST away from being fixed.
    //
    // Moot for brief 42's actual use — videos are never converted — but a
    // "set cover" on a converted PDF/EPUB pair would land here, so it is
    // decided in the open rather than left to be discovered.
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
    // wrote (brief 41), so the write IS the state change. The body answers the
    // only question a client has afterwards.
    return reply.status(200).send({ id: row.id, hasCover: true });
  });

  // --- PATCH /library/:id/progress — save the target profile's progress + position ----
  app.patch("/library/:id/progress", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    const activeProfile = request.authProfile;
    if (!user || !activeProfile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    const parsed = updateProgressSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "progress must be a number in [0, 1]." });
    }

    // `profileId` is the offline-flush override (brief 35 step 7, D35): a
    // record queued while one profile was reading must PATCH as THAT profile
    // even if the session has since switched to another, or the flush would
    // silently re-attribute person A's reading to person B. Honouring a
    // client-supplied profile id here is safe under D35 — the account is the
    // security boundary, the profile is not, so writing as another profile
    // *on the same account* is exactly as privileged as switching to it and
    // writing normally. What is NOT safe is skipping the ownership check: an
    // unverified id would let one account write into another's profile, which
    // is a cross-*account* write. A foreign or unknown id 404s (never 403),
    // matching the rule in profile-routes.ts — a 403 would confirm the id
    // exists on someone else's account.
    let targetProfileId = activeProfile.id;
    if (parsed.data.profileId !== undefined) {
      const target = getProfile(parsed.data.profileId);
      if (!target || target.user_id !== user.id) {
        return reply.status(404).send({ error: "NOT_FOUND" });
      }
      targetProfileId = target.id;
    }

    // Brief 38 decision 10: a `locator` inside a published document is only
    // meaningful together with the version it was measured in — page 40 of v3
    // is not page 40 of v4. `upsertProfileProgress` COALESCEs both columns, so
    // a write carrying a locator for a version MUST carry that version's id
    // too; otherwise the row would keep an older version's id beside a newer
    // version's page and resume in the wrong place, which is worse than
    // resuming at 0. An ordinary uploaded book has no versions and sends
    // nothing, leaving the column NULL.
    //
    // A foreign or unknown version id is a 404, never a 403 — the same rule the
    // profile check above states, for the same reason. Without the `book_id`
    // comparison a client could point this book's progress row at another
    // book's version, which the FK would happily accept.
    let versionId: string | null = null;
    if (parsed.data.versionId) {
      const version = getDocumentVersion(parsed.data.versionId);
      if (!version || version.book_id !== id) {
        return reply.status(404).send({ error: "Version not found." });
      }
      versionId = version.id;
    }

    upsertProfileProgress(
      targetProfileId,
      id,
      parsed.data.progress,
      parsed.data.locator ?? null,
      nowIso(),
      versionId,
    );
    return reply.send(toLibraryBook(row, getProfileProgress(targetProfileId, id)));
  });

  // --- POST /library/:id/convert — start a conversion (D34, brief 34) --------
  // `startConvert` makes its whole decision synchronously (single-flight check
  // + claiming the job happen with nothing awaited in between) — nothing here
  // may be inserted between the 404 check and the call that introduces an
  // `await` before it, or two concurrent requests could both pass the guard.
  app.post("/library/:id/convert", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    const query = request.query as { force?: string } | undefined;
    if (query?.force === "1") {
      // `?force=1` re-runs even when a conversion already exists. There is a
      // UNIQUE index on `converted_from` (db.ts), so inserting a fresh
      // conversion over an existing one throws — the old row and its FILE must
      // be gone before `startConvert` runs, not cleaned up after.
      const existing = getConvertedBook(id);
      if (existing) {
        await rm(filePathFor(existing.id, existing.format), { force: true });
        // NEVER touch the cover — a converted book's thumbnail is its SOURCE's
        // file (`coverPathFor` derives it from `converted_from`), and this row
        // IS that source, so unlinking it here would strip its own cover.
        deleteBook(existing.id);
      }
    }

    const result = startConvert(row);
    switch (result.kind) {
      case "started":
        return reply
          .status(202)
          .send({ convertedBookId: result.convertedBookId, targetFormat: result.targetFormat });
      case "busy":
        return reply.status(409).send({ error: result.message });
      case "unsupported":
        return reply.status(400).send({ error: result.message });
      case "derived":
        return reply.status(400).send({ error: result.message });
      case "exists":
        return reply.status(200).send(toLibraryBook(result.converted));
    }
  });

  // --- DELETE /library/:id/convert — cancel a running job, or delete a -------
  // finished conversion (D34, brief 34). `:id` is always the SOURCE book — the
  // convert status lives there, and `cancelConvert`/`isConverting` are keyed on
  // it the same way.
  app.delete("/library/:id/convert", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    if (isConverting(id)) {
      // Resets the source to `none` synchronously before the child actually
      // dies, so it's safe to answer immediately (convert-jobs.ts).
      cancelConvert(id);
      return reply.status(204).send();
    }

    const converted = getConvertedBook(id);
    if (!converted) {
      return reply.status(404).send({ error: "No conversion to cancel or delete." });
    }

    await rm(filePathFor(converted.id, converted.format), { force: true });
    // NEVER remove the cover — `coverPathFor(coverOwnerId(converted))` is the
    // SAME file as the source's cover (a conversion reuses it, never
    // re-extracts). Deleting it here would strip the cover off the source
    // book, which this request never touched.
    deleteBook(converted.id);
    resetConvert(id);
    return reply.status(204).send();
  });

  // --- DELETE /library/:id — remove row + file + thumbnail + versions --------
  app.delete("/library/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });
    await deleteBookWithArtifacts(row, request.log);
    return reply.status(204).send();
  });
}

/**
 * Delete a book: its row, its file, its thumbnail, its published versions'
 * artifacts, and whatever its convert link leaves dangling.
 *
 * Exported and shared with `DELETE /library/:id/versions/:versionId` in
 * `latex-routes.ts`, which deletes the library entry when its LAST version goes
 * (brief 38 step 7 — an entry with no versions has nothing to show). One code
 * path rather than two that can drift: every rule below is one that was learned
 * the hard way, and a second copy would relearn them.
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
  const versions = listDocumentVersions(id);

  // A converted book shares its source's cover file outright (never its
  // own) — so resolve the OTHER half of the pair before deleting anything:
  // - if `row` is a source, its converted book's ROW is `ON DELETE CASCADE`
  //   (db.ts), so nothing will be left pointing at that FILE afterwards
  //   unless we grab it now.
  // - if `row` is itself a converted book, its source stays alive and must
  //   not lose its `ready`/`poor` status pointing at a conversion that's
  //   about to stop existing.
  const linkedConverted = row.converted_from === null ? getConvertedBook(id) : undefined;

  // Kill any conversion this delete would otherwise strand. The job runner
  // keys its single-flight slot on the SOURCE row, and nothing else tells it
  // the book is gone: delete a source mid-conversion and the child keeps
  // running, the slot stays claimed, and every other conversion in the app is
  // refused with a 409 naming a book that no longer exists — with no way out,
  // because the cancel route resolves `getBook(id)` first and now 404s. The
  // slot would then stay blocked until the 24h ceiling expired or the API was
  // restarted, which is precisely the "no other recourse" decision 5 exists to
  // prevent. Cancelling first is the whole fix.
  if (row.converted_from === null && isConverting(id)) {
    cancelConvert(id);
  }

  deleteBook(id);
  await rm(filePathFor(row.id, row.format), { force: true });
  // Only unlink the cover when this row OWNS it. Ownership is
  // `converted_from ?? id` (`coverOwnerId`): a converted book's thumbnail is
  // its source's file, so `converted_from === null` is exactly the test for
  // "the derived path names this row" — removing it otherwise would strip the
  // cover off a source book this request never touched. `rm --force` covers
  // the book that simply never had a thumbnail.
  if (row.converted_from === null) {
    await rm(coverPathFor(row.id), { force: true });
  }

  if (linkedConverted) {
    // Its row is already gone via the cascade; only its FILE is still ours
    // to clean up. Never its cover — that derives to the SAME thumbnail as
    // `row`'s, already handled above.
    await rm(filePathFor(linkedConverted.id, linkedConverted.format), { force: true });
  } else if (row.converted_from !== null && !isConverting(row.converted_from)) {
    // `row` was the converted book: its source is still around and must not
    // keep claiming a conversion that no longer exists.
    //
    // Guarded on `isConverting` because a source can be mid-conversion while
    // an older conversion of it is deleted — resetting it to `none` here
    // would drop a live job's `running` status on the floor, leaving the
    // button offering "Convert" for a conversion already in flight. The
    // running job owns that row's status until it finishes.
    resetConvert(row.converted_from);
  }

  for (const version of versions) {
    await rm(versionPdfPathFor(version.id), { force: true });
    await rm(versionZipPathFor(version.id), { force: true });
  }
  if (versions.length > 0) {
    log.info({ bookId: id, versions: versions.length }, "deleted a published document and its versions");
  }
}

/**
 * One-time metadata backfill (brief 21). Rows added before the series/subjects
 * columns existed have `subjects IS NULL`; re-run extraction against each stored
 * file and persist the new fields. Best-effort and idempotent:
 *
 * - A book whose file is missing/unreadable still gets `subjects=[]` (via
 *   `updateBookMetadata`) so it drops out of the "needs metadata" set and the
 *   backfill can't loop forever.
 * - Runs off the request path (fired from server startup, not awaited by any
 *   handler); a single row's failure never aborts the rest.
 */
export async function backfillLibraryMetadata(log: FastifyBaseLogger): Promise<void> {
  const pending = listBooksNeedingMetadata();
  if (pending.length === 0) return;
  log.info({ count: pending.length }, "library metadata backfill: starting");

  let updated = 0;
  for (const row of pending) {
    try {
      const filePath = filePathFor(row.id, row.format);
      const bytes = await readFile(filePath);
      const meta = await extractMeta(bytes, row.format, filePath);
      updateBookMetadata(row.id, {
        series: meta.series,
        seriesIndex: meta.seriesIndex,
        subjects: meta.subjects,
        author: meta.author,
      });
      updated += 1;
    } catch (err) {
      // File gone or unreadable — write empty metadata so the sentinel clears
      // and this row isn't re-scanned on every startup.
      log.warn({ err, id: row.id }, "library metadata backfill: file unreadable, storing empty");
      updateBookMetadata(row.id, {
        series: null,
        seriesIndex: null,
        subjects: [],
        author: null,
      });
    }
  }
  log.info({ updated, total: pending.length }, "library metadata backfill: done");
}
