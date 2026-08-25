import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LibraryBook, LibrarySort } from "@ebook-reader/shared";

import { useActiveProfileId } from "./auth";
import { deleteBook, fetchBookFile, fetchLibrary, uploadBook } from "./library-api";
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
/** Query key for the set of downloaded books (metadata only). */
const offlineBooksKey = ["offline", "books"] as const;
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

/** Downloaded books, as a react-query cache both offline hooks share. */
function useOfflineBooksQuery() {
  return useQuery({
    queryKey: offlineBooksKey,
    queryFn: () => listOfflineBooks(),
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
  const query = useLibrary(sort);
  const offline = useOfflineBooksQuery();

  // Item 6: keep the stored snapshots fresh from every successful live load.
  useEffect(() => {
    if (query.data) void refreshOfflineSnapshots(query.data);
  }, [query.data]);

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
    void qc.invalidateQueries({ queryKey: offlineBooksKey });
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
