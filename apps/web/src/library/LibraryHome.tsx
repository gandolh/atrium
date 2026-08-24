import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LIBRARY_SORTS,
  MEDIA_KINDS,
  type LibraryBook,
  type LibrarySort,
  type MediaKind,
} from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { useDeleteBook, useLibraryList, useOfflineDownload, useUploadBook } from "../lib/use-library";
import { useReconnectProgressSync } from "../lib/use-progress-sync";
import { STAGGER_MS, motionTransition, usePrefersReducedMotion } from "../lib/motion";
import { AppHeader } from "../components/AppHeader";
import { QuietSelect } from "../components/QuietSelect";
import { KindChips, StorageCaption, type KindChoice } from "./LibraryHeader";
import { UploadZone, type UploadZoneHandle } from "./UploadZone";
import { ContinueReading, pickResumeBook } from "./ContinueReading";
import { CoverCard } from "./CoverCard";
import { OfflineBanner } from "./OfflineBanner";

/**
 * **The** home (brief 28, D33 move 1): one gallery of the whole library, with
 * media kind demoted from an address to a filter chip that carries a count.
 *
 * This replaces `LibraryArea` and the three per-type areas it backed (`/books`
 * `/music` `/videos`, brief 25) — deliberately reversing D32/brief 25's IA. The
 * per-area config table is gone with it: there is one heading, one empty state,
 * one Add affordance and one grid, and `?kind` (absent = all kinds) narrows what
 * the grid shows. Brief 21's Shelves ⇄ Stacks grouping is gone too (D33h); the
 * `author`/`series`/`subject` columns it read stay populated and now feed chips
 * and search instead (`grouping.ts` survives for brief 30).
 *
 * The filter lives in the URL, not in state, so Back / refresh / share all
 * round-trip it, and the old area paths can redirect onto it (see router.tsx).
 */

const SORT_LABELS: Record<LibrarySort, string> = {
  recent: "Recent",
  title: "Title",
  author: "Author",
};

const KIND_LABELS: Record<MediaKind, string> = {
  book: "Books",
  audio: "Music",
  video: "Video",
};

/**
 * The one grid, holding all three card shapes at once (book 2:3, music 1:1,
 * video 16:9 — kept from brief 25).
 *
 * `grid-flow-row-dense` + a **two-column span for video** is what keeps rows
 * from going ragged: a 16:9 tile is about as wide as two portrait tiles, so it
 * consumes two column slots instead of stretching one and leaving a hole, and
 * dense placement back-fills any slot a wide tile skips past. Column counts are
 * even numbers at every breakpoint so a two-slot tile can never orphan a
 * single-slot column at the end of a row.
 */
const GRID =
  "grid grid-flow-row-dense grid-cols-2 items-start gap-x-gutter gap-y-8 sm:grid-cols-4 xl:grid-cols-6";

/** Video tiles are landscape — two column slots wide (see `GRID`). */
function cellSpan(book: LibraryBook): string | undefined {
  return (book.kind ?? "book") === "video" ? "col-span-2" : undefined;
}

export function LibraryHome() {
  // The home themes with the shared reader theme (header toggle drives it).
  useApplyTheme();

  const navigate = useNavigate();
  // The kind filter is a URL concern (brief 28): `?kind`, validated in
  // router.tsx against the shared `mediaKindSchema`, absent = every kind.
  const { kind } = useSearch({ from: "/" });

  const [sort, setSort] = useState<LibrarySort>("recent");

  const { books, isOffline, isLoading, isError, refetch } = useLibraryList(sort);
  const offlineDownload = useOfflineDownload();
  useReconnectProgressSync(books);

  const upload = useUploadBook();
  const remove = useDeleteBook();
  const uploadHandle = useRef<UploadZoneHandle | null>(null);
  const reduced = usePrefersReducedMotion();

  // Chip counts come from the **loaded list**, not from a separate query, so a
  // chip can never disagree with the grid it filters. `kind` is defensively
  // defaulted for any pre-brief-23 cached row that predates the field.
  const chips = useMemo<KindChoice[]>(() => {
    const byKind = new Map<MediaKind, number>(MEDIA_KINDS.map((k) => [k, 0]));
    for (const book of books) {
      const bookKind = book.kind ?? "book";
      byKind.set(bookKind, (byKind.get(bookKind) ?? 0) + 1);
    }
    return [
      { kind: undefined, label: "All", count: books.length },
      ...MEDIA_KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k], count: byKind.get(k) ?? 0 })),
    ];
  }, [books]);

  const visible = useMemo(
    () => (kind ? books.filter((b) => (b.kind ?? "book") === kind) : books),
    [books, kind],
  );

  const libraryEmpty = books.length === 0;
  const hasItems = visible.length > 0;

  // Resume follows the active filter — filtering to Music and being offered a
  // book to resume would be the filter lying.
  const resumeBook = useMemo(() => pickResumeBook(visible), [visible]);

  // Navigate immediately — /read's hydrate hook does the download + progress UI.
  const openBook = useCallback(
    (book: LibraryBook) => {
      void navigate({ to: "/read", search: { format: book.format, book: book.id } });
    },
    [navigate],
  );

  const renderCover = useCallback(
    (book: LibraryBook): ReactNode => (
      <CoverCard
        book={book}
        onOpen={openBook}
        onDelete={(b) => remove.mutate(b)}
        deleteDisabled={isOffline}
        offline={
          offlineDownload.isSupported
            ? {
                state: offlineDownload.stateOf(book.id),
                progress: offlineDownload.progressOf(book.id),
                canDownload: !isOffline,
                onDownload: () => offlineDownload.download(book),
                onRemove: () => offlineDownload.remove(book.id),
              }
            : undefined
        }
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOffline, offlineDownload, remove, openBook],
  );

  const browse = () => uploadHandle.current?.browse();

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-page py-8 text-ink">
      <AppHeader
        caption={
          <StorageCaption
            storage={offlineDownload.storage}
            downloadedCount={offlineDownload.downloaded.length}
          />
        }
        actions={
          <>
            {/* Discover is reached from the Add flow now (brief 28 item 7), not
                from a Books area: importing from a catalog is the other half of
                "add something", so it sits beside Add rather than in a nav. */}
            <Link
              to="/discover"
              className="rounded-card border border-line-soft/70 px-4 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              Browse catalogs
            </Link>
            {!libraryEmpty && (
              <button
                type="button"
                onClick={browse}
                disabled={upload.isPending || isOffline}
                title={isOffline ? "Requires connection" : undefined}
                className="rounded-card bg-ink-fill px-4 py-2 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:bg-paper-container disabled:text-ink-variant"
              >
                {upload.isPending ? "Uploading…" : "+ Add"}
              </button>
            )}
          </>
        }
      />

      {isOffline && <OfflineBanner />}

      {/* Ambient uploader: the header "Add" button and the whole-window drag
          target handle uploads, and an empty library shows its own empty state
          below (with its own Add button) — no redundant giant dropzone
          competing with it. */}
      <UploadZone
        onFile={(file) => upload.mutate(file)}
        busy={upload.isPending}
        disabled={isOffline}
        variant="ambient"
        browseRef={uploadHandle}
      />

      {upload.isError && (
        <p role="alert" className="-mt-4 rounded-card border border-danger/40 bg-danger-soft/50 px-4 py-2.5 text-sm text-danger">
          Upload failed. Is the API running? Please try again.
        </p>
      )}

      {resumeBook && <ContinueReading book={resumeBook} onOpen={openBook} />}

      <section aria-label="Library" className="flex flex-col gap-5">
        <h1 className="font-display text-4xl leading-[1.05] font-medium tracking-[-0.03em] text-ink md:text-[2.75rem]">
          Your library
        </h1>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
          {/* Chips replace the nav tabs AND the Group by / view controls. */}
          <KindChips active={kind} choices={chips} />
          {!libraryEmpty && (
            <QuietSelect
              label="Sort by"
              value={sort}
              onChange={setSort}
              options={LIBRARY_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
            />
          )}
        </div>

        {isLoading ? (
          <GallerySkeleton />
        ) : isError ? (
          <EmptyState
            title="Couldn't load your library"
            body="The API may be offline. Start it with npm run dev and refresh."
            action={
              <button
                type="button"
                onClick={refetch}
                className="rounded-card border border-line-soft px-4 py-1.5 text-sm font-medium text-ink-variant transition hover:text-ink"
              >
                Try again
              </button>
            }
          />
        ) : libraryEmpty ? (
          <EmptyState
            title="Nothing here yet"
            body="Add a book, a track or a video and it shows up here as a cover — or import a free classic from a catalog."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={browse}
                  disabled={isOffline}
                  className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Add a file
                </button>
                <Link
                  to="/discover"
                  className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Browse free classics
                </Link>
              </div>
            }
          />
        ) : !hasItems ? (
          // The library has things in it, just none of this kind — a filter
          // result, not an empty library, so the way out is "show everything".
          <EmptyState
            title={kind ? `No ${KIND_LABELS[kind].toLowerCase()} yet` : "Nothing here yet"}
            body="Nothing in your library matches this filter."
            action={
              <Link
                to="/"
                search={{ kind: undefined }}
                className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                Show everything
              </Link>
            }
          />
        ) : (
          <div className={GRID}>
            {/* Grid re-filter (design.md "Motion"): tiles settle on the system
                curve with a 20ms stagger. `popLayout` pulls a filtered-out tile
                out of flow immediately so the survivors settle at once instead
                of waiting for it, and `layout` moves the survivors rather than
                remounting them (a remount would re-request every cover).
                `usePrefersReducedMotion` + `motionTransition` collapse the whole
                thing to 0ms when the user asks for reduced motion. */}
            <AnimatePresence mode="popLayout" initial={false}>
              {visible.map((book, i) => (
                <motion.div
                  key={book.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={motionTransition("refilter", reduced, {
                    // Ripple across the first screenful only — a linear stagger
                    // over a long library would leave the last tile seconds late.
                    delay: (Math.min(i, 11) * STAGGER_MS) / 1000,
                  })}
                  className={cellSpan(book)}
                >
                  {renderCover(book)}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * The one empty state (no per-area variants). Brief 29 owns its visuals — this
 * is brief 28's markup carried over from `LibraryArea` unchanged, so that brief
 * has one place to restyle. It renders for three cases, all inside the
 * `aria-label="Library"` section below the chips: load error, an empty library,
 * and a filter that matches nothing.
 */
function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-line-soft/50 bg-paper-low/40 px-6 py-16 text-center">
      <p className="font-display text-xl font-semibold text-ink">{title}</p>
      <p className="max-w-md text-ink-variant">{body}</p>
      {action}
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="aspect-[2/3] w-full animate-pulse rounded-cover bg-paper-container" />
          <div className="h-4 w-3/4 animate-pulse rounded-card bg-paper-container" />
          <div className="h-3 w-1/2 animate-pulse rounded-card bg-paper-container" />
        </div>
      ))}
    </div>
  );
}
