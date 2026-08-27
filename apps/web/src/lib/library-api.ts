import {
  documentVersionSchema,
  libraryBookSchema,
  libraryListSchema,
  type DocumentVersion,
  type FileType,
  type LibraryBook,
  type LibrarySort,
} from "@ebook-reader/shared";
import { z } from "zod";
import { apiFetch, apiUrl, getAuthToken } from "./api-client";

/**
 * Library API calls (decisions.md D24). Thin wrappers over the Fastify library
 * routes; responses are validated against the shared Zod contract so the
 * client can't drift from the server (D11).
 */

/** `GET /library` — the gallery list, sorted server-side. */
export async function fetchLibrary(sort: LibrarySort): Promise<LibraryBook[]> {
  const res = await apiFetch(`/library?sort=${sort}`);
  return libraryListSchema.parse(await res.json());
}

/** `POST /library` — upload a file; returns the created book. */
export async function uploadBook(file: File): Promise<LibraryBook> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch("/library", { method: "POST", body: form });
  return libraryBookSchema.parse(await res.json());
}

/** `DELETE /library/:id`. */
export async function deleteBook(id: string): Promise<void> {
  await apiFetch(`/library/${id}`, { method: "DELETE" });
}

/**
 * `GET /library/:id` — one book, with BOTH convert link directions resolved
 * (D34). Unlike `fetchLibrary`, this does not filter out converted books — the
 * reader's convert status poll (`use-library.ts`'s `useConvertingBook`) and the
 * format switch both need to read a row the gallery list would hide.
 */
export async function fetchBookById(id: string): Promise<LibraryBook> {
  const res = await apiFetch(`/library/${id}`);
  return libraryBookSchema.parse(await res.json());
}

/**
 * `POST /library/:id/convert` — start a conversion (D34 decisions 4/6). 202
 * means a job started; 200 means a conversion already existed (no-op) and its
 * `LibraryBook` comes back instead. Callers don't need to branch on which one
 * they got — `useStartConvert` (use-library.ts) just invalidates the book's
 * query afterward and lets the next `GET` be the truth.
 *
 * `force` mirrors the route's `?force=1` (re-run over an existing conversion)
 * but **no call site in this app passes it**: forcing DELETEs the existing
 * conversion first and only THEN attempts to start a new one, and if a
 * different book is mid-conversion that second step is refused — leaving the
 * forced book with nothing until retried (brief 34's documented edge case).
 * `ConvertControl` never exposes a force-based "convert again" action, which
 * is what keeps that race from ever happening here. Kept as a param only for
 * fidelity to the route contract, should a future surface need it (and handle
 * the race first).
 */
export async function startConvert(
  id: string,
  opts?: { force?: boolean },
): Promise<{ convertedBookId: string; targetFormat: FileType } | LibraryBook> {
  const qs = opts?.force ? "?force=1" : "";
  const res = await apiFetch(`/library/${id}/convert${qs}`, { method: "POST" });
  const body: unknown = await res.json();
  // 200 body is the existing converted LibraryBook; 202 body is the
  // {convertedBookId, targetFormat} start receipt — status code disambiguates.
  return res.status === 200
    ? libraryBookSchema.parse(body)
    : (body as { convertedBookId: string; targetFormat: FileType });
}

/**
 * `DELETE /library/:id/convert` — cancel a running job, from the SOURCE book's
 * id (D34). The route also deletes a finished conversion from this same verb,
 * but `ConvertControl` only ever calls this while `convertStatus === "running"`
 * (its Cancel action) — see the module comment on why a delete-and-redo path
 * isn't exposed here.
 */
export async function cancelConvert(id: string): Promise<void> {
  await apiFetch(`/library/${id}/convert`, { method: "DELETE" });
}

/**
 * `PATCH /library/:id/progress` — persist the current profile's progress
 * (0..1) and, when known, their exact resume `locator` (page number / CFI).
 *
 * `profileId` (brief 35 step 7) is for the offline-queue flush ONLY: it names
 * the profile that recorded the position, overriding the server's normal
 * session-resolved profile. Omit it (as every live call site does) and the
 * server writes to whoever the session says is active right now — correct
 * for a write that's happening as it's made.
 */
/**
 * `versionId` (brief 38, added 2026-08-27) — which published **version** the
 * `locator` was measured in. Omitted (the default, and every call site outside
 * the reader) leaves the stored one untouched, exactly like an omitted
 * `locator` — the server COALESCEs both, so they only ever move together (see
 * `updateProgressSchema`'s doc comment). `undefined` here is dropped by
 * `JSON.stringify`, never sent as a literal `null`, which is what makes
 * omitting it safe for every non-versioned book (all of them, until a
 * document is published).
 */
export async function updateProgress(
  id: string,
  progress: number,
  locator?: string | null,
  profileId?: string,
  versionId?: string | null,
): Promise<void> {
  await apiFetch(`/library/${id}/progress`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ progress, locator: locator ?? null, profileId, versionId }),
  });
}

/**
 * `GET /library/:id/versions` — the version picker's data (brief 38 step 7).
 * `[]` for an ordinary upload (never versioned) — the caller shows no picker
 * at all below two entries. `currentVersionId` is this profile's own
 * `reading_progress.version_id`: the version whose `locator` is on file, or
 * `null`. It exists so the client can run decision 10's comparison itself
 * ("the version being opened !== currentVersionId" -> start at page 0)
 * without a second round trip.
 */
const libraryVersionsResponseSchema = z.object({
  versions: z.array(documentVersionSchema),
  currentVersionId: z.string().nullable(),
});
export interface LibraryVersionsResult {
  versions: DocumentVersion[];
  currentVersionId: string | null;
}
export async function fetchBookVersions(id: string): Promise<LibraryVersionsResult> {
  const res = await apiFetch(`/library/${id}/versions`);
  return libraryVersionsResponseSchema.parse(await res.json());
}

/**
 * `DELETE /library/:id/versions/:versionId` — 204 on success. If this removed
 * the LAST version, the whole library entry (row + files) is gone with it —
 * callers must refresh the library list, not just the version picker (brief
 * 38 step 7, decision 11).
 */
export async function deleteBookVersion(id: string, versionId: string): Promise<void> {
  await apiFetch(`/library/${id}/versions/${versionId}`, { method: "DELETE" });
}

/**
 * Absolute URL for a book's cover thumbnail (served from disk, D25). Cover
 * `<img>` tags can't send an `Authorization` header, so when auth is enabled
 * the token rides along as a query param instead (brief 09).
 */
export function coverUrl(id: string): string {
  const url = apiUrl(`/library/${id}/cover`);
  const token = getAuthToken();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

/**
 * `POST /library/:id/cover` — set an item's cover from a client-supplied image
 * (brief 42, D40). The one cover the server cannot extract itself is video's,
 * so the browser decodes a frame and posts it (see `video-cover.ts`).
 *
 * The server re-encodes the bytes through sharp and stores THAT — our bytes are
 * never stored verbatim, so there is no geometry to match here. Last-write-wins
 * by decision (D40 item 2): no replace flag, no 409, so a retry is always safe.
 *
 * Throws `ApiError` like every other call here — 400 for a payload sharp cannot
 * decode, 413 over the upload limit, 404 for an unknown id. Callers of the
 * capture path swallow all of them (a cover is never worth surfacing an error
 * for); `apiFetch` still routes a 401 through the global handler.
 */
export async function uploadCover(id: string, image: Blob): Promise<void> {
  const form = new FormData();
  // The field name is irrelevant server-side (`request.file()` takes the first
  // part), but a filename is what makes this a *file* part rather than a plain
  // field — without one some multipart parsers see no file at all.
  form.append("file", image, `${id}.jpg`);
  await apiFetch(`/library/${id}/cover`, { method: "POST", body: form });
}

/**
 * Fetch a stored book's original bytes as a `File` so the existing readers
 * (which consume an in-memory `File` from Zustand) can render it unchanged.
 *
 * Streams the body and reports download progress as a 0–1 fraction (brief 10).
 * The server streams without Content-Length, so the library row's `sizeBytes`
 * is the total; `null` means indeterminate (streaming unavailable). Completion
 * always reports exactly 1.
 */
export async function fetchBookFile(
  book: LibraryBook,
  onProgress?: (fraction: number | null) => void,
  /**
   * A specific published version's PDF, via `?version=`. Omitted/null (every
   * call site outside the version picker) serves "the newest" — no lookup
   * needed server-side (see the route's own comment) — which is exactly what
   * every non-versioned book has always fetched.
   */
  versionId?: string | null,
): Promise<File> {
  const qs = versionId ? `?version=${encodeURIComponent(versionId)}` : "";
  const res = await apiFetch(`/library/${book.id}/file${qs}`);
  const ext = book.format;
  const mime = ext === "pdf" ? "application/pdf" : "application/epub+zip";
  const safeName = `${book.title || book.id}.${ext}`.replace(/[/\\]/g, "_");

  let blob: Blob;
  if (res.body && book.sizeBytes > 0) {
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      // Clamp below 1 mid-stream — only actual completion reports 1.
      onProgress?.(Math.min(received / book.sizeBytes, 0.99));
    }
    blob = new Blob(chunks);
  } else {
    onProgress?.(null);
    blob = await res.blob();
  }
  onProgress?.(1);
  return new File([blob], safeName, { type: mime });
}
