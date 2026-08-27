import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LibraryBook, LibrarySort } from "@ebook-reader/shared";

import { useActiveProfileId } from "./auth";
import {
  cancelConvert,
  deleteBook,
  deleteBookVersion,
  fetchBookById,
  fetchBookFile,
  fetchBookVersions,
  fetchLibrary,
  startConvert,
  uploadBook,
} from "./library-api";
import {
  deleteOfflineBook,
  getStorageEstimate,
  isOfflineSupported,
  listOfflineBooks,
  putOfflineBook,
  refreshOfflineSnapshots,
  type OfflineBookSummary,
  type StorageEstimate,
} from "./offline-store";

/**
 * React Query hooks for the library (decisions.md D24). The gallery list is a
 * query keyed by sort; upload/delete are mutations that invalidate it so the
 * grid refreshes.
 *
 * Brief 20 adds the offline data layer on top: `useLibraryList` (offline-aware
 * list with a cached fallback + `isOffline` signal) and `useOfflineDownload`
 * (per-book download/remove + storage usage). The original `useLibrary` /
 * `useUploadBook` / `useDeleteBook` shapes are unchanged so existing callers
 * keep working; new UI adopts the offline-aware hooks.
 */

/** Stable empty-list reference so a "nothing to show" render doesn't hand
 *  downstream effects (keyed on `books`) a fresh `[]` every time — that churn is
 *  what made `useReconnectProgressSync` re-fire and double-PATCH. */
const EMPTY_BOOKS: LibraryBook[] = [];
/** Stable empty fallback for the cached-summaries query (see EMPTY_BOOKS). */
const EMPTY_SUMMARIES: OfflineBookSummary[] = [];

/**
 * Library query keys carry the active profile (brief 35 step 7). The list rows
 * are shared across profiles, but each row's `progress` and `locator` are that
 * profile's (D31 as revised by D35) — so a cached list IS profile data, and a
 * key without an identity in it can serve one person's Continue row to another.
 * `switchProfile` clears the cache outright; this is the second line of defence
 * for a cache that survives anyway (persisted, or a fetch that raced the flip).
 *
 * The profile segment sits AFTER `"library"` on purpose: every existing
 * `invalidateQueries({ queryKey: ["library"] })` still prefix-matches, which is
 * what we want — an upload or an import changes the shared library for every
 * profile, not just the active one.
 */
export const libraryKey = (profileId: string | null, sort: LibrarySort) =>
  ["library", profileId, sort] as const;
/** Prefix matching every sort variant of ONE profile's library list. */
export const libraryProfileKey = (profileId: string | null) => ["library", profileId] as const;
/**
 * Query key for ONE book's live row, by id (D34's convert status poll — see
 * `useConvertingBook` below). Deliberately NOT profile-scoped like `libraryKey`:
 * `convertStatus`/`convertedFrom`/`convertedTo`/`convertError` are properties
 * of the BOOK, shared across every profile the same way the library itself is
 * (D30/D35) — only `progress`/`locator` are per-profile, and this poll doesn't
 * read either.
 */
const bookKey = (id: string) => ["library", "book", id] as const;

/**
 * Query key for the set of downloaded books (metadata only). The DOWNLOADS are
 * device-scoped (decision 7) but each row's `progress`/`locator` is composed
 * from the active profile's progress record (brief 35 fix), so the cached list
 * IS profile data — same reasoning as `libraryKey` above.
 */
const offlineBooksKey = (profileId: string | null) => ["offline", "books", profileId] as const;
/** Prefix matching every profile's downloaded-books query (for invalidation). */
const offlineBooksPrefix = ["offline", "books"] as const;
/** Query key for the storage-usage estimate. */
const offlineStorageKey = ["offline", "storage"] as const;

export function useLibrary(sort: LibrarySort) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: libraryKey(profileId, sort),
    queryFn: () => fetchLibrary(sort),
  });
}

export function useUploadBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadBook(file),
    onSuccess: () => {
      // Deliberately the broad prefix, not `libraryProfileKey(active)`: the
      // library is shared across profiles as it is across users (D30/D35), so a
      // new book belongs to every profile's list. Same below and in
      // `useImportBook`.
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useDeleteBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (book: LibraryBook) => deleteBook(book.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

/**
 * Live convert status for a SOURCE book (D34 decisions 8/9) — the data layer
 * behind the reader's `ConvertControl`.
 *
 * Polls `GET /library/:id` at a **flat 30s** interval, but ONLY while the last
 * known status reads `"running"`; every other status disables the interval
 * outright. This is deliberately driven by the fetched row, never by a
 * client-side "I started this conversion" flag — decision 9's whole point is
 * that a tab that started the job, a tab that didn't, a refresh, and a reopen
 * hours later must all behave identically, because they all just ask the
 * server "is this still running?" and get the same honest answer. A book
 * nobody is converting therefore polls zero times, forever, until something
 * (this tab's own start, or another tab's) flips it to `running` again and a
 * refetch of THIS query picks that up.
 *
 * `seed` is whatever the caller already has (the hydrated book, a library-list
 * row) so the control never flashes an unknown state on mount — but it is not
 * trusted as fresh: the query has no `staleTime`, so mounting always fires one
 * real fetch, which is what lets "closed the app mid-conversion, reopened"
 * resume polling on its own rather than waiting up to 30s to notice.
 */
export function useConvertingBook(seed: LibraryBook) {
  return useQuery({
    queryKey: bookKey(seed.id),
    queryFn: () => fetchBookById(seed.id),
    initialData: seed,
    refetchInterval: (query) => (query.state.data?.convertStatus === "running" ? 30_000 : false),
  });
}

/**
 * `POST /library/:id/convert` as a mutation (D34). Always called WITHOUT
 * `force` — see the module comment on `startConvert` in `library-api.ts` for
 * why `ConvertControl` never offers a force-based re-run. Invalidates the
 * book's own query so the next render reflects whatever the server actually
 * did (started, or the no-op 200), rather than branching on the response body.
 */
export function useStartConvert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => startConvert(id),
    onSuccess: (_result, id) => {
      void qc.invalidateQueries({ queryKey: bookKey(id) });
    },
  });
}

/**
 * `DELETE /library/:id/convert` as a mutation — `ConvertControl`'s Cancel
 * action while `convertStatus === "running"` (D34 decision 5). Invalidates the
 * book's query; the source resets to `none` synchronously on the server
 * (convert-jobs.ts), so the very next fetch already reflects it.
 */
export function useCancelConvert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelConvert(id),
    onSuccess: (_result, id) => {
      void qc.invalidateQueries({ queryKey: bookKey(id) });
    },
  });
}

// --- Document versions (brief 38 step 7 — the reader's version picker) -----

/**
 * Query key for one book's version list. NOT profile-scoped like `libraryKey`
 * — `versions` (id/versionNo/publishedAt/sizeBytes) are properties of the
 * BOOK, shared across every profile the same way the library itself is. Only
 * `currentVersionId` inside the response is per-profile, which is exactly why
 * this key is invalidated (never persisted across a profile switch via
 * `staleTime`) rather than trusted indefinitely.
 */
const bookVersionsKey = (bookId: string) => ["library", "book-versions", bookId] as const;

/**
 * `GET /library/:id/versions` (the version picker's data). `enabled` lets the
 * caller gate the request on `book.source === "latex"` — every other book
 * source answers `{ versions: [], currentVersionId: null }` truthfully, but
 * there is no reason to ask for every ordinary upload opened in the reader.
 */
export function useBookVersions(bookId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: bookVersionsKey(bookId ?? ""),
    queryFn: () => fetchBookVersions(bookId as string),
    enabled: Boolean(bookId) && enabled,
  });
}

/**
 * Delete one version (brief 38 step 7, decision 11). Invalidates this book's
 * version list so the picker catches up. Deliberately does NOT invalidate the
 * broad `["library"]` prefix itself — deleting a version that was NOT the
 * book's last one changes nothing about the gallery card; the caller (the
 * version picker) is the one that knows whether this delete emptied the book
 * and, if so, invalidates the library list itself (decision 11: last version
 * gone means the whole entry is gone server-side too).
 */
export function useDeleteBookVersion(bookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => deleteBookVersion(bookId, versionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bookVersionsKey(bookId) });
    },
  });
}

/** Downloaded books, as a react-query cache both offline hooks share. */
function useOfflineBooksQuery() {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: offlineBooksKey(profileId),
    queryFn: () => listOfflineBooks(profileId),
    // The offline set only changes via our own download/remove mutations, which
    // invalidate this key; no need to refetch on focus.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * Offline-aware library list (brief item 4, data side).
 *
 * - Server reachable → serves the live rows; opportunistically refreshes the
 *   stored snapshots of any downloaded books (brief item 6).
 * - Server unreachable → falls back to the downloaded books' cached snapshots
 *   and raises `isOffline`. The UI renders these rows with an offline banner and
 *   disables online-only actions (upload/delete/convert).
 *
 * `isOffline` means "showing cached rows because the library fetch failed"
 * (combined with `navigator.onLine`, which the UI can also read to pre-disable
 * actions). `isError` is reserved for "fetch failed AND nothing cached to show".
 */
export interface LibraryListResult {
  /** Rows to render: live server list, or cached snapshots when offline. */
  books: LibraryBook[];
  /** True when serving cached snapshots because `GET /library` failed. */
  isOffline: boolean;
  /** True during the initial load with nothing to show yet. */
  isLoading: boolean;
  /** True when the fetch failed AND there are no cached rows to fall back to. */
  isError: boolean;
  /** Re-attempt the library fetch. */
  refetch: () => void;
}

export function useLibraryList(sort: LibrarySort): LibraryListResult {
  const profileId = useActiveProfileId();
  const query = useLibrary(sort);
  const offline = useOfflineBooksQuery();

  // Item 6: keep the stored snapshots fresh from every successful live load.
  // The rows were fetched AS `profileId`, so their positions are seeded into
  // that profile's own progress records while the shared metadata goes into the
  // device-scoped snapshot — see `refreshOfflineSnapshots`.
  useEffect(() => {
    if (query.data) void refreshOfflineSnapshots(query.data, profileId);
  }, [query.data, profileId]);

  const serverBooks = query.data ?? null;
  const cachedBooks = offline.data ?? EMPTY_SUMMARIES;

  // Fall back to cached downloads only when there's no live data AND the fetch
  // errored (or the browser reports offline) AND we actually have something
  // cached to show.
  const fellBack =
    !serverBooks &&
    (query.isError || (typeof navigator !== "undefined" && !navigator.onLine)) &&
    cachedBooks.length > 0;

  // Stabilize the rows reference. `query.data` is already a stable reference
  // across renders (react-query), but the offline fallback maps summaries down
  // to the `LibraryBook` wire shape — memoize so the array identity only changes
  // when the underlying data does. Otherwise every render hands a fresh array to
  // effects keyed on `books` (`useReconnectProgressSync`), re-firing the flush.
  const books = useMemo<LibraryBook[]>(() => {
    if (serverBooks) return serverBooks;
    return fellBack ? cachedBooks.map((b) => b.book) : EMPTY_BOOKS;
  }, [serverBooks, fellBack, cachedBooks]);

  const refetch = useCallback(() => void query.refetch(), [query]);

  return {
    books,
    isOffline: fellBack,
    isLoading: !serverBooks && query.isLoading && !fellBack,
    isError: !serverBooks && query.isError && !fellBack,
    refetch,
  };
}

/** Per-book download lifecycle state the toggle UI renders. */
export type OfflineDownloadStatus = "idle" | "downloading" | "downloaded" | "error";

/**
 * Offline download manager (brief item 2, data side). Exposes which books are
 * downloaded, per-book download state + progress, storage usage, and the
 * download/remove actions.
 *
 * State transitions the UI can rely on:
 *   idle → downloading (`progressOf` reports the 0–1 fetch fraction, or null
 *   while indeterminate) → downloaded (persisted) ; downloading → error on
 *   failure (a retry just calls `download` again).
 */
export interface OfflineDownloadManager {
  /** Whether IndexedDB is available at all (UI hides the toggle if not). */
  isSupported: boolean;
  /** Ids of books currently downloaded. */
  downloadedIds: Set<string>;
  /** Metadata of downloaded books (newest first), e.g. for a "downloads" view. */
  downloaded: OfflineBookSummary[];
  /** Storage usage estimate, or null when unavailable. */
  storage: StorageEstimate | null;
  /** Lifecycle state for a given book id. */
  stateOf: (id: string) => OfflineDownloadStatus;
  /** In-flight download fraction (0–1, or null when indeterminate); undefined when not downloading. */
  progressOf: (id: string) => number | null | undefined;
  /** Start (or retry) downloading a book for offline reading. */
  download: (book: LibraryBook) => void;
  /** Remove a downloaded book, freeing its storage. */
  remove: (id: string) => void;
}

interface InFlight {
  status: "downloading" | "error";
  progress: number | null;
}

export function useOfflineDownload(): OfflineDownloadManager {
  const qc = useQueryClient();
  const offline = useOfflineBooksQuery();
  const storage = useQuery({
    queryKey: offlineStorageKey,
    queryFn: () => getStorageEstimate(),
    staleTime: 5_000,
  });

  // Transient per-book download progress/error, keyed by id. Lives in component
  // state (not the persisted store) — it only matters while a download runs.
  const [inFlight, setInFlight] = useState<Record<string, InFlight>>({});

  const downloaded = offline.data ?? [];
  const downloadedIds = new Set(downloaded.map((b) => b.id));

  const invalidate = useCallback(() => {
    // The broad prefix: a download/removal changes the device's set for every
    // profile's view of it, not just the active one.
    void qc.invalidateQueries({ queryKey: offlineBooksPrefix });
    void qc.invalidateQueries({ queryKey: offlineStorageKey });
  }, [qc]);

  const download = useCallback(
    (book: LibraryBook) => {
      if (!isOfflineSupported()) return;
      setInFlight((m) => ({ ...m, [book.id]: { status: "downloading", progress: book.sizeBytes > 0 ? 0 : null } }));
      void (async () => {
        try {
          const file = await fetchBookFile(book, (fraction) => {
            setInFlight((m) => ({ ...m, [book.id]: { status: "downloading", progress: fraction } }));
          });
          await putOfflineBook(book, file);
          // Success: drop the transient entry; the query now reports it downloaded.
          setInFlight((m) => {
            const next = { ...m };
            delete next[book.id];
            return next;
          });
          invalidate();
        } catch {
          setInFlight((m) => ({ ...m, [book.id]: { status: "error", progress: null } }));
        }
      })();
    },
    [invalidate],
  );

  const remove = useCallback(
    (id: string) => {
      void (async () => {
        try {
          await deleteOfflineBook(id);
          setInFlight((m) => {
            const next = { ...m };
            delete next[id];
            return next;
          });
        } catch {
          // Deletion failed: surface an error state on the toggle instead of an
          // unhandled rejection. `stateOf` reads `inFlight` first, so the card
          // reflects the failure rather than a false "removed".
          setInFlight((m) => ({ ...m, [id]: { status: "error", progress: null } }));
        } finally {
          // Re-read the offline set either way — on success it drops the row, on
          // failure it confirms the book is still downloaded (no stale UI).
          invalidate();
        }
      })();
    },
    [invalidate],
  );

  const stateOf = useCallback(
    (id: string): OfflineDownloadStatus => {
      const flight = inFlight[id];
      if (flight) return flight.status;
      return downloadedIds.has(id) ? "downloaded" : "idle";
    },
    // downloadedIds is derived fresh each render from offline.data.
    [inFlight, offline.data],
  );

  const progressOf = useCallback(
    (id: string): number | null | undefined => inFlight[id]?.progress,
    [inFlight],
  );

  return {
    isSupported: isOfflineSupported(),
    downloadedIds,
    downloaded,
    storage: storage.data ?? null,
    stateOf,
    progressOf,
    download,
    remove,
  };
}
