import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Format, LibraryBook, MediaKind } from "@ebook-reader/shared";

import { useReaderStore } from "../store/reader-store";
import { fetchBookFile, fetchLibrary } from "./library-api";
import { getLocalProgress, getOfflineBook, offlineRecordToFile, resolveOfflineResume } from "./offline-store";

/**
 * Load the reader's `File` from the library for `/read?book=<id>` — both the
 * cover-card click (which navigates here immediately, brief 10) and a refresh /
 * direct visit (D24) go through this single path. The open `File` lives only in
 * memory; the book id in the URL lets us (re-)fetch it. No-op when the right
 * file is already loaded or there's no `book` id (dev samples).
 *
 * Exposes download `progress` (0–1; `null` = indeterminate) so the route can
 * show a real opening screen, the matched `book` row (title/cover for that
 * screen), and `retry` for the error state.
 *
 * Offline-first (brief 20): this seam checks the offline store BEFORE the
 * network. A downloaded book always opens from its stored blob (no request,
 * works with zero connectivity) and resumes from the local progress record when
 * it's newer than the snapshot. Only a book that was never downloaded hits the
 * network — so "fall back to the stored copy on network failure" is subsumed by
 * checking the store first (a stored book never reaches the network path).
 */
export type HydrateStatus = "idle" | "loading" | "not-found" | "error";

export interface HydrateState {
  status: HydrateStatus;
  /** Download progress 0–1; `null` while indeterminate or not downloading. */
  progress: number | null;
  /** The library row being opened, once the list is known. */
  book: LibraryBook | null;
  /** Re-attempt after `status === "error"`. */
  retry: () => void;
}

/**
 * Decode the wire `locator` into a typed `ReaderLocation` for the store: a page
 * number for PDF, the CFI string for EPUB. `null`/unparseable → start fresh.
 */
function resumeLocation(locator: string | null, format: LibraryBook["format"]): number | string | null {
  if (!locator) return null;
  if (format === "pdf") {
    const page = Number(locator);
    return Number.isFinite(page) && page >= 1 ? page : null;
  }
  return locator;
}

/**
 * The row for `bookId` from ANY already-cached library list.
 *
 * The query below fetches `["library", "recent"]`, but the home fetches
 * `["library", <active sort>]` — so opening a book with Sort = Title or Author
 * left this hook with a cold cache and no row until its own fetch landed. The
 * opening screen needs the row on its FIRST commit: that is where the cover →
 * reader shared-layout morph lands (`routes/read.tsx`), and a null row there
 * means morphing the library cover into an empty tile.
 *
 * A non-reactive cache read is the right shape for exactly that: every
 * `["library", *]` entry holds the same `LibraryBook[]`, only ordered
 * differently, and the live query result below still wins as soon as it
 * arrives.
 */
function cachedLibraryRow(client: QueryClient, bookId: string): LibraryBook | null {
  for (const [, data] of client.getQueriesData<LibraryBook[]>({ queryKey: ["library"] })) {
    const found = data?.find((b) => b.id === bookId);
    if (found) return found;
  }
  return null;
}

export function useHydrateBook(bookId: string | undefined, kind: MediaKind = "book"): HydrateState {
  // Media (brief 23) doesn't hydrate an in-memory `File`: the player streams
  // straight from the authenticated file URL. So for audio/video this hook
  // resolves the library ROW only (title/cover/locator/duration) and skips the
  // reader-specific machinery — the offline blob store and the byte download.
  const isMedia = kind !== "book";
  const queryClient = useQueryClient();
  const loadedFile = useReaderStore((s) => s.loadedFile);
  const loadedBookId = useReaderStore((s) => s.loadedBookId);
  const setLoadedBook = useReaderStore((s) => s.setLoadedBook);
  const [status, setStatus] = useState<HydrateStatus>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  // Bumping this re-runs the fetch effect after a failure.
  const [attempt, setAttempt] = useState(0);
  // Snapshot metadata for a book opened offline, when the live list isn't
  // reachable — lets the opening screen still show a title/cover.
  const [offlineBook, setOfflineBook] = useState<LibraryBook | null>(null);

  // Only fetch the library when we actually need to hydrate: a book id in the
  // URL that isn't already the loaded book. Media never lives in `loadedFile`
  // (no in-memory File), so it hydrates whenever there's a `bookId` — it just
  // needs the row.
  const needsHydrate = isMedia
    ? Boolean(bookId)
    : Boolean(bookId) && (!loadedFile || loadedBookId !== bookId);

  const library = useQuery({
    queryKey: ["library", "recent"],
    queryFn: () => fetchLibrary("recent"),
    enabled: needsHydrate,
  });

  // Reset the offline snapshot whenever the target book changes. The route stays
  // mounted across `/read?book=…` param changes, so without this the snapshot set
  // for a previously-opened downloaded book would linger and could represent a
  // DIFFERENT bookId that isn't offline-stored (stale title/cover on the opening
  // screen). Cleared here; re-set by the hydrate effect only for a real store hit.
  useEffect(() => {
    setOfflineBook(null);
  }, [bookId]);

  // Prefer the live row; fall back to the offline snapshot when the list is
  // unreachable (book opened with no connectivity), then to any already-cached
  // library list (`cachedLibraryRow` — that's what gives the opening screen a
  // cover on its first commit). Guard the snapshot by id so a not-yet-cleared
  // snapshot can never stand in for a different book.
  const book = useMemo(() => {
    const live = library.data?.find((b) => b.id === bookId);
    if (live) return live;
    if (offlineBook && offlineBook.id === bookId) return offlineBook;
    // Only until the live list answers: once it has, a row missing from it is
    // authoritatively gone ("removed from your library"), and a stale entry
    // under another sort key must not resurrect it.
    if (!library.data && bookId) return cachedLibraryRow(queryClient, bookId);
    return null;
  }, [library.data, bookId, offlineBook, queryClient]);

  useEffect(() => {
    if (!needsHydrate || !bookId) {
      setStatus("idle");
      return;
    }

    let cancelled = false;

    // Media path (brief 23): resolve the row from the live list only — no
    // offline-store lookup, no byte download, no reader-store writes. The
    // AudioPlayer/VideoPlayer streams from the file URL and reads the row's
    // locator/duration directly.
    if (isMedia) {
      if (library.isPending) {
        setStatus("loading");
        return;
      }
      if (library.isError) {
        setStatus("error");
        return;
      }
      const found = library.data?.find((b) => b.id === bookId);
      setStatus(found ? "idle" : "not-found");
      return;
    }

    // Offline-first: a downloaded book opens from its stored blob with no
    // network, whether or not we're connected. Resume from the local progress
    // record when it's newer than the snapshot (last-write-wins on this device).
    async function openFromOfflineStore(id: string): Promise<boolean> {
      const record = await getOfflineBook(id);
      if (cancelled || !record) return false;
      const local = await getLocalProgress(id);
      if (cancelled) return false;
      setOfflineBook(record.book);
      const wireLocator = resolveOfflineResume(record, local);
      const initialLocation = resumeLocation(wireLocator, record.format);
      // This path only runs for books (media never reaches the offline store),
      // so `format` is always pdf/epub — narrow the widened FileType to the
      // store's Format.
      setLoadedBook(offlineRecordToFile(record), record.format as Format, record.id, initialLocation);
      setProgress(1);
      setStatus("idle");
      return true;
    }

    setStatus("loading");

    void (async () => {
      try {
        if (await openFromOfflineStore(bookId)) return;
      } catch {
        // Offline store unavailable/errored — fall through to the network path.
      }
      if (cancelled) return;

      // Not downloaded — network path, driven by the react-query library list.
      if (library.isPending) {
        setStatus("loading");
        return;
      }
      if (library.isError) {
        setStatus("error");
        return;
      }
      const found = library.data?.find((b) => b.id === bookId);
      if (!found) {
        setStatus("not-found");
        return;
      }

      // A media row can reach the book path via a stale/absent format guess
      // (`/read?book=<id>` with no format param). The resolved row's `kind` is
      // the authority — bail BEFORE downloading any file bytes; read.tsx sees
      // the same resolved row and re-branches to the audio/video player.
      if (found.kind !== "book") {
        setStatus("idle");
        return;
      }

      setProgress(found.sizeBytes > 0 ? 0 : null);
      // The saved resume position is an opaque locator on the wire: a page number
      // (string) for PDF, a CFI for EPUB. Type it for the reader's ReaderLocation.
      const initialLocation = resumeLocation(found.locator, found.format);
      try {
        const file = await fetchBookFile(found, (fraction) => {
          if (!cancelled) setProgress(fraction);
        });
        // The book path only runs for books (kind === "book"), so `found.format`
        // is always pdf/epub — narrow the widened FileType to the store's Format.
        if (!cancelled) setLoadedBook(file, found.format as Format, found.id, initialLocation);
      } catch {
        if (!cancelled) {
          setProgress(null);
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [needsHydrate, bookId, isMedia, library.isPending, library.isError, library.data, setLoadedBook, attempt]);

  const retry = useCallback(() => {
    // The failure may have been the library list itself — refetch it too.
    if (library.isError) void library.refetch();
    setAttempt((a) => a + 1);
  }, [library]);

  return { status, progress, book, retry };
}
