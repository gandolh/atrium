import {
  documentVersionSchema,
  latexCompileResultSchema,
  latexFileSchema,
  latexProjectSchema,
  libraryBookSchema,
  type DocumentVersion,
  type LatexCompileResult,
  type LatexFile,
  type LatexProject,
  type LibraryBook,
} from "@ebook-reader/shared";
import { z } from "zod";
import { ApiError, apiFetch } from "../lib/api-client";

/**
 * LaTeX project API calls (brief 38 chunk 7). Thin wrappers over the Fastify
 * `/latex` routes (chunk 4 lands the server side); responses validate against
 * the shared Zod contract so the client can't drift from the server (D11).
 * Auth rides on `apiFetch` (bearer token), same as `notes-api.ts`.
 *
 * A project that belongs to another profile 404s (brief 35's rule — a 403
 * would confirm the id exists on someone else's account). Nothing here special-
 * cases that: `apiFetch` throws `ApiError` with `status: 404` like any other
 * not-found, and callers treat it as such.
 */

const latexProjectListSchema = z.array(latexProjectSchema);

/** `GET /latex` — this profile's projects, newest-updated first. */
export async function fetchLatexProjects(): Promise<LatexProject[]> {
  const res = await apiFetch("/latex");
  return latexProjectListSchema.parse(await res.json());
}

/** `GET /latex/:id` — one project. */
export async function fetchLatexProject(id: string): Promise<LatexProject> {
  const res = await apiFetch(`/latex/${id}`);
  return latexProjectSchema.parse(await res.json());
}

/** `POST /latex` — create a project, seeded server-side with a hello-world entrypoint. */
export async function createLatexProject(title: string): Promise<LatexProject> {
  const res = await apiFetch("/latex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return latexProjectSchema.parse(await res.json());
}

/** `PATCH /latex/:id` — rename or repoint the entrypoint. */
export async function updateLatexProject(
  id: string,
  fields: { title?: string; entrypoint?: string },
): Promise<LatexProject> {
  const res = await apiFetch(`/latex/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return latexProjectSchema.parse(await res.json());
}

/** `DELETE /latex/:id` — 204 on success. */
export async function deleteLatexProject(id: string): Promise<void> {
  await apiFetch(`/latex/${id}`, { method: "DELETE" });
}

// --- Files (brief 38 chunk 8) ------------------------------------------------

const latexFileListSchema = z.array(latexFileSchema);

/**
 * Encode a project-relative path for the `files/*` wildcard routes.
 *
 * Per SEGMENT, not whole-string: `encodeURIComponent` would escape the `/`
 * separators into `%2F`, collapsing `figures/plot.png` into a single segment
 * the server then rejects as an invalid path. Fastify decodes the wildcard
 * exactly once, so one encode here is the matching half — a literal `#`, `?`
 * or space in a filename survives the round trip.
 */
function encodeProjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** `GET /latex/:id/files` — the project tree (build artifacts already excluded server-side). */
export async function fetchLatexFiles(projectId: string): Promise<LatexFile[]> {
  const res = await apiFetch(`/latex/${projectId}/files`);
  return latexFileListSchema.parse(await res.json());
}

/**
 * `GET /latex/:id/files/*` — one file's bytes as text.
 *
 * The route sends `ETag` + `Cache-Control: private, no-cache`, so the browser
 * revalidates on its own and a 304 is served from the HTTP cache; there is
 * deliberately no hand-rolled ETag bookkeeping here.
 */
export async function fetchLatexFileText(projectId: string, path: string): Promise<string> {
  const res = await apiFetch(`/latex/${projectId}/files/${encodeProjectPath(path)}`);
  return res.text();
}

/**
 * `PUT /latex/:id/files/*` — create or overwrite a text file.
 *
 * The `Content-Type` is REQUIRED: Fastify answers 415 for a body with no type,
 * so the header is part of the contract rather than an optimisation. Sent as
 * `text/plain` (which Fastify parses natively) rather than JSON so a `.tex`
 * file is not paying for JSON escaping on every autosave.
 *
 * Single-writer, last-write-wins (decision 7): the whole file goes up as one
 * body, the server's copy becomes exactly what was sent, and there is no merge
 * or conflict path to reason about.
 */
export async function writeLatexFile(
  projectId: string,
  path: string,
  content: string,
): Promise<LatexFile> {
  const res = await apiFetch(`/latex/${projectId}/files/${encodeProjectPath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: content,
  });
  return latexFileSchema.parse(await res.json());
}

/** `DELETE /latex/:id/files/*` — 204 on success. */
export async function deleteLatexFile(projectId: string, path: string): Promise<void> {
  await apiFetch(`/latex/${projectId}/files/${encodeProjectPath(path)}`, { method: "DELETE" });
}

/**
 * `POST /latex/:id/rename` — move a file within the project. The server carries
 * the project's `entrypoint` along if the renamed file was it, so the caller
 * does not have to repoint it (but should refetch the project to see the new
 * value).
 */
export async function renameLatexFile(
  projectId: string,
  from: string,
  to: string,
): Promise<LatexFile> {
  const res = await apiFetch(`/latex/${projectId}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  return latexFileSchema.parse(await res.json());
}

// --- Compile, PDF and log (brief 38 chunk 9) --------------------------------

/**
 * `POST /latex/:id/compile` — compile the project's entrypoint and answer with
 * the full result. The request is synchronous server-side (D38): this simply
 * takes as long as the compile does. A **failed** compile is still a 200 with
 * `status: "failed"` and a populated `diagnostics` array — only a busy slot
 * (409 `COMPILE_BUSY`) or a transport failure throws.
 */
export async function compileLatexProject(projectId: string): Promise<LatexCompileResult> {
  const res = await apiFetch(`/latex/${projectId}/compile`, { method: "POST" });
  return latexCompileResultSchema.parse(await res.json());
}

/**
 * A `NOT_COMPILED` 404 from `/log` or `/pdf` is not a failure to surface — it
 * is the ordinary shape of "this project has never compiled." Both fetchers
 * below fold it into `null` so a query for either can render a quiet empty
 * state instead of an error banner.
 */
function isNotCompiled(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.body as { error?: string } | undefined)?.error === "NOT_COMPILED"
  );
}

/** `GET /latex/:id/log` — the last compile's result, or `null` if the project
 * has never compiled. */
export async function fetchLatexCompileLog(projectId: string): Promise<LatexCompileResult | null> {
  try {
    const res = await apiFetch(`/latex/${projectId}/log`);
    return latexCompileResultSchema.parse(await res.json());
  } catch (error) {
    if (isNotCompiled(error)) return null;
    throw error;
  }
}

/**
 * `GET /latex/:id/pdf` — the draft PDF as an in-memory `File`, or `null` if no
 * compile has ever succeeded. A `File` (not a URL) because that is exactly
 * the shape `PdfReader` already consumes — brief 05's uploader hands it the
 * same thing, so there is no second code path to maintain.
 *
 * The route survives a *failed* compile on purpose (`out.pdf` is written only
 * on success and never deleted on failure), so this keeps returning the last
 * good PDF even after one — the editor must never blank the preview pane on a
 * bad compile.
 */
export async function fetchLatexPdf(projectId: string): Promise<File | null> {
  try {
    const res = await apiFetch(`/latex/${projectId}/pdf`);
    const blob = await res.blob();
    return new File([blob], "preview.pdf", { type: "application/pdf" });
  } catch (error) {
    if (isNotCompiled(error)) return null;
    throw error;
  }
}

// --- Publish (brief 38 chunk 10) ---------------------------------------------

const latexPublishResultSchema = z.object({ book: libraryBookSchema, version: documentVersionSchema });
export interface LatexPublishResult {
  book: LibraryBook;
  version: DocumentVersion;
}

/**
 * `POST /latex/:id/publish` — compile the project and publish the result as a
 * library entry (decision 8: one entry, many versions). 201 on the FIRST
 * publish, 200 on every one after — the caller doesn't need to branch on
 * which, since `book` is the same shape either way and `version.versionNo` is
 * what actually distinguishes them.
 *
 * A **failing** compile is refused outright: the route answers 422
 * `COMPILE_FAILED` with a `result: LatexCompileResult` body instead of
 * creating anything, which `latexPublishErrorResult` below extracts so the
 * dialog can render it with the same `DiagnosticsPanel` chunk 9 already built.
 * `COMPILE_BUSY` (409) and `NO_PDF` (500) both carry a plain `message` and are
 * left to `latexErrorMessage`.
 */
export async function publishLatexProject(projectId: string): Promise<LatexPublishResult> {
  const res = await apiFetch(`/latex/${projectId}/publish`, { method: "POST" });
  return latexPublishResultSchema.parse(await res.json());
}

/**
 * Extract a 422 `COMPILE_FAILED` publish failure's `LatexCompileResult`, or
 * `null` for anything else (a different status, a body with no `result`) —
 * the dialog's signal to fall back to `latexErrorMessage` instead.
 */
export function latexPublishCompileFailure(error: unknown): LatexCompileResult | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const body = error.body as { error?: string; result?: unknown } | undefined;
  if (body?.error !== "COMPILE_FAILED" || body.result === undefined) return null;
  const parsed = latexCompileResultSchema.safeParse(body.result);
  return parsed.success ? parsed.data : null;
}

/**
 * Turn a failed `/latex` call into something worth showing a person.
 *
 * The routes answer with a real `{ error, message }` body for every case the
 * editor can actually provoke — an escaping path, a project at its size cap, a
 * rename onto an occupied name — and those `message`s are written to be read,
 * so they are preferred verbatim. The `error` code is the fallback for a body
 * that carries a code but no prose, and the status is the last resort. A
 * generic "something went wrong" would turn "this project is full, delete
 * something" into a mystery.
 */
export function latexErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body as { error?: string; message?: string } | undefined;
  if (typeof body?.message === "string" && body.message.trim()) return body.message;

  switch (body?.error) {
    case "INVALID_PATH":
      return "That path isn't inside this project.";
    case "PROJECT_TOO_LARGE":
      return "This project has reached its size limit. Delete something first.";
    case "FILE_TOO_LARGE":
      return "That file is too big to add to a project.";
    case "ALREADY_EXISTS":
      return "A file already exists at that path.";
    case "NOT_A_FILE":
      return "That's a folder, not a file.";
    case "COMPILE_BUSY":
      return "A compile is already running for this project.";
    default:
      break;
  }

  switch (error.status) {
    case 404:
      // A project on another profile answers 404, never 403 (brief 35) — the
      // same message covers both, on purpose.
      return "Not found — it may have been deleted or renamed.";
    case 413:
      return "Too large — this project has hit its size limit.";
    case 415:
      return "The server refused that request. Reload and try again.";
    default:
      return fallback;
  }
}
