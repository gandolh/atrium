import {
  libraryBookSchema,
  libraryListSchema,
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
