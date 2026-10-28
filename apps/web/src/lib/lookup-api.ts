import {
  LOOKUP_SOURCE_NAMES,
  libraryBookSchema,
  lookupSearchResponseSchema,
  type LibraryBook,
  type LookupApplyRequest,
  type LookupSearchResponse,
  type LookupSource,
} from "@ebook-reader/shared";
import { ApiError, apiFetch, apiUrl } from "./api-client";

/**
 * Metadata lookup calls (brief 100, D59). The browser only ever talks to the
 * API: the search, the apply and the candidates' thumbnails all go through it,
 * so MusicBrainz and Open Library see the server, never the person.
 */

/** `GET /library/:id/lookup` — up to ten candidates; `[]` is "no results". */
export async function searchLookup(
  id: string,
  query: { title: string; author: string },
  signal?: AbortSignal,
): Promise<LookupSearchResponse> {
  const params = new URLSearchParams({ title: query.title, author: query.author });
  const res = await apiFetch(`/library/${id}/lookup?${params.toString()}`, { signal });
  return lookupSearchResponseSchema.parse(await res.json());
}

/** `POST /library/:id/lookup` — write the ticked fields; answers the updated item. */
export async function applyLookup(id: string, body: LookupApplyRequest): Promise<LibraryBook> {
  const res = await apiFetch(`/library/${id}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return libraryBookSchema.parse(await res.json());
}

/** A candidate's thumbnail, fetched and re-encoded by the API (never hotlinked). */
export function lookupCoverUrl(source: LookupSource, coverRef: string): string {
  return apiUrl(`/lookup/covers/${source}/${encodeURIComponent(coverRef)}`).toString();
}

/** The words for a failed search or apply. Every one of them also means nothing changed. */
export function lookupErrorMessage(error: unknown, source: LookupSource): string {
  const name = LOOKUP_SOURCE_NAMES[source];
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | undefined)?.error;
    if (code === "UPSTREAM") return `Couldn't reach ${name}. Nothing was changed. Try again in a moment.`;
    if (code === "NO_COVER") return `${name} has no cover for this one. Untick Cover to apply the rest.`;
    if (code === "BAD_COVER") return `${name} sent a cover that isn't an image. Untick Cover to apply the rest.`;
    if (code === "EMPTY_QUERY") return "Type a title or a name to search for.";
  }
  if (error instanceof TypeError) return "Couldn't reach Atrium's server. Nothing was changed.";
  return "That didn't work. Nothing was changed.";
}
