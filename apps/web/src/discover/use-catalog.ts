import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchCatalog, importCatalogBook, type CatalogQuery } from "./discover-api";

/**
 * TanStack Query hooks for the `/discover` catalog. The client
 * cache here layers over the server's own 15-minute TTL cache (chunk 22a) —
 * a repeat search inside a render still hits the network once, but the two
 * caches together mean a user paging back and forth rarely re-hits Gutendex.
 */

/** `queryKey` derived from the search params so each distinct query gets its own cache entry. */
export function catalogKey(query: CatalogQuery) {
  return ["catalog", query.q ?? "", query.topic ?? "", query.languages ?? "", query.page ?? 1] as const;
}

export function useCatalogSearch(query: CatalogQuery) {
  return useQuery({
    queryKey: catalogKey(query),
    queryFn: () => fetchCatalog(query),
    // Keep the previous page's results on screen while a new page/filter loads
    // instead of flashing a loading state — there's no infinite scroll here,
    // just a "More" affordance, so a brief hold-over is the quieter choice.
    placeholderData: keepPreviousData,
  });
}

/**
 * Import mutation. Each `CatalogResultCard` instantiates its own so in-flight
 * / success / error state stays per-card. `["library"]` is the same broad key
 * `useUploadBook`/`useDeleteBook` invalidate (lib/use-library.ts) — it covers
 * every sort variant of the library list query the badge cross-reference and
 * the gallery both read.
 */
export function useImportBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (gutenbergId: number) => importCatalogBook(gutenbergId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}
