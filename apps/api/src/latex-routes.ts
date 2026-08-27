import { randomUUID } from "node:crypto";
import { createWriteStream, createReadStream, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  documentVersionSchema,
  kindForFormat,
  latexCompileResultSchema,
  latexFileSchema,
  latexProjectSchema,
  type DocumentVersion,
  type LatexFile,
  type LatexProject,
} from "@ebook-reader/shared";
import {
  DOCUMENT_VERSIONS_DIR,
  LATEX_MAX_PROJECT_BYTES,
  LIBRARY_FILES_DIR,
  THUMBNAILS_DIR,
} from "./config.js";
import {
  appendDocumentVersion,
  countDocumentVersions,
  deleteBook,
  deleteDocumentVersion,
  deleteLatexProject,
  getBook,
  getDocumentVersion,
  getLatestDocumentVersion,
  getLatexProject,
  getProfileProgress,
  getRunningLatexCompile,
  insertBook,
  insertLatexProject,
  listDocumentVersions,
  listLatexProjects,
  setLatexPublishedBook,
  toLibraryBook,
  touchLatexProject,
  updateLatexProject,
  type DocumentVersionRow,
  type LatexProjectRow,
  updatePublishedBook,
} from "./db.js";
import { extractMeta } from "./extract.js";
import {
  cancelAndSettleLatexCompile,
  draftPdfPathFor,
  isBuildArtifactPath,
  readLatexCompileResult,
  runningLatexCompileInProcess,
  startLatexCompile,
  writeAtomic,
} from "./latex-compile.js";
import { confineProjectPath, type ConfinedPath } from "./latex-paths.js";
import { deleteBookWithArtifacts } from "./library-routes.js";
import {
  coverPathFor,
  filePathFor,
  projectDirFor,
  versionPdfPathFor,
  versionZipPathFor,
} from "./paths.js";

/**
 * The `/latex` routes (brief 38 step 5) — project CRUD, file CRUD, binary
 * upload, compile, and the PDF/log artifacts. Publishing and versions are a
 * separate chunk and deliberately absent here.
 *
 * ## The two rules this file exists to keep
 *
 * **1. Every route resolves the project through `getLatexProject(profileId, id)`
 * first.** That statement is profile-scoped *in the SQL*, so a project on
 * another profile is simply not found and the answer is **404, never 403** —
 * brief 35's rule, the same one `profile-routes.ts` states at length. A 403
 * would confirm the id exists on somebody else's account. `requireProject`
 * below is the single gate, and nothing derives a path from a URL parameter
 * before it has passed.
 *
 * **2. Every client-supplied path goes through `confineProjectPath`.** The
 * typesetting engine is a pure function with no I/O (D38) and cannot be
 * escaped, so this file is where brief 38's remaining security surface lives:
 * it accepts paths from a client and writes them to disk. In the brief's own
 * words, *one unchecked join here is an arbitrary file write*. The paths that
 * must be confined are file read/write/delete, binary upload, **both sides** of
 * a rename, and the **`entrypoint`** field — on PATCH *and* on create.
 * `confinedOr400` is the single helper; there is no other way to turn a client
 * string into a path in this file, and `projectDirFor` is only ever joined onto
 * by the confinement layer itself.
 *
 * A note on decoding, because getting it wrong manufactures the vulnerability:
 * Fastify has already percent-decoded route parameters exactly once by the time
 * a handler sees them. **Nothing here decodes again.** A second decode turns a
 * client's `%252e%252e%252f` into `../` inside our own validator. See the
 * "What this layer deliberately does NOT do" section of `latex-paths.ts`.
 */

// --- Wire shapes -------------------------------------------------------------

function toLatexProject(row: LatexProjectRow): LatexProject {
  return {
    id: row.id,
    title: row.title,
    entrypoint: row.entrypoint,
    compileStatus: row.compile_status,
    publishedBookId: row.published_book_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const latexProjectListSchema = z.array(latexProjectSchema);
const latexFileListSchema = z.array(latexFileSchema);

// --- Request bodies ----------------------------------------------------------
//
// Defined here rather than in `packages/shared` because these are *request*
// shapes with no client-side counterpart yet; the response contracts all come
// from shared, which is what keeps the client from drifting (D11).

/**
 * The project size cap, floored to a whole number of bytes.
 *
 * `LATEX_MAX_PROJECT_MB` is a *number*, not an integer (it is a tuning knob and
 * `0.5` is a perfectly reasonable thing to write), so the byte count derived
 * from it can be fractional. Fastify's route-level `bodyLimit` rejects a
 * non-integer at **registration** time, which is a crash on boot rather than a
 * bad request — so the floor happens once, here, and every comparison in this
 * file uses the same whole number the body limit does.
 */
const MAX_PROJECT_BYTES = Math.floor(LATEX_MAX_PROJECT_BYTES);

const TITLE_MAX = 200;

const createProjectSchema = z.object({
  title: z.string().max(TITLE_MAX).optional(),
  /** Optional at creation; confined like every other path before it is stored. */
  entrypoint: z.string().max(1024).optional(),
});

const updateProjectSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX).optional(),
    entrypoint: z.string().max(1024).optional(),
  })
  // A PATCH naming neither field is a client bug, not a no-op worth pretending
  // succeeded — it would return a project the caller thinks it just changed.
  .refine((v) => v.title !== undefined || v.entrypoint !== undefined, {
    message: "Provide at least one of `title` or `entrypoint`.",
  });

const renameSchema = z.object({
  from: z.string().max(1024),
  to: z.string().max(1024),
});

/**
 * The body of `PUT /latex/:id/files/*`.
 *
 * Two encodings are accepted because both are natural and neither is wrong:
 * `text/plain` (Fastify's built-in parser hands the handler a string) and
 * `application/json` as `{ "content": "..." }`. Anything else is a 400 —
 * writing a file whose contents we could not identify is exactly the operation
 * that should fail loudly.
 */
function bodyToContent(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (typeof body === "object" && body !== null) {
    const content = (body as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return null;
}

// --- The seeded hello-world --------------------------------------------------

/**
 * What a brand-new project starts as (brief 38, decision 4).
 *
 * **Deliberately inside the subset brief 37's engine actually renders**: prose,
 * sections, `\textbf`/`\emph`, and one `itemize`. No math, no figures, no
 * tables — those are briefs 39 and 40, and seeding them would greet a new user
 * with a diagnostics panel full of "not supported" on a document they did not
 * write. Verified to compile with **zero** diagnostics.
 *
 * The project's title is *not* interpolated into the `\title` of the document.
 * A title is free text and LaTeX has ten characters that change meaning inside
 * it; escaping them correctly is a real job, and getting it subtly wrong would
 * mean a new project whose seed does not compile — the one thing this constant
 * exists to guarantee. The row's `title` is what names the project in the UI.
 */
const HELLO_WORLD_TEX = `\\documentclass{article}

\\begin{document}

\\section{Welcome}

This is a new Atrium project. Everything you see here is set by Atrium's own
typesetting engine, which runs on the server and needs no LaTeX installation:
edit the source on the left, press Compile, and the PDF on the right is rebuilt
from these words.

You can split a document across several files and add figures and bibliography
files from the file tree. The file compiled as the document root is the
project's \\emph{entrypoint}, which starts out as this file.

\\section{What you can write today}

The engine implements a subset of LaTeX and it is honest about the edges: a
command it does not implement is reported as \\textbf{unsupported} in the log
rather than quietly typeset as something else. Working now:

\\begin{itemize}
  \\item Paragraphs of prose, broken into lines and hyphenated the way \\TeX{}
        does it, one paragraph at a time.
  \\item Sections, subsections and their numbering.
  \\item Bold, italic and emphasis.
  \\item Bulleted and numbered lists, including nested ones.
\\end{itemize}

Delete all of this and start writing.

\\end{document}
`;

// --- Walking a project's working tree ----------------------------------------

/**
 * Ceilings on the walk, mirroring `readProjectTree` in `latex-compile.ts` so a
 * project the compiler refuses to read cannot be one the file tree happily
 * enumerates forever.
 */
const MAX_TREE_DEPTH = 32;
const MAX_TREE_FILES = 5_000;

/**
 * The longest path a write may create, in `/`-separated segments.
 *
 * Tied to `MAX_TREE_DEPTH` because it is the *same* number seen from the other
 * side. The walk below enters the root at depth 0 and refuses to descend past
 * depth `MAX_TREE_DEPTH`, so the deepest file it can ever see has
 * `MAX_TREE_DEPTH` directories above it — `MAX_TREE_DEPTH + 1` segments. A file
 * written any deeper would be **invisible to the walk**, and the walk is what
 * `LATEX_MAX_PROJECT_BYTES` is computed from and what `zipProjectTree`
 * archives. See `refuseUnaccountablePath`.
 */
const MAX_PATH_SEGMENTS = MAX_TREE_DEPTH + 1;

/**
 * Why the walk stopped short of the whole tree, and where.
 *
 * This is the load-bearing half of the walk's result, not diagnostic colour.
 * A truncated walk under-reports `totalBytes` (so the size cap silently fails
 * to fire for the bytes it could not see) and under-reports the file list (so
 * a published version's zip would silently omit them). Both failures are
 * silent by construction — nothing about them is visible in the returned
 * array — which is why the flag exists and why every caller that makes a
 * *decision* from the walk must refuse rather than proceed.
 */
type TreeTruncation = { reason: "depth" | "count"; at: string };

interface ProjectTreeWalk {
  files: LatexFile[];
  /** Null when the walk saw the entire tree. See `TreeTruncation`. */
  truncated: TreeTruncation | null;
}

/** What to tell a person whose project cannot be fully enumerated. */
function truncationMessage(t: TreeTruncation): string {
  return t.reason === "depth"
    ? `A directory in this project is nested more than ${MAX_TREE_DEPTH} levels deep (at \`${t.at}\`), so its contents cannot be counted towards the project's size or included in a published version. Move those files closer to the project root.`
    : `This project has more than ${MAX_TREE_FILES} files, so the rest cannot be counted towards its size or included in a published version. Delete some files first.`;
}

/**
 * List a project's files, project-relative, **excluding build artifacts**.
 *
 * The exclusion is not cosmetic. `.atrium-build/out.pdf` is *output*: listing
 * it as a source file invites someone to edit or delete it, and — because this
 * same walk is what the size cap is computed from — would make every compile
 * shrink the space left for the sources that produced it.
 *
 * Symlinks are listed as nothing at all, for the reason `readProjectTree`
 * gives: a link is not a project file, the compiler will not read it, and a
 * file tree that shows one the compiler ignores is lying about the project.
 */
export async function walkProjectTree(projectId: string): Promise<ProjectTreeWalk> {
  const root = projectDirFor(projectId);
  const out: LatexFile[] = [];
  let truncated: TreeTruncation | null = null;

  // Set once the FILE ceiling is hit. Distinct from `truncated`: a depth
  // refusal skips one subtree and the walk carries on with its siblings (the
  // editor's file tree should still show everything it legitimately can),
  // whereas a full list has nothing more to add anywhere and must stop.
  let full = false;

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (full) return;
    if (depth > MAX_TREE_DEPTH) {
      // Recorded, not silently returned. Everything below here is invisible to
      // the size cap and to the publish archive; a caller that cannot see that
      // fact cannot refuse, and refusing is the only safe answer. First
      // refusal wins — the message names one place, and one is enough to make
      // the whole walk unusable for a size or archive decision.
      truncated ??= { reason: "depth", at: prefix };
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A project whose directory does not exist yet lists as empty rather than
      // erroring — that is the honest answer, not a failure.
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (full) return;
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isBuildArtifactPath(relativePath)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, fifos, devices are not project files
      // Checked here — when a file is actually about to be added — rather than
      // at the top of the loop, so a project holding EXACTLY `MAX_TREE_FILES`
      // files reports itself complete. A ceiling test that fires on the file
      // that fits would refuse writes and publishes to a perfectly legal
      // project forever.
      if (out.length >= MAX_TREE_FILES) {
        full = true;
        truncated ??= { reason: "count", at: relativePath };
        return;
      }
      try {
        const info = await stat(join(dir, entry.name));
        out.push({
          path: relativePath,
          sizeBytes: info.size,
          updatedAt: new Date(info.mtimeMs).toISOString(),
        });
      } catch {
        // Raced with a delete. Not in the listing, which is correct.
      }
    }
  };

  await walk(root, "", 0);
  return { files: out, truncated };
}

/**
 * The files themselves, for the callers that only *display* them.
 *
 * `GET /latex/:id/files` is the one caller that may ignore truncation: showing
 * 5,000 of a project's files is a degraded listing, not a wrong decision.
 * Anything that computes the size cap or builds a publish archive must use
 * `walkProjectTree` and refuse a truncated answer.
 */
export async function listProjectFiles(projectId: string): Promise<LatexFile[]> {
  return (await walkProjectTree(projectId)).files;
}

function totalBytes(files: LatexFile[]): number {
  return files.reduce((sum, f) => sum + f.sizeBytes, 0);
}

/**
 * Remove directories left empty by a delete or a rename, up to (but never
 * including) the project root.
 *
 * Directories in a LaTeX project are implied by the files in them — nothing
 * creates one on purpose — so an empty one is debris the file tree would never
 * show and nothing could ever remove. `rmdir` refuses a non-empty directory,
 * which is the whole safety property: this can only ever delete emptiness.
 */
async function pruneEmptyDirs(projectId: string, absoluteFile: string): Promise<void> {
  const root = projectDirFor(projectId);
  let dir = dirname(absoluteFile);
  for (let i = 0; i < MAX_TREE_DEPTH; i++) {
    // `relative` answering "" or something starting with ".." means we have
    // reached (or somehow left) the root; either way, stop.
    const rel = relative(root, dir);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return;
    try {
      await rmdir(dir);
    } catch {
      return; // not empty, or gone already
    }
    dir = dirname(dir);
  }
}

// --- Serving file bytes ------------------------------------------------------

/**
 * Content types for reads. Text formats are served as text so the editor can
 * display them; everything else falls through to `application/octet-stream`.
 *
 * **SVG is deliberately absent.** Served as `image/svg+xml` it is a script
 * execution context, and a project file is content the client uploaded — a
 * link carrying a `?token=` (the guard accepts one, for cover `<img>` tags)
 * would render it on the API's origin. As an octet-stream it downloads
 * instead, which costs an inline preview of a format the engine cannot draw
 * until brief 39 anyway.
 */
const TEXT_EXTENSIONS = new Set([
  "tex", "bib", "cls", "sty", "bst", "txt", "md", "csv", "json", "log", "yml", "yaml",
]);
const BINARY_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

function contentTypeFor(relativePath: string): string {
  const ext = extname(relativePath).slice(1).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  return BINARY_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Stream a file that is known to exist, with a validator the editor can
 * revalidate against.
 *
 * The ETag is size + mtime rather than the id trick `library-routes.ts` uses:
 * a book's bytes never change for a given id, but a project file's change on
 * every save, so identity is not a validator here.
 */
export function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  info: { size: number; mtimeMs: number },
  contentType: string,
) {
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  reply
    .header("Cache-Control", "private, no-cache")
    .header("ETag", etag)
    // Never let a browser guess a type we deliberately narrowed (see the SVG
    // note above).
    .header("X-Content-Type-Options", "nosniff");
  if (request.headers["if-none-match"] === etag) return reply.status(304).send();
  reply.header("Content-Type", contentType).header("Content-Length", String(info.size));
  return reply.send(createReadStream(path));
}

// --- Routes ------------------------------------------------------------------

// The app-wide guard (auth.ts) attaches both or 401s, so neither is optional
// in practice. The **profile** owns projects; the **account** is the security
// boundary and the compile single-flight scope (D35).
export const pid = (request: FastifyRequest): string => request.authProfile!.id;
export const uid = (request: FastifyRequest): string => request.authUser!.id;

/**
 * Rule 1, in one place. Resolve `:id` to a project **on the caller's own
 * profile**, or answer 404 and return null.
 *
 * The scoping is in the SQL (`db.ts`: `WHERE id = ? AND profile_id = ?`), not
 * a comparison afterwards, so there is no version of this that forgets the
 * check — and a project on a sibling profile of the same account is
 * indistinguishable from one that does not exist, which is the point.
 */
export function requireProject(
  request: FastifyRequest,
  reply: FastifyReply,
): LatexProjectRow | null {
  const { id } = request.params as { id?: string };
  const row = id ? getLatexProject(pid(request), id) : undefined;
  if (!row) {
    void reply.status(404).send({ error: "NOT_FOUND" });
    return null;
  }
  return row;
}

/**
 * Rule 2, in one place. Confine an untrusted, client-supplied path to the
 * project's directory, or answer 400 and return null.
 *
 * `confineProjectPath` never throws — a rejection is a *result* — and its
 * `message` is written to be shown to a person, so it goes into the body
 * verbatim. `field` names which input was bad, because a rename has two and
 * "invalid path" alone would not say which.
 *
 * `refuseArtifacts` additionally rejects a path inside the build directory.
 * Those are compile output, not project files: they are excluded from the
 * listing and from the size cap, so accepting a write to one would let a
 * client store unbounded bytes the cap cannot see, and let it clobber the PDF
 * the preview pane is showing.
 */
export async function confinedOr400(
  reply: FastifyReply,
  projectId: string,
  untrustedPath: string,
  field: string,
  refuseArtifacts = true,
): Promise<Extract<ConfinedPath, { ok: true }> | null> {
  const confined = await confineProjectPath(projectId, untrustedPath);
  if (!confined.ok) {
    void reply
      .status(400)
      .send({ error: "INVALID_PATH", field, reason: confined.reason, message: confined.message });
    return null;
  }
  if (refuseArtifacts && isBuildArtifactPath(confined.relativePath)) {
    void reply.status(400).send({
      error: "INVALID_PATH",
      field,
      reason: "build-artifact",
      message: "That path belongs to the compiler's output directory and is not a project file.",
    });
    return null;
  }
  return confined;
}

/**
 * Refuse a write whose path is too deep for the accounting walk to ever see.
 *
 * ## This is the cap bypass, closed at its source
 *
 * `LATEX_MAX_PROJECT_BYTES` is enforced against `walkProjectTree`, and that walk
 * stops at `MAX_TREE_DEPTH`. So a file written to
 * `a/b/c/…/d33/x.tex` — 33 nested directories, about a hundred characters, well
 * inside the confinement layer's 1024-character limit, and created for free by
 * `mkdir(recursive: true)` — is invisible to the walk. Its bytes never appear
 * in `totalBytes`, so the projected size never grows and the cap never fires;
 * repeat per file, each up to the 50 MB body limit, and the cap is not a cap.
 * The same files are also missing from `zipProjectTree`, so a version published
 * afterwards ships an archive that cannot rebuild it.
 *
 * Refusing the *write* is what closes both, and it closes them at the only
 * moment a project can acquire such a path: nothing else creates directories.
 * Applied to every route that can put bytes at a new path — write, upload, and
 * the destination of a rename (moving a file out of the accountable window is
 * the same bypass with an extra step). Deliberately NOT applied to read or
 * delete: a path that predates this guard must still be readable and, above
 * all, removable.
 */
function refuseUnaccountablePath(
  reply: FastifyReply,
  relativePath: string,
  field: string,
): boolean {
  if (relativePath.split("/").length <= MAX_PATH_SEGMENTS) return false;
  void reply.status(400).send({
    error: "INVALID_PATH",
    field,
    reason: "too-deep",
    message: `That path nests more than ${MAX_TREE_DEPTH} directories deep. Files that deep cannot be counted towards the project's size limit or included in a published version, so they are not accepted.`,
  });
  return true;
}

/**
 * The size-accounting walk, refused loudly when it could not see the whole tree.
 *
 * Every byte the walk misses is a byte the cap cannot enforce, so a truncated
 * walk is not a smaller answer to the same question — it is an answer to a
 * different one. Callers get the files or a `null` with the reply already sent.
 * 409 rather than 413: the project is not too large, it is *unaccountable*, and
 * the fix is structural (move files up, delete some) rather than "free up
 * space".
 */
async function accountedFilesOr409(
  reply: FastifyReply,
  projectId: string,
): Promise<LatexFile[] | null> {
  const walked = await walkProjectTree(projectId);
  if (walked.truncated !== null) {
    void reply.status(409).send({
      error: "PROJECT_TREE_TRUNCATED",
      reason: walked.truncated.reason,
      message: truncationMessage(walked.truncated),
    });
    return null;
  }
  return walked.files;
}

/**
 * Remove a project's whole working tree, tolerating a compile writing into it.
 *
 * This is the delete-mid-compile case, and it is a real race rather than a
 * theoretical one: the `cancelAndSettleLatexCompile` in `DELETE /latex/:id`
 * stops the engine at its next step
 * boundary, but the job still finishes by writing its log and diagnostics
 * into `.atrium-build/` — and the delete now WAITS for that to happen before
 * calling this, so the retry loop below is a backstop against a slow
 * filesystem rather than against a job that has not run yet. It could not have
 * been the latter: a job still queued in `setImmediate` recreates the
 * directory after any number of passes have found it gone. A single `rm -r` that walks the directory while
 * those files appear fails with `ENOTEMPTY` — observed, not imagined — which
 * turned a delete that had already removed the row into a 500. So: retry, and
 * re-check afterwards, because a pass that succeeded may still have been
 * outrun by an artifact written a millisecond later.
 *
 * A tree that survives all of that is **logged, not raised**. The row is
 * already gone, so the project is unreachable and the delete really did
 * happen from every client's point of view; orphaned bytes are recoverable,
 * a 500 on a completed delete is not.
 */
export async function removeProjectTree(dir: string, request: FastifyRequest): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // `maxRetries`/`retryDelay` are Node's own backoff for exactly this
      // family of errors (ENOTEMPTY, EBUSY, EPERM, EMFILE).
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Swallowed here; the existence check below is the real verdict.
    }
    if (!existsSync(dir)) return;
  }
  request.log.warn({ dir }, "latex project tree could not be fully removed");
}

// --- Publishing: drafts become one library entry with many versions ---------
//
// Brief 38 step 6 and decisions 8/11. The whole of "publish ten times, one
// card" is that `latex_projects.published_book_id` is written ONCE and every
// later publish appends a `document_versions` row to the book already named
// there. Nothing below ever repoints that column at a different book.
//
// **No path is ever stored** (D39, correction of 2026-08-27). `books.file_path`
// and `books.cover_path` were dropped by brief 41 for being a stale cache of a
// pure function, and `document_versions` was specified with `pdf_path` /
// `source_zip_path` columns that were removed before they were ever written.
// So every artifact this file produces goes to a location `paths.ts` derives
// from an id:
//
//   versionPdfPathFor(version.id)  the version's own immutable PDF
//   versionZipPathFor(version.id)  the project tree that produced it
//   filePathFor(bookId, "pdf")     the LIBRARY file — a copy of the NEWEST
//                                  version's PDF
//   coverPathFor(bookId)           the card's thumbnail, page 1 of the newest
//
// The newest version's bytes therefore exist twice, and that duplication is
// deliberate: it is what lets `GET /library/:id/file` keep resolving the one
// derivation D39 unified, with no "is this a published document?" branch
// anywhere in the reader, the offline download, or the file route.

/** The version-picker wire row. `sizeBytes` is the version PDF's size on disk. */
function toDocumentVersion(row: DocumentVersionRow, sizeBytes: number): DocumentVersion {
  return {
    id: row.id,
    versionNo: row.version_no,
    publishedAt: row.published_at,
    sizeBytes,
  };
}

/**
 * Widen a version row to the wire, stat'ing its PDF for the size.
 *
 * A version whose PDF is missing reports `0` rather than dropping out of the
 * list or 500ing: the row is what says the version exists, and a picker that
 * silently hid a version whose bytes had been lost would be lying about the
 * document's history. `0` is visible and the delete still works.
 */
async function versionToWire(row: DocumentVersionRow): Promise<DocumentVersion> {
  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(versionPdfPathFor(row.id))).size;
  } catch {
    // Missing artifact — see above.
  }
  return toDocumentVersion(row, sizeBytes);
}

/**
 * Zip a project's whole working tree — the archive stored beside a version's
 * PDF so that version can actually be rebuilt.
 *
 * *"So it's easy to resume"*: a version that cannot be rebuilt is not a
 * version, which is why this sits next to the PDF rather than being optional.
 *
 * The file list comes from `listProjectFiles`, deliberately, rather than from a
 * fresh walk: that function already excludes `.atrium-build/` (output, not
 * source — archiving it would ship a stale PDF inside the sources) and skips
 * symlinks (the compiler will not read one, so an archive containing one would
 * not rebuild the same document). It is therefore *exactly* what the compiler
 * read, which is the only definition of "the project" worth snapshotting.
 *
 * Entry names are the project-relative POSIX paths the walk already produced,
 * so unzipping into an empty project directory reproduces the tree verbatim.
 *
 * ## A truncated walk is a refusal, not a smaller archive
 *
 * `walkProjectTree` stops at `MAX_TREE_DEPTH` and `MAX_TREE_FILES`. If it did,
 * the files it did not reach would be **silently missing from the archive** —
 * and the archive's entire purpose is that the version can be rebuilt from it
 * ("so it's easy to resume"). A version that cannot be rebuilt is not a
 * version, so the only honest outcome is to say no and publish nothing. The
 * refusal is a **value**, matching `ConfinedPath` in `latex-paths.ts`: a
 * caller cannot reach the bytes without first narrowing past it, whereas a
 * thrown error is easy to let reach a 500 that says nothing useful.
 */
type ProjectArchive = { ok: true; bytes: Buffer } | { ok: false; message: string };

async function zipProjectTree(projectId: string): Promise<ProjectArchive> {
  const root = projectDirFor(projectId);
  const walked = await walkProjectTree(projectId);
  if (walked.truncated !== null) {
    return { ok: false, message: truncationMessage(walked.truncated) };
  }
  const zip = new AdmZip();
  for (const file of walked.files) {
    // `file.path` came from our own `readdir` walk, never from a client, and
    // the tree is bounded by `LATEX_MAX_PROJECT_BYTES`, so reading each entry
    // into memory is bounded too.
    zip.addFile(file.path, await readFile(join(root, file.path)));
  }
  return { ok: true, bytes: zip.toBuffer() };
}

/**
 * Point the LIBRARY artifacts at a version's bytes: the derived file, and the
 * cover extracted from page 1.
 *
 * Called on every publish and again whenever the newest version is deleted —
 * the two moments at which "the card shows the newest version" could otherwise
 * stop being true. There is no second cover convention: `coverPathFor(bookId)`
 * is the only one, and `extract.ts` is called, never modified.
 *
 * Cover extraction is best-effort. A PDF whose page 1 will not rasterize is
 * still a perfectly good published document — the gallery falls back to the
 * typographic card — so a failure here is logged and the publish stands.
 */
async function writeLibraryArtifacts(
  bookId: string,
  pdfBytes: Buffer,
  fallbackTitle: string,
  request: FastifyRequest,
): Promise<void> {
  await mkdir(LIBRARY_FILES_DIR, { recursive: true });
  // Atomic, via the compile module's helper rather than a second copy of it.
  // A plain `writeFile` truncates the destination first, and this exact path is
  // what `GET /library/:id/file` stats for a `Content-Length` and then streams:
  // a re-publish landing mid-stream hands a reader a short or spliced PDF. The
  // library ETag is `"${id}"`, which does NOT change across publishes, so a
  // browser can then cache that corruption. Writing to a temp name and renaming
  // means a reader gets either the whole old file or the whole new one — and it
  // also means a write that dies partway (ENOSPC) leaves the previous library
  // copy intact, which matters because the publish rollback below restores the
  // version row and its files but has never restored this one.
  await writeAtomic(filePathFor(bookId, "pdf"), pdfBytes);
  // The card must describe the file it is now serving. A re-publish can change
  // both — the draft may have been renamed, and v5 is rarely v1's size — and
  // without this the entry keeps advertising the first version forever.
  updatePublishedBook(bookId, fallbackTitle, pdfBytes.byteLength);
  try {
    const meta = await extractMeta(pdfBytes, "pdf", `${fallbackTitle}.pdf`);
    if (meta.cover) {
      await mkdir(THUMBNAILS_DIR, { recursive: true });
      // Written to the derived location and recorded nowhere: whether a book
      // has a cover is answered by stat'ing this same path on read.
      // Atomic for the same reason the PDF above is: `GET /library/:id/cover`
      // may be streaming this exact path to another device while a re-publish
      // rewrites it, and a truncated JPEG is a broken card the browser will
      // happily cache.
      await writeAtomic(coverPathFor(bookId), meta.cover);
    }
  } catch (err) {
    request.log.warn({ err, bookId }, "publish: cover extraction failed");
  }
}

export function registerLatexRoutes(app: FastifyInstance): void {
  /** The wildcard segment of a `files/*` route — already decoded by Fastify, exactly once. */
  const wildcard = (request: FastifyRequest): string =>
    (request.params as Record<string, string>)["*"] ?? "";

  // --- Projects --------------------------------------------------------------

  /** `GET /latex` — this profile's projects, most-recently-updated first. */
  app.get("/latex", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(latexProjectListSchema.parse(listLatexProjects(pid(request)).map(toLatexProject)));
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
    insertLatexProject(row);
    return reply.status(201).send(latexProjectSchema.parse(toLatexProject(row)));
  });

  /** `GET /latex/:id` — one project. */
  app.get("/latex/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = requireProject(request, reply);
    if (!project) return reply;
    return reply.send(latexProjectSchema.parse(toLatexProject(project)));
  });

  /** `PATCH /latex/:id` — rename, and/or repoint the entrypoint. */
  app.patch("/latex/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = requireProject(request, reply);
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
    const ok = updateLatexProject(
      pid(request),
      project.id,
      { title: parsed.data.title?.trim(), entrypoint },
      now,
    );
    if (!ok) return reply.status(404).send({ error: "NOT_FOUND" });
    // Re-read rather than reconstruct: COALESCE decided which columns changed.
    return reply.send(
      latexProjectSchema.parse(toLatexProject(getLatexProject(pid(request), project.id)!)),
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
    const project = requireProject(request, reply);
    if (!project) return reply;

    await cancelAndSettleLatexCompile(project.id);

    if (!deleteLatexProject(pid(request), project.id)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    // `projectDirFor` asserts the id's shape; it came from the row, so it is a
    // server-minted UUID and this cannot be pointed anywhere else.
    await removeProjectTree(projectDirFor(project.id), request);
    return reply.status(204).send();
  });

  // --- Files -----------------------------------------------------------------

  /** `GET /latex/:id/files` — the editor's file tree. Build artifacts excluded. */
  app.get("/latex/:id/files", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = requireProject(request, reply);
    if (!project) return reply;
    return reply.send(latexFileListSchema.parse(await listProjectFiles(project.id)));
  });

  /** `GET /latex/:id/files/*` — one file's contents. */
  app.get("/latex/:id/files/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const project = requireProject(request, reply);
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
      const project = requireProject(request, reply);
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
      touchLatexProject(project.id, now);

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
    const project = requireProject(request, reply);
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
    touchLatexProject(project.id, now);
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
    const project = requireProject(request, reply);
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
    touchLatexProject(project.id, new Date().toISOString());
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
    const project = requireProject(request, reply);
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
      updateLatexProject(pid(request), project.id, { entrypoint: to.relativePath }, now);
    } else {
      touchLatexProject(project.id, now);
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
    const project = requireProject(request, reply);
    if (!project) return reply;

    const started = startLatexCompile(project, uid(request));
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
    const project = requireProject(request, reply);
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
    const runningRow = getRunningLatexCompile(userId);
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
    const project = requireProject(request, reply);
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
    const project = requireProject(request, reply);
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
    const project = requireProject(request, reply);
    if (!project) return reply;

    const started = startLatexCompile(project, uid(request));
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
    const fresh = getLatexProject(pid(request), project.id);
    if (!fresh) {
      // Deleted (or moved to another profile) while it was compiling. The
      // compile's own artifacts are already gone with the tree; publishing a
      // project that no longer exists would create a card nothing can reach.
      return reply.status(404).send({ error: "NOT_FOUND" });
    }

    const existingBook = fresh.published_book_id ? getBook(fresh.published_book_id) : undefined;
    const bookId = existingBook?.id ?? randomUUID();
    const createdBook = existingBook === undefined;
    if (createdBook) {
      insertBook({
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
      if (!setLatexPublishedBook(project.id, bookId)) {
        deleteBook(bookId);
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
      version = appendDocumentVersion(bookId, now);
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
        deleteDocumentVersion(version.id);
        await rm(versionPdfPathFor(version.id), { force: true });
        await rm(versionZipPathFor(version.id), { force: true });
      }
      if (createdBook) {
        // `published_book_id` is cleared by the FK's ON DELETE SET NULL.
        deleteBook(bookId);
        await rm(filePathFor(bookId, "pdf"), { force: true });
        await rm(coverPathFor(bookId), { force: true });
      }
      throw err;
    }

    return reply.status(createdBook ? 201 : 200).send({
      book: toLibraryBook(
        getBook(bookId)!,
        getProfileProgress(pid(request), bookId) ?? { progress: 0, locator: null },
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
    const book = getBook(id);
    if (!book) return reply.status(404).send({ error: "Book not found." });

    const versions = await Promise.all(listDocumentVersions(id).map(versionToWire));
    return reply.send({
      versions: z.array(documentVersionSchema).parse(versions),
      currentVersionId: getProfileProgress(pid(request), id)?.version_id ?? null,
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
      const book = getBook(id);
      if (!book) return reply.status(404).send({ error: "Book not found." });
      const version = getDocumentVersion(versionId);
      if (!version || version.book_id !== id) {
        return reply.status(404).send({ error: "Version not found." });
      }

      const wasLatest = getLatestDocumentVersion(id)?.id === version.id;
      deleteDocumentVersion(version.id);
      await rm(versionPdfPathFor(version.id), { force: true });
      await rm(versionZipPathFor(version.id), { force: true });

      if (countDocumentVersions(id) === 0) {
        await deleteBookWithArtifacts(book, request.log);
        return reply.status(204).send();
      }

      if (wasLatest) {
        const latest = getLatestDocumentVersion(id)!;
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
