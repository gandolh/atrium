import { apiUrl } from "../lib/api-client";

/**
 * Absolute URL for a book's original bytes, for a media element's `src` (brief
 * 23).
 *
 * No credential in the URL. Native `<audio>`/`<video>` elements cannot send an
 * `Authorization` header — which is why this carried `?token=` — but they do
 * send cookies, and Ward's session cookie is `Path=/` on the shared origin.
 *
 * The server serves this route with HTTP Range support (206 / `Accept-Ranges`),
 * so the element can seek and scrub without downloading the whole file. Range
 * requests carry cookies like any other, so seeking keeps working.
 */
export function mediaFileUrl(id: string): string {
  return apiUrl(`/library/${id}/file`).toString();
}
