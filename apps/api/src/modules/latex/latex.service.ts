import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rmdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import AdmZip from "adm-zip";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  latexFileSchema,
  latexProjectSchema,
  type DocumentVersion,
  type LatexFile,
  type LatexProject,
} from "@ebook-reader/shared";
import {
  LATEX_MAX_PROJECT_BYTES,
  LIBRARY_FILES_DIR,
  THUMBNAILS_DIR,
} from "../../common/config.js";
import {
  coverPathFor,
  filePathFor,
  projectDirFor,
  versionPdfPathFor,
} from "../../common/paths.js";
import { extractMeta } from "../library/extract.service.js";
import { updatePublishedBook } from "../library/library.model.js";
import {
  isBuildArtifactPath,
  writeAtomic,
} from "./latex-compile.service.js";
import { confineProjectPath, type ConfinedPath } from "./latex-paths.js";
import {
  getLatexProject,
  type DocumentVersionRow,
  type LatexProjectRow,
} from "./latex.model.js";

/**
 * The `/latex` domain logic (brief 38) — wire shapes, the working tree, path
 * confinement, and publishing. `latex.controller.ts` sits on top and owns the
 * HTTP; the two rules below bind both files, and the helpers that enforce them
 * (`requireProject`, `confinedOr400`) live here because they are the gate, not
 * the routing.
 *
 * ## The two rules this file exists to keep
 *
 * **1. Every route resolves the project through `await getLatexProject(profileId, id)`
 * first.** That statement is profile-scoped *in the SQL*, so a project on
 * another profile is simply not found and the answer is **404, never 403** —
 * brief 35's rule, the same one the profiles controller states at length. A 403
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

export function toLatexProject(row: LatexProjectRow): LatexProject {
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

export const latexProjectListSchema = z.array(latexProjectSchema);
export const latexFileListSchema = z.array(latexFileSchema);

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
export const MAX_PROJECT_BYTES = Math.floor(LATEX_MAX_PROJECT_BYTES);

const TITLE_MAX = 200;

export const createProjectSchema = z.object({
  title: z.string().max(TITLE_MAX).optional(),
  /** Optional at creation; confined like every other path before it is stored. */
  entrypoint: z.string().max(1024).optional(),
});

export const updateProjectSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX).optional(),
    entrypoint: z.string().max(1024).optional(),
  })
  // A PATCH naming neither field is a client bug, not a no-op worth pretending
  // succeeded — it would return a project the caller thinks it just changed.
  .refine((v) => v.title !== undefined || v.entrypoint !== undefined, {
    message: "Provide at least one of `title` or `entrypoint`.",
  });

export const renameSchema = z.object({
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
export function bodyToContent(body: unknown): string | null {
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
export const HELLO_WORLD_TEX = `\\documentclass{article}

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

export function totalBytes(files: LatexFile[]): number {
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
export async function pruneEmptyDirs(projectId: string, absoluteFile: string): Promise<void> {
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

export function contentTypeFor(relativePath: string): string {
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
 * The scoping is in the SQL (`latex.model.ts`: `where({ id, profile_id })`), not
 * a comparison afterwards, so there is no version of this that forgets the
 * check — and a project on a sibling profile of the same account is
 * indistinguishable from one that does not exist, which is the point.
 */
export async function requireProject(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<LatexProjectRow | null> {
  const { id } = request.params as { id?: string };
  const row = id ? await getLatexProject(pid(request), id) : undefined;
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
export function refuseUnaccountablePath(
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
export async function accountedFilesOr409(
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
export function toDocumentVersion(row: DocumentVersionRow, sizeBytes: number): DocumentVersion {
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
export async function versionToWire(row: DocumentVersionRow): Promise<DocumentVersion> {
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

export async function zipProjectTree(projectId: string): Promise<ProjectArchive> {
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
export async function writeLibraryArtifacts(
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
  await updatePublishedBook(bookId, fallbackTitle, pdfBytes.byteLength);
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
