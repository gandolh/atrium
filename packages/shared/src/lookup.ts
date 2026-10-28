import { z } from "zod";
// The leaf module, not ./index.js, which re-exports this file.
import type { MediaKind } from "./file-validation.js";

/**
 * Metadata lookup contract (brief 100, D59): a lookup the user asks for, on
 * one item at a time, never automatic and never on upload. Music asks
 * MusicBrainz (and the Cover Art Archive for its cover), books ask Open
 * Library. Films have no source until the owner registers a TMDb key.
 *
 * Every outbound call goes from the API. The browser never talks to a source,
 * and the API never fetches a URL the browser chose: a candidate names its
 * cover by an id (`coverRef`) that the server turns into the source's URL
 * itself.
 */

export const LOOKUP_SOURCES = ["musicbrainz", "openlibrary"] as const;
export const lookupSourceSchema = z.enum(LOOKUP_SOURCES);
export type LookupSource = z.infer<typeof lookupSourceSchema>;

/** The source's own name, for "Couldn't reach MusicBrainz". */
export const LOOKUP_SOURCE_NAMES: Record<LookupSource, string> = {
  musicbrainz: "MusicBrainz",
  openlibrary: "Open Library",
};

/**
 * Which source looks up an item of `kind`, or null when none does (video).
 * Shaped like `convertTargetForFormat`: the API turns the null into a 422 and
 * the tile menu into no Look up item, and the two must never disagree.
 */
export function lookupSourceForKind(kind: MediaKind): LookupSource | null {
  switch (kind) {
    case "audio":
      return "musicbrainz";
    case "book":
      return "openlibrary";
    default:
      return null;
  }
}

/** A MusicBrainz id (MBID): a lowercase UUID. */
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An Open Library cover id: a positive integer. */
const OPEN_LIBRARY_COVER_ID = /^[1-9][0-9]{0,11}$/;

/**
 * Whether `ref` is a well-formed cover id for `source`: a MusicBrainz release
 * group's MBID (the Cover Art Archive's `release-group/<mbid>/front`), or an
 * Open Library cover id (`covers.openlibrary.org/b/id/<id>`). The server
 * builds the URL from this and nothing else, so a ref that passes cannot
 * point a request anywhere but the source's own cover service.
 */
export function isLookupCoverRef(source: LookupSource, ref: string): boolean {
  return source === "musicbrainz" ? MBID.test(ref) : OPEN_LIBRARY_COVER_ID.test(ref);
}

/** One match a source returned, mapped onto the library's own fields. */
export const lookupCandidateSchema = z
  .object({
    source: lookupSourceSchema,
    /** The match's id at its source: a MusicBrainz recording MBID, an Open Library work key. */
    sourceId: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    /** Artist credit (music) or author(s) (books), or null when the source has none. */
    author: z.string().min(1).max(500).nullable(),
    /** The album (music) or series (books), or null. Open Library's search carries no series. */
    series: z.string().min(1).max(500).nullable(),
    /** Track number on the album, or position in the series, or null. */
    seriesIndex: z.number().finite().nonnegative().nullable(),
    /** Shown to help pick, never stored: the library has no year column. */
    year: z.number().int().nullable(),
    /** The cover's id at its source, or null when the source has none — see `isLookupCoverRef`. */
    coverRef: z.string().max(64).nullable(),
  })
  .superRefine((candidate, ctx) => {
    if (candidate.coverRef !== null && !isLookupCoverRef(candidate.source, candidate.coverRef)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coverRef"], message: "Not a cover id for this source." });
    }
  });
export type LookupCandidate = z.infer<typeof lookupCandidateSchema>;

/** `GET /library/:id/lookup` query. Both absent means "the item's own title and author". */
export const lookupSearchParamsSchema = z.object({
  title: z.string().max(300).optional(),
  author: z.string().max(300).optional(),
});
export type LookupSearchParams = z.infer<typeof lookupSearchParamsSchema>;

/** At most this many candidates come back from one search. */
export const LOOKUP_MAX_CANDIDATES = 10;

/** `GET /library/:id/lookup` response. An empty list is "no results", not an error. */
export const lookupSearchResponseSchema = z.object({
  source: lookupSourceSchema,
  candidates: z.array(lookupCandidateSchema).max(LOOKUP_MAX_CANDIDATES),
});
export type LookupSearchResponse = z.infer<typeof lookupSearchResponseSchema>;

/** The fields Apply can write. `cover` fetches the candidate's cover from its source. */
export const LOOKUP_FIELDS = ["title", "author", "series", "seriesIndex", "cover"] as const;
export type LookupField = (typeof LOOKUP_FIELDS)[number];

/** The candidate's value behind a field: null means it has nothing to offer there. */
export function lookupFieldValue(
  candidate: LookupCandidate,
  field: LookupField,
): string | number | null {
  return field === "cover" ? candidate.coverRef : candidate[field];
}

/**
 * `POST /library/:id/lookup` body: the chosen candidate and the fields the
 * user kept ticked. An unticked (or absent) field stays as it was. A ticked
 * field must have a value on the candidate — a lookup sets fields, it never
 * clears one the file had.
 */
export const lookupApplySchema = z
  .object({
    candidate: lookupCandidateSchema,
    fields: z
      .object({
        title: z.boolean().optional(),
        author: z.boolean().optional(),
        series: z.boolean().optional(),
        seriesIndex: z.boolean().optional(),
        cover: z.boolean().optional(),
      })
      .strict(),
  })
  .superRefine((body, ctx) => {
    const ticked = LOOKUP_FIELDS.filter((field) => body.fields[field]);
    if (ticked.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields"], message: "Tick at least one field." });
    }
    for (const field of ticked) {
      if (lookupFieldValue(body.candidate, field) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", field],
          message: "The candidate has no value for this field.",
        });
      }
    }
  });
export type LookupApplyRequest = z.infer<typeof lookupApplySchema>;
