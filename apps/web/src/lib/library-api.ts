import {
  libraryBookSchema,
  libraryListSchema,
  type FileType,
  type LibraryBook,
  type LibrarySort,
} from "@ebook-reader/shared";
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
export async function updateProgress(
  id: string,
  progress: number,
  locator?: string | null,
  profileId?: string,
): Promise<void> {
  await apiFetch(`/library/${id}/progress`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ progress, locator: locator ?? null, profileId }),
  });
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
): Promise<File> {
  const res = await apiFetch(`/library/${book.id}/file`);
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
