import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  detectFileType,
  librarySortSchema,
  updateProgressSchema,
  type FileType,
} from "@ebook-reader/shared";
import {
  coverOwnerId,
  coverPathFor,
  filePathFor,
  versionPdfPathFor,
} from "../../common/paths.js";
import { getDocumentVersion } from "../latex/latex.model.js";
import {
  getProfile,
  getProfileProgress,
  upsertProfileProgress,
} from "../profiles/profiles.model.js";
import { toLibraryBook } from "./library.mapper.js";
import { getBook, touchOpened } from "./library.model.js";
import {
  cancelOrDeleteConversion,
  deleteBookWithArtifacts,
  getBookForProfile,
  listLibraryForProfile,
  requestConvert,
  setBookCover,
  uploadBook,
} from "./library.service.js";

/**
 * Library HTTP (D24–D26, D34). Ranges, ETags, streaming and status codes live
 * here; what happens to bytes and rows lives in `library.service.ts`.
 *
 * The wire shape never exposes on-disk paths (D25), and no path is ever read
 * back from a row — every one is derived (D39).
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

    const result = await uploadBook(data.file, data.filename, format, request.log);
    if (!result.ok) {
      return reply.status(413).send({ error: "File exceeds the upload size limit." });
    }
    return reply.status(201).send(result.book);
  });

  // --- GET /library — the gallery list ---------------------------------------
  app.get("/library", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = request.authProfile;
    if (!profile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const sort = librarySortSchema
      .catch("recent")
      .parse((request.query as { sort?: string } | undefined)?.sort);
    return reply.send(await listLibraryForProfile(profile.id, sort));
  });

  // --- GET /library/:id — one book, with both convert link directions --------
  // Unlike the list, `getBook` does NOT filter out derived rows — a converted
  // book must be individually readable so the reader can offer the switch from
  // either side of the pair (D34). `toLibraryBook` resolves
  // `convertedFrom`/`convertedTo`/`convertStatus`/`convertError` off the same
  // row (no extra query — see `selectBooks` in `library.model.ts`).
  app.get("/library/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = request.authProfile;
    if (!profile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const { id } = request.params as { id: string };
    const book = await getBookForProfile(profile.id, id);
    if (!book) return reply.status(404).send({ error: "Book not found." });
    return reply.send(book);
  });

  // --- GET /library/:id/file — stream the original for the reader ------------
  //
  // `?version=<id>` (brief 38 step 7) selects one published VERSION of the book
  // instead of the current library file. Everything below — ETag, range, 304,
  // the recorded open — is the same machinery; only the identity and the path
  // change, and both change together.
  app.get("/library/:id/file", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    // Record the open (drives "recently opened" ordering) even on a cache hit.
    await touchOpened(id, nowIso());

    // No `?version=` means the NEWEST, and the newest needs no lookup at all:
    // publish copies it to `filePathFor(bookId, "pdf")`, the same derived
    // location every uploaded book uses (D39). That is the whole reason this
    // route has no "is this a published document?" branch.
    const requestedVersion = (request.query as { version?: unknown } | undefined)?.version;
    let version;
    if (typeof requestedVersion === "string" && requestedVersion !== "") {
      version = await getDocumentVersion(requestedVersion);
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
    // runs. `Accept-Ranges: bytes` is always advertised — media players (and
    // Safari's `bytes=0-1` probe) require it to enable seek/scrub (brief 23).
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
    // streams only the requested window. Derived, never read back from the row.
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
    const row = await getBook(id);
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
    reply
      .header("Content-Type", "image/jpeg")
      .header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(coverPath));
  });

  /**
   * Store a client-supplied image as this item's cover (brief 42, D40).
   *
   * It exists because video is the one kind with no server-side cover path: the
   * frame is decoded in the **browser** — the only video decoder we have, since
   * the ffmpeg binary stays declined (brief 23, upheld by D40) — and posted
   * here. Nothing about the route is video-specific, though. D40 decision 2
   * makes it a **dumb generic setter, last-write-wins**, so a future "pick a
   * different frame" affordance needs no replace flag: only-if-absent with a
   * 409 was rejected there because it would block a legitimate replace in order
   * to defend against a client bug.
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
    const row = await getBook(id);
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
    // mislabelled non-image would sail through anyway. The decode in the
    // service is the only statement about these bytes derived from the bytes.
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

    const result = await setBookCover(row, bytes);
    if (!result.ok) {
      return reply.status(400).send({ error: "That payload is not a decodable image." });
    }
    // The body answers the only question a client has afterwards.
    return reply.status(200).send({ id: row.id, hasCover: true });
  });

  // --- PATCH /library/:id/progress — save the target profile's position ------
  app.patch("/library/:id/progress", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser;
    const activeProfile = request.authProfile;
    if (!user || !activeProfile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const { id } = request.params as { id: string };
    const row = await getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    const parsed = updateProgressSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "progress must be a number in [0, 1]." });
    }

    // `profileId` is the offline-flush override (brief 35 step 7, D35): a record
    // queued while one profile was reading must PATCH as THAT profile even if
    // the session has since switched to another, or the flush would silently
    // re-attribute person A's reading to person B. Honouring a client-supplied
    // profile id here is safe under D35 — the account is the security boundary,
    // the profile is not, so writing as another profile *on the same account* is
    // exactly as privileged as switching to it and writing normally. What is NOT
    // safe is skipping the ownership check: an unverified id would let one
    // account write into another's profile, which is a cross-*account* write. A
    // foreign or unknown id 404s (never 403), matching the rule in the profiles
    // controller — a 403 would confirm the id exists on someone else's account.
    let targetProfileId = activeProfile.id;
    if (parsed.data.profileId !== undefined) {
      const target = await getProfile(parsed.data.profileId);
      if (!target || target.user_id !== user.id) {
        return reply.status(404).send({ error: "NOT_FOUND" });
      }
      targetProfileId = target.id;
    }

    // Brief 38 decision 10: a `locator` inside a published document is only
    // meaningful together with the version it was measured in — page 40 of v3 is
    // not page 40 of v4. `upsertProfileProgress` COALESCEs both columns, so a
    // write carrying a locator for a version MUST carry that version's id too;
    // otherwise the row would keep an older version's id beside a newer
    // version's page and resume in the wrong place, which is worse than resuming
    // at 0. An ordinary uploaded book has no versions and sends nothing, leaving
    // the column NULL.
    //
    // A foreign or unknown version id is a 404, never a 403 — the same rule the
    // profile check above states, for the same reason. Without the `book_id`
    // comparison a client could point this book's progress row at another book's
    // version, which the FK would happily accept.
    let versionId: string | null = null;
    if (parsed.data.versionId) {
      const version = await getDocumentVersion(parsed.data.versionId);
      if (!version || version.book_id !== id) {
        return reply.status(404).send({ error: "Version not found." });
      }
      versionId = version.id;
    }

    await upsertProfileProgress(
      targetProfileId,
      id,
      parsed.data.progress,
      parsed.data.locator ?? null,
      nowIso(),
      versionId,
    );
    return reply.send(toLibraryBook(row, await getProfileProgress(targetProfileId, id)));
  });

  // --- POST /library/:id/convert — start a conversion (D34, brief 34) --------
  app.post("/library/:id/convert", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    const query = request.query as { force?: string } | undefined;
    const result = await requestConvert(row, query?.force === "1");
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
  // finished conversion (D34, brief 34).
  app.delete("/library/:id/convert", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });

    const result = await cancelOrDeleteConversion(id);
    if (!result.ok) {
      return reply.status(404).send({ error: "No conversion to cancel or delete." });
    }
    return reply.status(204).send();
  });

  // --- DELETE /library/:id — remove row + file + thumbnail + versions --------
  app.delete("/library/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await getBook(id);
    if (!row) return reply.status(404).send({ error: "Book not found." });
    await deleteBookWithArtifacts(row, request.log);
    return reply.status(204).send();
  });
}
