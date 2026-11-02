import {
  catalogSearchResponseSchema,
  libraryBookSchema,
  type CatalogSearchResponse,
  type LibraryBook,
} from "@ebook-reader/shared";

import { apiFetch } from "../lib/api-client";

/**
 * Catalog API calls. Thin wrappers over the Fastify catalog
 * routes from the (already-built) chunk 22a backend; responses are validated
 * against the shared Zod contract, same pattern as `lib/library-api.ts`.
 */

/** Params accepted by `GET /catalog/gutenberg` — mirrors the route's search schema. */
export interface CatalogQuery {
  q?: string;
  topic?: string;
  /** Comma-separated ISO 639-1 codes (the route's `languages` param). */
  languages?: string;
  /** 1-based page number. */
  page?: number;
}

/** `GET /catalog/gutenberg` — an empty query lands on the server's popular list. */
export async function fetchCatalog(query: CatalogQuery): Promise<CatalogSearchResponse> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.topic) params.set("topic", query.topic);
  if (query.languages) params.set("languages", query.languages);
  if (query.page) params.set("page", String(query.page));
  const qs = params.toString();
  const res = await apiFetch(`/catalog/gutenberg${qs ? `?${qs}` : ""}`);
  return catalogSearchResponseSchema.parse(await res.json());
}

/** `POST /library/import` — pull one Gutenberg book into the library; returns the new card. */
export async function importCatalogBook(gutenbergId: number): Promise<LibraryBook> {
  const res = await apiFetch("/library/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gutenbergId }),
  });
  return libraryBookSchema.parse(await res.json());
}
