import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  documentVersionSchema,
  kindForFormat,
  latexCompileResultSchema,
  latexFileSchema,
  latexProjectSchema,
} from "@ebook-reader/shared";
import { DOCUMENT_VERSIONS_DIR } from "../../common/config.js";
import {
  coverPathFor,
  filePathFor,
  projectDirFor,
  versionPdfPathFor,
  versionZipPathFor,
} from "../../common/paths.js";
import { toLibraryBook } from "../library/library.mapper.js";
import { deleteBook, getBook, insertBook } from "../library/library.model.js";
import { deleteBookWithArtifacts } from "../library/library.service.js";
import { getProfileProgress } from "../profiles/profiles.model.js";
import {
  cancelAndSettleLatexCompile,
  draftPdfPathFor,
  isBuildArtifactPath,
  readLatexCompileResult,
  runningLatexCompileInProcess,
  startLatexCompile,
} from "./latex-compile.service.js";
import {
  appendDocumentVersion,
  countDocumentVersions,
  deleteDocumentVersion,
  deleteLatexProject,
  getDocumentVersion,
  getLatestDocumentVersion,
  getLatexProject,
  getRunningLatexCompile,
  insertLatexProject,
  listDocumentVersions,
  listLatexProjects,
  setLatexPublishedBook,
  touchLatexProject,
  updateLatexProject,
  type DocumentVersionRow,
  type LatexProjectRow,
} from "./latex.model.js";
import {
  HELLO_WORLD_TEX,
  MAX_PROJECT_BYTES,
  accountedFilesOr409,
  bodyToContent,
  confinedOr400,
  contentTypeFor,
  createProjectSchema,
  latexFileListSchema,
  latexProjectListSchema,
  listProjectFiles,
  pid,
  pruneEmptyDirs,
  refuseUnaccountablePath,
  renameSchema,
  requireProject,
  sendFile,
  toDocumentVersion,
  toLatexProject,
  totalBytes,
  uid,
  updateProjectSchema,
  versionToWire,
  writeLibraryArtifacts,
  zipProjectTree,
} from "./latex.service.js";
import { removeProjectTree } from "./project-tree.service.js";

/**
 * HTTP for `/latex` (brief 38) — project CRUD, file CRUD, binary upload,
 * compile, the PDF/log artifacts, and publishing.
 *
 * The two rules the whole feature rests on are stated in `latex.service.ts` and
 * enforced by the two helpers imported from it: **`requireProject`** (rule 1 —
 * every route resolves the project profile-scoped, so a foreign id is 404 and
 * never 403) and **`confinedOr400`** (rule 2 — every client-supplied path is
 * confined to the project directory before anything touches the disk). Nothing
 * below derives a path from a URL parameter that has not been through both.
 */

export function registerLatexRoutes(app: FastifyInstance): void {
  /** The wildcard segment of a `files/*` route — already decoded by Fastify, exactly once. */
  const wildcard = (request: FastifyRequest): string =>
    (request.params as Record<string, string>)["*"] ?? "";

  // --- Projects --------------------------------------------------------------

  /** `GET /latex` — this profile's projects, most-recently-updated first. */
  app.get("/latex", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(latexProjectListSchema.parse((await listLatexProjects(pid(request))).map(toLatexProject)));
  });

  /**
   * `POST /latex` — create a project, seeded with a hello-world.
   *
   * The tree and the seed file are written **before** the row is inserted, so a
   * failure to create the directory never leaves a project the editor lists but
   * cannot open. The reverse ordering would need a compensating delete.
   */
  app.post("/latex", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createProjectSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    const id = randomUUID();
    // The entrypoint is a path, so it is confined like every other path even
    // though nothing has been written yet — this is the create half of "the
    // `entrypoint` field on PATCH and on create".
    let entrypoint = "main.tex";
    if (parsed.data.entrypoint !== undefined) {
      const confined = await confinedOr400(reply, id, parsed.data.entrypoint, "entrypoint");
      if (!confined) return reply;
      entrypoint = confined.relativePath;
    }

    const seedPath = join(projectDirFor(id), entrypoint);
    await mkdir(dirname(seedPath), { recursive: true });
    await writeFile(seedPath, HELLO_WORLD_TEX, "utf8");

    const now = new Date().toISOString();
    const row: LatexProjectRow = {
      id,
      profile_id: pid(request),
      title: parsed.data.title?.trim() || "Untitled project",
      entrypoint,
      compile_status: "none",
      published_book_id: null,
      created_at: now,
      updated_at: now,
    };
    await insertLatexProject(row);
    return reply.status(201).send(latexProjectSchema.parse(toLatexProject(row)));
  });

  /** `GET /latex/:id` — one project. */
  app.get("/latex/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    return reply.send(latexProjectSchema.parse(toLatexProject(project)));
  });

  /** `PATCH /latex/:id` — rename, and/or repoint the entrypoint. */
  app.patch("/latex/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    // The confinement that `updateLatexProject` explicitly does not do: it
    // stores a string and cannot tell a filename from a traversal. A stored
    // `../../etc/passwd` would be handed to the compiler as the document root.
    let entrypoint: string | undefined;
    if (parsed.data.entrypoint !== undefined) {
      const confined = await confinedOr400(reply, project.id, parsed.data.entrypoint, "entrypoint");
      if (!confined) return reply;
      entrypoint = confined.relativePath;
    }

    const now = new Date().toISOString();
    const ok = await updateLatexProject(
      pid(request),
      project.id,
      { title: parsed.data.title?.trim(), entrypoint },
      now,
    );
    if (!ok) return reply.status(404).send({ error: "NOT_FOUND" });
    // Re-read rather than reconstruct: COALESCE decided which columns changed.
    return reply.send(
      latexProjectSchema.parse(toLatexProject((await getLatexProject(pid(request), project.id))!)),
    );
  });

  /**
   * `DELETE /latex/:id` — remove the row and the whole working tree.
   *
   * ## `cancelLatexCompile` runs FIRST, and that ordering is the point
   *
   * Brief 34 shipped a Critical of exactly this shape and brief 38 inherits it.
   * The single-flight guard has two halves: the durable one is
   * `compile_status = 'running'` on this row, the in-process one is the job map
   * in `latex-compile.ts`. Deleting the row makes the **durable** half vanish
   * silently while the **in-process** half keeps holding the slot — and the
   * slot is scoped to the *account*, so every other project on every profile of
   * that account is then refused with a 409 naming a project that no longer
   * exists, with no way out until the process restarts. There is no cancel
   * route to rescue it either: cancelling resolves the project first, and the
   * project is gone.
   *
   * Cancelling before the delete is the whole fix. It is a no-op when nothing
   * is running, so it costs nothing in the ordinary case.
   *
   * ## …and it WAITS for the cancelled job, which is the second half
   *
   * `cancelAndSettleLatexCompile`, not `cancelLatexCompile`: a cancel only sets
   * a flag, and the job still unwinds through `persistOutcome`, which
   * **recreates** `latex/<id>/.atrium-build/` with a log and diagnostics in it.
   * A delete that merely cancelled would routinely lose that race — the job is
   * typically still queued in `setImmediate` when the delete runs, so the tree
   * is removed, `existsSync` is already false, the retry loop exits on its first
   * pass, and only then does the job write the directory back. The row is gone
   * by then, so nothing will ever remove those bytes again. Awaiting the job is
   * what makes the `rm` below the last writer; see that function for why the
   * wait is bounded.
   *
   * The tree goes after the row: the row is what makes the project reachable,
   * so removing it first means no request can arrive for a half-deleted
   * project. A `rm` that fails leaves orphaned bytes, which is recoverable; the
   * opposite ordering leaves a project that 500s on every read.
   */
  app.delete("/latex/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;

    await cancelAndSettleLatexCompile(project.id);

    if (!await deleteLatexProject(pid(request), project.id)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    // `projectDirFor` asserts the id's shape; it came from the row, so it is a
    // server-minted UUID and this cannot be pointed anywhere else.
    await removeProjectTree(projectDirFor(project.id), request.log);
    return reply.status(204).send();
  });

  // --- Files -----------------------------------------------------------------

  /** `GET /latex/:id/files` — the editor's file tree. Build artifacts excluded. */
  app.get("/latex/:id/files", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    return reply.send(latexFileListSchema.parse(await listProjectFiles(project.id)));
  });

  /** `GET /latex/:id/files/*` — one file's contents. */
  app.get("/latex/:id/files/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    // A build-artifact path is refused as "not found" on a read rather than as
    // a bad path: from the project's point of view it is not a file that
    // exists, which is the same thing the listing says.
    const raw = wildcard(request);
    const confined = await confinedOr400(reply, project.id, raw, "path", false);
    if (!confined) return reply;
    if (isBuildArtifactPath(confined.relativePath)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }

    let info;
    try {
      info = await stat(confined.absolutePath);
    } catch {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    if (!info.isFile()) return reply.status(404).send({ error: "NOT_FOUND" });

    return sendFile(request, reply, confined.absolutePath, info, contentTypeFor(confined.relativePath));
  });

  /**
   * `PUT /latex/:id/files/*` — write a text file, creating or overwriting.
   *
   * `bodyLimit` is raised to the project cap so the route's own ceiling is the
   * one that matters; Fastify's 1 MB default would otherwise refuse a large
   * `.tex` before the cap below ever got a say.
   */
  app.put(
    "/latex/:id/files/*",
    { bodyLimit: MAX_PROJECT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const project = await requireProject(request, reply);
      if (!project) return reply;
      const confined = await confinedOr400(reply, project.id, wildcard(request), "path");
      if (!confined) return reply;
      if (refuseUnaccountablePath(reply, confined.relativePath, "path")) return reply;

      const content = bodyToContent(request.body);
      if (content === null) {
        return reply.status(400).send({
          error: "INVALID_REQUEST",
          message:
            "Send the file contents as a text/plain body, or as JSON `{ \"content\": \"...\" }`.",
        });
      }

      const incoming = Buffer.byteLength(content, "utf8");
      // A truncated walk cannot support a cap decision — see
      // `accountedFilesOr409`. Refusing here is what stops a project that has
      // already grown past the walk's ceilings from accepting unaccounted bytes
      // forever after.
      const files = await accountedFilesOr409(reply, project.id);
      if (!files) return reply;
      // The cap is on the project, not on the write: replacing a 2 MB file with
      // another 2 MB file must succeed at 99% full, so the file being
      // overwritten is discounted from the current total.
      const existing = files.find((f) => f.path === confined.relativePath);
      const projected = totalBytes(files) - (existing?.sizeBytes ?? 0) + incoming;
      if (projected > MAX_PROJECT_BYTES) {
        return reply.status(413).send({
          error: "PROJECT_TOO_LARGE",
          limitBytes: MAX_PROJECT_BYTES,
          message: "This project has reached its size limit. Delete something first.",
        });
      }

      await mkdir(dirname(confined.absolutePath), { recursive: true });
      await writeFile(confined.absolutePath, content, "utf8");
      const now = new Date().toISOString();
      await touchLatexProject(project.id, now);

      const info = await stat(confined.absolutePath);
      return reply.status(existing ? 200 : 201).send(
        latexFileSchema.parse({
          path: confined.relativePath,
          sizeBytes: info.size,
          updatedAt: new Date(info.mtimeMs).toISOString(),
        }),
      );
    },
  );

  /**
   * `POST /latex/:id/files/*` — binary upload (figures, `.bib`) via multipart.
   *
   * The size discipline is the library's, reused rather than reinvented:
   * `@fastify/multipart` is registered app-wide with `limits.fileSize`, which
   * *truncates* past the ceiling instead of erroring, so the stream is written
   * out and `file.truncated` is inspected afterwards (`library-routes.ts` does
   * the same). On top of that sits `LATEX_MAX_PROJECT_BYTES`, which the
   * per-file limit says nothing about — a project is an unbounded number of
   * files.
   *
   * The bytes land on a temporary name in the destination directory and are
   * renamed into place only once both checks pass. An oversized upload
   * therefore never destroys the file it was replacing, and a reader (the
   * compiler, the preview) never sees a half-written figure.
   */
  app.post("/latex/:id/files/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    const confined = await confinedOr400(reply, project.id, wildcard(request), "path");
    if (!confined) return reply;
    if (refuseUnaccountablePath(reply, confined.relativePath, "path")) return reply;

    if (!request.isMultipart()) {
      return reply
        .status(400)
        .send({ error: "INVALID_REQUEST", message: "Send the file as a multipart upload." });
    }
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: "No file field found in upload." });
    }

    // Same accounting refusal as the write route above: a budget computed from
    // a tree we could not fully see is not a budget.
    const files = await accountedFilesOr409(reply, project.id);
    if (!files) return reply;
    const existing = files.find((f) => f.path === confined.relativePath);
    const budget = MAX_PROJECT_BYTES - (totalBytes(files) - (existing?.sizeBytes ?? 0));

    await mkdir(dirname(confined.absolutePath), { recursive: true });
    const temp = `${confined.absolutePath}.upload-${randomUUID()}`;
    try {
      await pipeline(data.file, createWriteStream(temp));
      const { size } = await stat(temp);
      if (data.file.truncated) {
        await rm(temp, { force: true });
        return reply.status(413).send({ error: "FILE_TOO_LARGE", message: "File exceeds the upload size limit." });
      }
      if (size > budget) {
        await rm(temp, { force: true });
        return reply.status(413).send({
          error: "PROJECT_TOO_LARGE",
          limitBytes: MAX_PROJECT_BYTES,
          message: "This file would push the project past its size limit.",
        });
      }
      await rename(temp, confined.absolutePath);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }

    const now = new Date().toISOString();
    await touchLatexProject(project.id, now);
    const info = await stat(confined.absolutePath);
    return reply.status(existing ? 200 : 201).send(
      latexFileSchema.parse({
        path: confined.relativePath,
        sizeBytes: info.size,
        updatedAt: new Date(info.mtimeMs).toISOString(),
      }),
    );
  });

  /** `DELETE /latex/:id/files/*` — remove one file. */
  app.delete("/latex/:id/files/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    const confined = await confinedOr400(reply, project.id, wildcard(request), "path", false);
    if (!confined) return reply;
    if (isBuildArtifactPath(confined.relativePath)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }

    let info;
    try {
      info = await lstat(confined.absolutePath);
    } catch {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    // A directory delete is refused rather than made recursive: the file tree
    // deletes files, and one mis-click that took a whole chapter directory with
    // it is not something a draft can be recovered from (drafts have no version
    // history — decision 3 puts that explicitly out of scope).
    if (info.isDirectory()) {
      return reply.status(400).send({
        error: "NOT_A_FILE",
        message: "That path is a directory. Delete the files inside it instead.",
      });
    }

    // Deleting the entrypoint is refused, not allowed-and-repaired. The three
    // options were: silently repoint the project at some other `.tex` (changes
    // what compiles without saying so — the exact silent behaviour this
    // codebase refuses everywhere else), allow it and leave the pointer
    // dangling (no "main" badge, and the next compile fails with a
    // missing-file diagnostic about a file the person deliberately deleted), or
    // this: say no, and say why. Renaming the entrypoint is unaffected —
    // `POST /rename` carries the pointer with the file, because there the
    // person's intent is unambiguous.
    if (confined.relativePath === project.entrypoint) {
      return reply.status(409).send({
        error: "IS_ENTRYPOINT",
        message: `${confined.relativePath} is this project's main file. Make another file the main one first, then delete it.`,
      });
    }

    await rm(confined.absolutePath, { force: true });
    await pruneEmptyDirs(project.id, confined.absolutePath);
    await touchLatexProject(project.id, new Date().toISOString());
    return reply.status(204).send();
  });

  /**
   * `POST /latex/:id/rename` — move a file within the project.
   *
   * **Both** sides are confined. `from` alone would be an arbitrary *read*
   * relocated into the project; `to` alone would be an arbitrary *write*. A
   * rename is the one operation where forgetting either half is equally fatal.
   */
  app.post("/latex/:id/rename", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    const parsed = renameSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    const from = await confinedOr400(reply, project.id, parsed.data.from, "from");
    if (!from) return reply;
    const to = await confinedOr400(reply, project.id, parsed.data.to, "to");
    if (!to) return reply;
    // The destination only. Moving a file INTO the unaccountable window is the
    // cap bypass with one extra step; moving one OUT of it must stay possible,
    // which is why `from` is not checked.
    if (refuseUnaccountablePath(reply, to.relativePath, "to")) return reply;

    if (from.relativePath === to.relativePath) {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: "`from` and `to` are the same path." });
    }

    let info;
    try {
      info = await lstat(from.absolutePath);
    } catch {
      return reply.status(404).send({ error: "NOT_FOUND", message: "No such file in this project." });
    }
    if (!info.isFile()) {
      return reply.status(400).send({ error: "NOT_A_FILE", message: "Only files can be renamed." });
    }
    // Refused rather than silently overwriting: `rename(2)` would replace the
    // destination without a word, and a draft has no undo.
    try {
      await lstat(to.absolutePath);
      return reply.status(409).send({ error: "ALREADY_EXISTS", message: "A file already exists at that path." });
    } catch {
      // Good — the destination is free.
    }

    await mkdir(dirname(to.absolutePath), { recursive: true });
    await rename(from.absolutePath, to.absolutePath);
    await pruneEmptyDirs(project.id, from.absolutePath);

    const now = new Date().toISOString();
    // Renaming the entrypoint must carry the pointer with it. Otherwise the
    // rename succeeds, the project still claims `main.tex` as its document
    // root, and the next compile fails with a missing-file error about a file
    // the person can plainly see they just renamed.
    if (project.entrypoint === from.relativePath) {
      await updateLatexProject(pid(request), project.id, { entrypoint: to.relativePath }, now);
    } else {
      await touchLatexProject(project.id, now);
    }

    const info2 = await stat(to.absolutePath);
    return reply.send(
      latexFileSchema.parse({
        path: to.relativePath,
        sizeBytes: info2.size,
        updatedAt: new Date(info2.mtimeMs).toISOString(),
      }),
    );
  });

  // --- Compile and its artifacts ---------------------------------------------

  /**
   * `POST /latex/:id/compile` — compile and answer with the result.
   *
   * Two things are load-bearing here:
   *
   * 1. **Nothing awaits between `requireProject` and `startLatexCompile`.**
   *    `startLatexCompile` makes its whole single-flight decision
   *    synchronously (check, then claim, with nothing yielded in between); an
   *    `await` inserted above it is exactly what would let two requests both
   *    see a free slot. `library-routes.ts` carries the same warning on the
   *    convert route.
   * 2. **"Busy" is a value, not an exception.** A second concurrent compile is
   *    an ordinary 409, and `message` is written for a person to read, so it
   *    goes out verbatim.
   *
   * The account id, not the profile id, is what claims the slot: switching
   * profiles is free (D35), so a per-profile limit would be no limit at all.
   */
  app.post("/latex/:id/compile", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;

    const started = await startLatexCompile(project, uid(request));
    if (started.kind === "busy") {
      return reply.status(409).send({
        error: "COMPILE_BUSY",
        message: started.message,
        runningProjectId: started.runningProject.id,
      });
    }
    // `done` is documented never to reject: every failure path inside the job
    // resolves with a `failed` result instead, so there is nothing to catch and
    // a compile error is a 200 describing a failure, not a 500.
    const result = await started.done;
    return reply.send(latexCompileResultSchema.parse(result));
  });

  /**
   * `POST /latex/:id/cancel` — stop the compile running on this project.
   *
   * Brief 38 shipped no such route deliberately: `compile()` ran on this thread,
   * so a cancel arriving mid-typeset could not even be READ, let alone honoured.
   * Brief 44 moved the engine onto a worker thread, which is what makes this
   * route possible — and this route is what makes `busyMessage`'s restored
   * "…or cancel it" reachable rather than a promise.
   *
   * ## It waits for the compile to actually stop
   *
   * `cancelAndSettleLatexCompile`, not `cancelLatexCompile`: it returns only
   * after the cancelled job has unwound through `persistOutcome`, so by the time
   * this responds `compile.log` and `diagnostics.json` describe THIS
   * cancellation and `compile_status` is off `running`. Answering earlier would
   * be actively misleading — the editor's next `GET /latex/:id/log` would read
   * the *previous* compile's result and a cancel that worked would look like a
   * cancel that did nothing. The wait is a `terminate()` plus two small artifact
   * writes, not the remainder of the compile, so the route needs no timeout of
   * its own. No `out.pdf` is ever written on this path, so the last good preview
   * survives the cancel (brief 38 step 10).
   *
   * ## Nothing running is a 200, not a 409
   *
   * `{ cancelled: false }` means **no live job was found for this project** —
   * the compile finished on its own between the render that drew the button and
   * the click on it, or, rarely, a `running` row is a leftover from a previous
   * process (`db.ts`'s `reapInterruptedLatexCompiles` flips those at import).
   * Neither is the caller's fault, neither is avoidable by any amount of care,
   * and in both the state the person asked for — nothing compiling — is the
   * state they now have. Calling that an error would put a red banner on a
   * button that did its job. The editor refetches the log on either answer.
   *
   * `{ cancelled: true }` means a live job was found and has now fully
   * unwound — **including** the case where the engine had already posted a
   * finished PDF and the cancel landed while the artifacts were being written.
   * That case used to write `out.pdf`, grade the project `ready` and still
   * answer `true`; `compileAndPersist` now re-reads `job.signal.cancelled`
   * after the engine returns and discards the output, so `true` here means the
   * same thing on every path — nothing was published from this compile, and the
   * log records the cancellation.
   *
   * ## The slot is per account; cancellation is per project
   *
   * The single-flight slot is held by the ACCOUNT (D35) while
   * `cancelAndSettleLatexCompile` is keyed by project, so "cancel my compile"
   * and "cancel this project's compile" are not the same request. A cancel
   * aimed at a project that is not the one compiling is refused with 409 and
   * told where the compile actually is, rather than silently returning
   * `cancelled: false` (which would read as "already finished" when the compile
   * is in fact still running) or cancelling a project the person never pointed
   * at. `runningProjectId` is the field `COMPILE_BUSY` already carries, so a
   * client can retry against the right project — unless that project belongs to
   * a sibling profile, where this route answers 404 by brief 35's rule and the
   * message says so instead of offering a retry that cannot work, or unless its
   * row is already gone, where the field is omitted for exactly the same reason
   * (see the `!runningRow` branch in the handler).
   */
  app.post("/latex/:id/cancel", async (request: FastifyRequest, reply: FastifyReply) => {
    // Ownership first, before `:id` reaches anything else — rule 1 at the top of
    // this file. `cancelAndSettleLatexCompile` below is keyed on `project.id`
    // from the row, never on the raw parameter.
    const project = await requireProject(request, reply);
    if (!project) return reply;

    // **Both halves of the guard, in `startLatexCompile`'s own order and for
    // its own reasons.** The durable row is asked first, because it also covers
    // a compile this process did not start. The in-process map is asked second,
    // because it catches the window the row cannot: `latex_projects.profile_id`
    // cascades on profile delete, so deleting a profile mid-compile takes the
    // project row — and its `running` flag — with it while the job carries on
    // holding the account's slot. Reading only the row there answered a flat
    // 200 `{ cancelled: false }` to somebody whose account was demonstrably
    // blocked: the compile route was refusing every one of their projects with
    // a 409 naming the vanished project, and this route said nothing was
    // running. Two routes, one guard, opposite answers.
    const userId = uid(request);
    const runningRow = await getRunningLatexCompile(userId);
    const running = runningRow ?? runningLatexCompileInProcess(userId);
    if (running && running.id !== project.id) {
      // A slot held with no row behind it. The job is real and still typesetting,
      // but its project cannot be addressed by any route any more — `POST
      // /latex/<it>/cancel` answers 404 at `requireProject`, because there is
      // nothing left to own. So this branch says the true thing and offers no
      // action, which is brief 38's rule being kept rather than an exception to
      // it: the wait is bounded by `LATEX_TIMEOUT_MS`, and sending someone to
      // cancel a project that no longer exists would send them to a 404.
      //
      // (The root cause is `DELETE /profiles/:id` not cancelling the compiles
      // on the profile it removes — a pre-existing brief-38 gap, tracked
      // separately. This route's job is only to stop mis-reporting it.)
      if (!runningRow) {
        return reply.status(409).send({
          error: "COMPILE_ELSEWHERE",
          message:
            "This project isn't compiling — a compile on a deleted project is still finishing on your account. It stops on its own; try again in a moment.",
          // Deliberately no `runningProjectId`: the field exists so a client can
          // retry against the right project, and this id addresses nothing.
        });
      }
      const sameProfile = running.profile_id === pid(request);
      return reply.status(409).send({
        error: "COMPILE_ELSEWHERE",
        message: sameProfile
          ? `This project isn't compiling — “${running.title}” is. Cancel the compile from that project.`
          : `This project isn't compiling — another profile on your account is compiling “${running.title}”.`,
        runningProjectId: running.id,
      });
    }

    const cancelled = await cancelAndSettleLatexCompile(project.id);
    return reply.send({ cancelled });
  });

  /**
   * `GET /latex/:id/pdf` — the draft PDF.
   *
   * 404 until a compile has succeeded once. After that the file survives a
   * *failed* compile deliberately (`draftPdfPathFor` explains why): the editor
   * keeps showing the last good preview beside the new errors instead of
   * blanking the pane, so this route must not start reporting "no PDF" the
   * moment a compile fails.
   */
  app.get("/latex/:id/pdf", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    const path = draftPdfPathFor(project.id);
    let info;
    try {
      info = await stat(path);
    } catch {
      return reply.status(404).send({ error: "NOT_COMPILED", message: "This project has no compiled PDF yet." });
    }
    reply.header("Content-Disposition", 'inline; filename="out.pdf"');
    return sendFile(request, reply, path, info, "application/pdf");
  });

  /** `GET /latex/:id/log` — the last compile's result, or 404 if never compiled. */
  app.get("/latex/:id/log", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;
    const result = await readLatexCompileResult(project.id);
    if (!result) {
      return reply.status(404).send({ error: "NOT_COMPILED", message: "This project has never been compiled." });
    }
    return reply.send(latexCompileResultSchema.parse(result));
  });

  // --- Publish and versions --------------------------------------------------

  /**
   * `POST /latex/:id/publish` — compile, then publish the result.
   *
   * ## It compiles first, and it refuses a failing document
   *
   * Publishing is the act of putting something in the library for people to
   * read. A document that does not compile has no PDF to put there, and
   * publishing the *previous* successful compile under a new version number
   * would be worse than refusing: the version would claim to be a snapshot of
   * sources that never produced it, and its zip — taken from the tree as it is
   * now — would not rebuild it. So a failing compile is a 422 carrying the
   * compile result, and **no `books` row and no version are created**.
   *
   * ## The claim shape is the compile route's, exactly
   *
   * **Nothing awaits between `requireProject` and `startLatexCompile`.** That
   * function makes its whole single-flight decision synchronously (check, then
   * claim, with nothing yielded in between); an `await` inserted above it is
   * precisely what would let two publishes both see a free slot. Nothing here
   * calls `setLatexCompileStatus` either — the job owns that column start to
   * finish.
   *
   * ## One card, always
   *
   * **The row is re-read after the compile, and that re-read is load-bearing.**
   * The snapshot `requireProject` captured is taken before `await started.done`
   * and before `await readFile(...)`, and it is stale across both. Two publishes
   * of one project can interleave there: A claims the compile slot, A's job
   * releases it in `runCompile`'s `finally`, A then suspends reading the PDF; a
   * retried B now passes `requireProject`, sees `published_book_id === null`
   * (A has not written it yet), passes `startLatexCompile` because the slot is
   * free, and compiles. Deciding first-publish-vs-re-publish from either
   * request's *captured* row then has both of them insert a book, and the loser
   * repoints `published_book_id` at its own — two gallery cards for one project,
   * with the first book's version, PDF, zip, library file and cover orphaned
   * behind it. Decision 8 is "pressing publish ten times gives ten versions on
   * one card, never ten cards", so this must read the column as it is NOW.
   * `setLatexPublishedBook` refuses the overwrite as a second line of defence
   * and its refusal is a retryable 409, not a 500.
   *
   * If the project already names a book, that book is REUSED and only a version
   * is appended. `setLatexPublishedBook` is called once, on the first publish.
   * The one case that re-creates is a project whose book was deleted from the
   * library: the FK is `ON DELETE SET NULL` (decision 11), so the column is
   * already NULL and this is a first publish again — which is the point of that
   * clause. The `getBook` guard below also covers a column that somehow
   * survived its book, by treating it as unpublished rather than appending a
   * version to a row that is not there.
   */
  app.post("/latex/:id/publish", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = await requireProject(request, reply);
    if (!project) return reply;

    const started = await startLatexCompile(project, uid(request));
    if (started.kind === "busy") {
      return reply.status(409).send({
        error: "COMPILE_BUSY",
        message: started.message,
        runningProjectId: started.runningProject.id,
      });
    }
    // `done` never rejects — every failure inside the job resolves as a
    // `failed` result — so there is nothing to catch here.
    const result = await started.done;
    if (result.status !== "ready") {
      return reply.status(422).send({
        error: "COMPILE_FAILED",
        message:
          "This document does not compile, so there is nothing to publish. Fix the errors in the log and publish again.",
        result: latexCompileResultSchema.parse(result),
      });
    }

    // The successful compile wrote this; read it once and use the same bytes
    // for the version artifact, the library file and the cover, so all three
    // are provably the same PDF.
    let pdfBytes: Buffer;
    try {
      pdfBytes = await readFile(draftPdfPathFor(project.id));
    } catch (err) {
      request.log.error({ err, projectId: project.id }, "publish: compile reported ready with no PDF");
      return reply.status(500).send({
        error: "NO_PDF",
        message: "The compile succeeded but its PDF could not be read. Try compiling again.",
      });
    }

    const now = new Date().toISOString();

    // Built BEFORE anything is inserted, because it is the one remaining step
    // that can decide "this project cannot be published at all". A tree the walk
    // cannot fully enumerate would produce an archive silently missing files,
    // and the archive is the whole reason a version can be rebuilt — so it is a
    // refusal, and refusing here means no book, no version and no artifact has
    // been created to roll back. It is also the LAST `await` before the
    // first-publish decision, deliberately — see below.
    const archive = await zipProjectTree(project.id);
    if (!archive.ok) {
      return reply.status(409).send({ error: "PROJECT_TREE_TRUNCATED", message: archive.message });
    }

    // The row as it is NOW, not as `requireProject` saw it before two awaits —
    // see "One card, always" above. `project` must not be consulted for
    // `published_book_id` or `title` past this point; both can have changed
    // while this request was suspended.
    //
    // **Nothing awaits between this read and `setLatexPublishedBook` below.**
    // That is the same discipline `startLatexCompile` is called under and for
    // the same reason: an `await` in between is precisely what lets two
    // publishes both read NULL and both decide they are the first. The
    // WHERE-clause guard inside `setLatexPublishedBook` is the second line of
    // defence, not the first.
    const fresh = await getLatexProject(pid(request), project.id);
    if (!fresh) {
      // Deleted (or moved to another profile) while it was compiling. The
      // compile's own artifacts are already gone with the tree; publishing a
      // project that no longer exists would create a card nothing can reach.
      return reply.status(404).send({ error: "NOT_FOUND" });
    }

    const existingBook = fresh.published_book_id ? await getBook(fresh.published_book_id) : undefined;
    const bookId = existingBook?.id ?? randomUUID();
    const createdBook = existingBook === undefined;
    if (createdBook) {
      await insertBook({
        id: bookId,
        // From the PROJECT, not from the PDF's Info dict: the project's title is
        // what the author typed and what the editor shows, and a `\title{}` the
        // engine happened to write into the metadata would silently rename the
        // card out from under them.
        title: fresh.title,
        author: null,
        format: "pdf",
        size_bytes: pdfBytes.byteLength,
        progress: 0,
        created_at: now,
        last_opened_at: null,
        series: null,
        series_index: null,
        // A JSON array rather than NULL, so the row is never mistaken for a
        // pre-column one by the metadata backfill (db.ts).
        subjects: JSON.stringify([]),
        // Authored here, not uploaded (BOOK_SOURCES gained "latex" 2026-08-27).
        // `source_id` names the draft it came from, so the entry can point back
        // at the project that produces its versions.
        source: "latex",
        source_id: project.id,
        kind: kindForFormat("pdf"),
        duration_seconds: null,
      });
      // Refused, not asserted: the column is written only while it is still
      // NULL (or already this same book), so an overlapping publish that got
      // there first cannot be overwritten. Losing that race means the book just
      // inserted is an orphan with nothing on disk yet — delete it and tell the
      // client to publish again, which will now see the winner's book and
      // append a version to it. A 500 here would leave the orphan behind.
      if (!await setLatexPublishedBook(project.id, bookId)) {
        await deleteBook(bookId);
        return reply.status(409).send({
          error: "PUBLISH_RACED",
          message: "Another publish of this project finished first. Publish again to add your version to it.",
        });
      }
    }

    // Insert FIRST: `appendDocumentVersion` generates the id and allocates
    // `version_no` as MAX+1 inside the INSERT, and that id is the whole of what
    // the row says about where its bytes went (D39). There is nothing to write
    // until it exists.
    //
    // It is INSIDE the guarded region, and that is not tidiness. On a first
    // publish `insertBook` and `setLatexPublishedBook` have already committed by
    // the time this runs, so an `appendDocumentVersion` that throws — a
    // `SQLITE_CONSTRAINT_UNIQUE` on `document_versions_book_no` from two
    // publishes seconds apart, which the statement's own comment says is the
    // expected way that race loses — would leave a `books` row with zero
    // versions, no library file and no cover. That is precisely the "gallery
    // entry with no readable version" the catch below exists to prevent, and it
    // would be unreachable from the version-delete cleanup because it has no
    // versions to delete.
    let version: DocumentVersionRow | undefined;
    try {
      version = await appendDocumentVersion(bookId, now);
      await mkdir(DOCUMENT_VERSIONS_DIR, { recursive: true });
      await writeFile(versionPdfPathFor(version.id), pdfBytes);
      await writeFile(versionZipPathFor(version.id), archive.bytes);
      await writeLibraryArtifacts(bookId, pdfBytes, fresh.title, request);
    } catch (err) {
      // Roll the row back rather than leave a version whose artifacts are
      // missing or half-written — and, on a FIRST publish, take the empty card
      // with it. A gallery entry with no readable version is exactly the state
      // "deleting the last version deletes the entry" exists to prevent.
      // `version` is undefined when the append itself failed; there is then no
      // row and no artifact to undo, only the book.
      if (version !== undefined) {
        await deleteDocumentVersion(version.id);
        await rm(versionPdfPathFor(version.id), { force: true });
        await rm(versionZipPathFor(version.id), { force: true });
      }
      if (createdBook) {
        // `published_book_id` is cleared by the FK's ON DELETE SET NULL.
        await deleteBook(bookId);
        await rm(filePathFor(bookId, "pdf"), { force: true });
        await rm(coverPathFor(bookId), { force: true });
      }
      throw err;
    }

    return reply.status(createdBook ? 201 : 200).send({
      book: toLibraryBook(
        (await getBook(bookId))!,
        (await getProfileProgress(pid(request), bookId)) ?? { progress: 0, locator: null },
      ),
      // Assigned in the try above, or the catch rethrew — the assertion is
      // about control flow, not about the data.
      version: toDocumentVersion(version!, pdfBytes.byteLength),
    });
  });

  /**
   * `GET /library/:id/versions` — the version picker's list, newest first.
   *
   * Registered here rather than in `library-routes.ts` because versions are
   * brief 38's half of the library: an ordinary upload simply has none, and
   * answers `[]`. The reader shows no picker at all below two entries.
   *
   * `currentVersionId` is this profile's stored `reading_progress.version_id` —
   * which version the saved `locator` was taken in, or null. It rides along
   * because decision 10 is a *comparison*: opening a version whose id differs
   * from this one starts at page 0, and the client cannot make that comparison
   * without knowing what is stored. One query, on a request that is already
   * profile-scoped.
   */
  app.get("/library/:id/versions", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const book = await getBook(id);
    if (!book) return reply.status(404).send({ error: "Book not found." });

    const versions = await Promise.all((await listDocumentVersions(id)).map(versionToWire));
    return reply.send({
      versions: z.array(documentVersionSchema).parse(versions),
      currentVersionId: (await getProfileProgress(pid(request), id))?.version_id ?? null,
    });
  });

  /**
   * `DELETE /library/:id/versions/:versionId` — remove one version.
   *
   * Three things have to happen in the right order, and each is a rule this
   * codebase states elsewhere:
   *
   * 1. **The row AND its files.** SQLite deletes rows, never files; after
   *    `deleteDocumentVersion` nothing is left pointing at the PDF or the zip,
   *    so both paths are derived from the id first.
   * 2. **Deleting the last version deletes the library entry too** (brief 38
   *    step 7) — an entry with no versions has nothing to show. That goes
   *    through `deleteBookWithArtifacts`, the same function `DELETE /library/:id`
   *    uses, so the card's own file, cover and convert links are cleaned up by
   *    one code path rather than two that can drift.
   * 3. **Deleting the NEWEST version must move the library file back.**
   *    `filePathFor(bookId, "pdf")` is a copy of the newest version's bytes; if
   *    the version it was copied from is gone, the card is serving a PDF no
   *    version claims. Re-copying from the new newest keeps that derivation
   *    honest with no branch in the file route.
   *
   * `:versionId` is checked against `:id` — `getDocumentVersion` looks up by id
   * alone, so without that comparison one book's URL could delete another's
   * version. A mismatch is a 404, never a 403: it must not confirm the id.
   */
  app.delete(
    "/library/:id/versions/:versionId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const book = await getBook(id);
      if (!book) return reply.status(404).send({ error: "Book not found." });
      const version = await getDocumentVersion(versionId);
      if (!version || version.book_id !== id) {
        return reply.status(404).send({ error: "Version not found." });
      }

      const wasLatest = (await getLatestDocumentVersion(id))?.id === version.id;
      await deleteDocumentVersion(version.id);
      await rm(versionPdfPathFor(version.id), { force: true });
      await rm(versionZipPathFor(version.id), { force: true });

      if (await countDocumentVersions(id) === 0) {
        await deleteBookWithArtifacts(book, request.log);
        return reply.status(204).send();
      }

      if (wasLatest) {
        const latest = (await getLatestDocumentVersion(id))!;
        try {
          await writeLibraryArtifacts(id, await readFile(versionPdfPathFor(latest.id)), book.title, request);
        } catch (err) {
          // The version rows are already correct; only the convenience copy is
          // stale. Logged rather than raised — the delete really did happen.
          request.log.warn({ err, bookId: id }, "version delete: library file could not follow the new newest version");
        }
      }
      return reply.status(204).send();
    },
  );
}
