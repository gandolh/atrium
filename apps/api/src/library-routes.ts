import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  clearBookCover,
  deleteBook,
  getBook,
  getConvertedBook,
  getProfile,
  getProfileProgress,
  insertBook,
  listBooks,
  listBooksNeedingMetadata,
  listBooksWithCover,
  listProfileProgress,
  resetConvert,
  toLibraryBook,
  touchOpened,
  updateBookMetadata,
  upsertProfileProgress,
} from "./db.js";
import { cancelConvert, isConverting, startConvert } from "./convert-jobs.js";
import { extractMeta } from "./extract.js";

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

function filePathFor(id: string, format: FileType): string {
  return join(LIBRARY_FILES_DIR, `${id}.${format}`);
}

function coverPathFor(id: string): string {
  return join(THUMBNAILS_DIR, `${id}.jpg`);
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
    let coverPath: string | null = null;
    let meta;
    try {
      const bytes = await readFile(filePath);
      meta = await extractMeta(bytes, format, data.filename);
      if (meta.cover) {
        await mkdir(THUMBNAILS_DIR, { recursive: true });
        coverPath = coverPathFor(id);
        await writeFile(coverPath, meta.cover);
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
      file_path: filePath,
      cover_path: coverPath,
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
      listBooks(sort).map((row) =>
        toLibraryBook(row, progressByBook.get(row.id) ?? { progress: 0, locator: null }),
      ),
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
  app.get("/library/:id/file", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    // Record the open (drives "recently opened" ordering) even on a cache hit.
    touchOpened(id, nowIso());

    // The stored bytes for an id never change — a re-upload gets a fresh id — so
    // the id doubles as a strong validator. `no-cache` makes the browser
    // revalidate on every open, but a matching If-None-Match short-circuits to a
    // 304 (no multi-MB re-download of the book) while the touch above still
    // runs. Without this the reader re-streams the whole file on every refresh.
    // `Accept-Ranges: bytes` is always advertised — media players (and Safari's
    // `bytes=0-1` probe) require it to enable seek/scrub (brief 23).
    const etag = `"${id}"`;
    reply
      .header("Cache-Control", "private, no-cache")
      .header("ETag", etag)
      .header("Accept-Ranges", "bytes");
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }

    const contentType = CONTENT_TYPE[row.format];
    const disposition = `inline; filename="${id}.${row.format}"`;

    // Total size from disk — needed for Content-Range and to clamp the range.
    // We never read the whole file into memory: `createReadStream({start,end})`
    // streams only the requested window.
    let size: number;
    try {
      ({ size } = await stat(row.file_path));
    } catch {
      return reply.status(404).send({ error: "Book file not found." });
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
      return reply.send(createReadStream(row.file_path, { start, end }));
    }

    reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", disposition)
      .header("Content-Length", String(size));
    return reply.send(createReadStream(row.file_path));
  });

  // --- GET /library/:id/cover — stream the thumbnail -------------------------
  app.get("/library/:id/cover", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row || !row.cover_path) {
      return reply.status(404).send({ error: "No cover for this book." });
    }
    // The thumbnail file can be absent even when the row records a path — e.g. a
    // library DB moved between machines (paths are absolute — see
    // open-questions.md), or a thumbnail deleted out of band. Verify it exists
    // first so a missing file is a clean 404 the <img> can fall back from,
    // rather than a mid-stream 500 (which a cross-origin <img> surfaces as the
    // noisy ERR_BLOCKED_BY_ORB).
    try {
      await stat(row.cover_path);
    } catch {
      return reply.status(404).send({ error: "No cover for this book." });
    }
    reply.header("Content-Type", "image/jpeg").header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(row.cover_path));
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

    upsertProfileProgress(
      targetProfileId,
      id,
      parsed.data.progress,
      parsed.data.locator ?? null,
      nowIso(),
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
        await rm(existing.file_path, { force: true });
        // NEVER touch `existing.cover_path` — a converted book shares its
        // source's thumbnail file (db.ts's `insertConvertedBook`); this row IS
        // the source, so deleting that path here would strip its own cover.
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

    await rm(converted.file_path, { force: true });
    // NEVER remove `converted.cover_path` — it is the SAME file as the
    // source's cover (copied, never re-extracted, by `insertConvertedBook`).
    // Deleting it here would strip the cover off the source book, which this
    // request never touched.
    deleteBook(converted.id);
    resetConvert(id);
    return reply.status(204).send();
  });

  // --- DELETE /library/:id — remove row + file + thumbnail -------------------
  app.delete("/library/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    // A converted book shares its source's cover file outright (never its
    // own) — so resolve the OTHER half of the pair before deleting anything:
    // - if `row` is a source, its converted book's ROW is `ON DELETE CASCADE`
    //   (db.ts), so nothing will be left pointing at that FILE afterwards
    //   unless we grab it now.
    // - if `row` is itself a converted book, its source stays alive and must
    //   not lose its `ready`/`poor` status pointing at a conversion that's
    //   about to stop existing.
    const linkedConverted = row.converted_from === null ? getConvertedBook(id) : undefined;

    deleteBook(id);
    await rm(row.file_path, { force: true });
    // Only unlink the cover when this row owns it outright. A converted book's
    // `cover_path` is the SAME file as its source's (insertConvertedBook copies
    // it, never re-extracts) — removing it here would strip the cover off a
    // source book this request never touched.
    if (row.cover_path && row.converted_from === null) {
      await rm(row.cover_path, { force: true });
    }

    if (linkedConverted) {
      // Its row is already gone via the cascade; only its FILE is still ours
      // to clean up. Never its cover_path — that's the SAME file as
      // `row.cover_path`, already handled above.
      await rm(linkedConverted.file_path, { force: true });
    } else if (row.converted_from !== null) {
      // `row` was the converted book: its source is still around and must not
      // keep claiming a conversion that no longer exists.
      resetConvert(row.converted_from);
    }

    return reply.status(204).send();
  });
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
      const bytes = await readFile(row.file_path);
      const meta = await extractMeta(bytes, row.format, row.file_path);
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

/**
 * One-time startup reconcile for stale cover paths (open-questions.md). A row
 * can record a `cover_path` whose file no longer exists — most commonly a
 * library DB carried over from another machine, where the stored paths are
 * absolute (`D:\...`) and don't resolve here. Left alone, the client sees
 * `hasCover: true`, requests the cover, and gets a 404 that a cross-origin
 * `<img>` surfaces as the noisy `ERR_BLOCKED_BY_ORB`.
 *
 * Nulling the path at startup makes `hasCover` report false, so the client
 * renders its per-kind fallback tile directly and never fires the doomed
 * request. Best-effort, fired off the request path (not awaited); a re-upload
 * that regenerates the thumbnail restores the path.
 */
export async function reconcileMissingCovers(log: FastifyBaseLogger): Promise<void> {
  const withCover = listBooksWithCover();
  if (withCover.length === 0) return;

  let cleared = 0;
  for (const row of withCover) {
    if (row.cover_path === null) continue; // narrowing; the query already filters
    try {
      await stat(row.cover_path);
    } catch {
      clearBookCover(row.id);
      cleared += 1;
      log.warn({ id: row.id, coverPath: row.cover_path }, "cover reconcile: file missing, cleared cover_path");
    }
  }
  if (cleared > 0) {
    log.info({ cleared, total: withCover.length }, "cover reconcile: done");
  }
}
