import { z } from "zod";
import {
  isLookupCoverRef,
  lookupCandidateSchema,
  type LookupCandidate,
} from "@ebook-reader/shared";
import { fetchJson } from "./lookup-http.js";

/**
 * The Open Library client (brief 100): a work search, mapped onto the
 * library's fields, and the covers service URL for a match's cover.
 *
 * Open Library's search carries no series, so a book candidate never offers
 * one; its covers are fetched by cover id (`/b/id/`), the form the covers
 * service does not rate-limit.
 */

const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_COVERS_URL = "https://covers.openlibrary.org";

const docSchema = z.object({
  key: z.string(),
  title: z.string().nullish(),
  author_name: z.array(z.string()).nullish(),
  first_publish_year: z.number().nullish(),
  cover_i: z.number().nullish(),
});
type OpenLibraryDoc = z.infer<typeof docSchema>;

const searchResponseSchema = z.object({ docs: z.array(docSchema).default([]) });

/** The first three authors, comma-joined: one string, as the library stores an author. */
function authors(doc: OpenLibraryDoc): string | null {
  const names = (doc.author_name ?? []).map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names.slice(0, 3).join(", ").slice(0, 500) : null;
}

function toCandidate(doc: OpenLibraryDoc): LookupCandidate | null {
  const cover = doc.cover_i != null ? String(doc.cover_i) : null;
  const parsed = lookupCandidateSchema.safeParse({
    source: "openlibrary",
    sourceId: doc.key,
    title: (doc.title ?? "").trim().slice(0, 500),
    author: authors(doc),
    series: null,
    seriesIndex: null,
    year: doc.first_publish_year != null && Number.isInteger(doc.first_publish_year) ? doc.first_publish_year : null,
    coverRef: cover && isLookupCoverRef("openlibrary", cover) ? cover : null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Search Open Library for works matching `title` and `author`, in its own
 * relevance order, at most `limit`. Throws when Open Library cannot be
 * reached.
 *
 * Unlike MusicBrainz, its free-text `q` searches titles and authors together
 * and ranks well, and it copes with a filename's leftovers, so the two are
 * simply joined.
 */
export async function searchOpenLibrary(
  title: string,
  author: string,
  limit: number,
): Promise<LookupCandidate[]> {
  const url = new URL(OPEN_LIBRARY_SEARCH_URL);
  url.searchParams.set("q", [title, author].filter(Boolean).join(" "));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i");
  const { docs } = searchResponseSchema.parse(await fetchJson(url.toString()));
  return docs.map(toCandidate).filter((c): c is LookupCandidate => c !== null);
}

/**
 * The covers service's image for a cover id, medium for the dialog or large
 * for the library. `default=false` makes a missing cover a 404 rather than a
 * blank placeholder image.
 */
export function openLibraryCoverUrl(coverId: string, size: "thumb" | "full"): string {
  return `${OPEN_LIBRARY_COVERS_URL}/b/id/${coverId}-${size === "thumb" ? "M" : "L"}.jpg?default=false`;
}
