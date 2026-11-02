import { z } from "zod";

/**
 * Catalog (Project Gutenberg / Gutendex) wire contract — the Gutenberg discover page. Shared so
 * apps/web and apps/api can't drift (decisions.md D11). The API proxies the
 * public Gutendex instance, maps its response to `catalogBookSchema`, and
 * exposes an import route that pulls one book into the library.
 *
 * Robot policy: metadata comes from Gutendex only; the only gutenberg.org
 * request is the single EPUB download per explicit import.
 */

/**
 * Result ordering, mirroring Gutendex's `sort` param. `popular` (most
 * downloads) is the landing default when there's no query.
 */
export const CATALOG_SORTS = ["popular", "ascending", "descending"] as const;
export const catalogSortSchema = z.enum(CATALOG_SORTS);
export type CatalogSort = z.infer<typeof catalogSortSchema>;

/**
 * `GET /catalog/gutenberg` query params. All optional — an empty query lands on
 * the popular list. `languages` is a comma-separated list of ISO 639-1 codes
 * (Gutendex's own format), `page` is 1-based (Gutendex paginates in fixed-size
 * pages). `page` is coerced from its string query form.
 */
export const catalogSearchParamsSchema = z.object({
  /** Free-text search over title + author (Gutendex `search`). */
  q: z.string().trim().min(1).optional(),
  /** Subject/bookshelf topic filter (Gutendex `topic`). */
  topic: z.string().trim().min(1).optional(),
  /** Comma-separated ISO 639-1 language codes, e.g. "en" or "en,fr". */
  languages: z.string().trim().min(1).optional(),
  /** 1-based page number. */
  page: z.coerce.number().int().positive().optional(),
  /** Result ordering; defaults to `popular` server-side. */
  sort: catalogSortSchema.optional(),
});
export type CatalogSearchParams = z.infer<typeof catalogSearchParamsSchema>;

/**
 * One catalog result, mapped from a Gutendex book. `id` is the Project
 * Gutenberg id (used as the import handle). `coverUrl` hotlinks the Gutendex
 * `image/jpeg` cover (null → the UI shows a typographic fallback tile).
 * `epubAvailable` is false when the edition has no `application/epub+zip`
 * format, so the UI can hide/disable the import action.
 */
export const catalogBookSchema = z.object({
  id: z.number().int().nonnegative(),
  title: z.string(),
  authors: z.array(z.string()),
  subjects: z.array(z.string()),
  languages: z.array(z.string()),
  coverUrl: z.string().nullable(),
  downloadCount: z.number().int().nonnegative(),
  epubAvailable: z.boolean(),
});
export type CatalogBook = z.infer<typeof catalogBookSchema>;

/**
 * `GET /catalog/gutenberg` response. `count` is the upstream total match count;
 * `nextPage` is the 1-based page to request for "More" (null when the current
 * page is the last one) — the proxy derives it from Gutendex's `next` URL so
 * the client never touches Gutendex directly.
 */
export const catalogSearchResponseSchema = z.object({
  results: z.array(catalogBookSchema),
  count: z.number().int().nonnegative(),
  nextPage: z.number().int().positive().nullable(),
});
export type CatalogSearchResponse = z.infer<typeof catalogSearchResponseSchema>;

/** `POST /library/import` request body: the Gutenberg id to pull in. */
export const importRequestSchema = z.object({
  gutenbergId: z.number().int().positive(),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;
