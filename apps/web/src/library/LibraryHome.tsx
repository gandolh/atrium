import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LIBRARY_SORTS, MEDIA_KINDS, type LibraryBook, type LibrarySort, type MediaKind } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { useDeleteBook, useLibraryList, useOfflineDownload, useUploadQueue } from "../lib/use-library";
import { useReconnectProgressSync } from "../lib/use-progress-sync";
import { STAGGER_MS, motionTransition, usePrefersReducedMotion } from "../lib/motion";
import { AppHeader } from "../components/AppHeader";
import { BUTTON, BUTTON_SOLID } from "../components/button-styles";
import { PAGE_FRAME, PAGE_TITLE } from "../components/page-frame";
import { PlusIcon } from "../components/places";
import { QuietSelect } from "../components/QuietSelect";
import { KindChips, StorageCaption, type KindChoice } from "./LibraryHeader";
import { LibrarySearchField } from "./LibrarySearchField";
import { matchesQuery } from "./search";
import { UploadZone, type UploadZoneHandle } from "./UploadZone";
import { ContinueReading, pickResumeBooks } from "./ContinueReading";
import { CoverCard, type CoverDiscordProps } from "./CoverCard";
import { useAddToQueue, useJukeboxPlayers } from "../jukebox/use-jukebox";
import { OfflineBanner } from "./OfflineBanner";

/**
 * **The** home (D33 move 1): one gallery of the whole library, with
 * media kind demoted from an address to a filter chip that carries a count.
 *
 * This replaces `LibraryArea` and the three per-type areas it backed (`/books`
 * `/music` `/videos`) — deliberately reversing D32/the per-type areas's IA. The
 * per-area config table is gone with it: there is one heading, one empty state,
 * one Add affordance and one grid, and `?kind` (absent = all kinds) narrows what
 * the grid shows. Library grouping's Shelves ⇄ Stacks grouping is gone too (D33h); the
 * `author`/`series`/`subject` columns it read stay populated and now feed chips
 * and search instead (`grouping.ts` survives for cross-library search).
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
 * video 16:9 — kept from the per-type areas).
 *
 * `grid-flow-row-dense` + a **two-column span for video** is what keeps rows
 * from going ragged: a 16:9 tile is about as wide as two portrait tiles, so it
 * consumes two column slots instead of stretching one and leaving a hole, and
 * dense placement back-fills any slot a wide tile skips past. The columns fill
 * the width: six 154 px tiles at 1280 (inside the 1152 px cap), two at 360 and
 * 390, four at 768, so a phone never hides a cover behind a fixed count.
 */
const GRID =
  "grid grid-flow-row-dense grid-cols-[repeat(auto-fill,minmax(150px,1fr))] items-start gap-x-3 gap-y-3 min-[821px]:grid-cols-[repeat(auto-fill,minmax(152px,1fr))] min-[821px]:gap-y-4";

/** Video tiles are landscape — two column slots wide (see `GRID`). */
function cellSpan(book: LibraryBook): string | undefined {
  return (book.kind ?? "book") === "video" ? "col-span-2" : undefined;
}

/** Cross-library search's spec: debounce keystrokes before writing `?q` (mirrors `/discover`'s own 300ms box, just snappier). */
const SEARCH_DEBOUNCE_MS = 120;

export function LibraryHome() {
  // The home themes with the shared reader theme (header toggle drives it).
  useApplyTheme();

  const navigate = useNavigate();
  // The kind filter is a URL concern: `?kind`, validated in
  // router.tsx against the shared `mediaKindSchema`, absent = every kind.
  // `q` is the cross-library search text, same treatment.
  const { kind, q } = useSearch({ from: "/" });
  const query = q ?? "";

  // The field's own (undebounced) text, mirroring `/discover`'s search box:
  // typing updates this immediately for a responsive field, and a short
  // debounce is what actually writes `?q` (and so re-filters the grid).
  const [searchInput, setSearchInput] = useState(query);

  // The last `?q` value this component itself wrote, so the resync below can
  // tell an OUTSIDE change (back/forward nav, a shared link, "Show everything")
  // from the echo of our own debounced write. Without that distinction the
  // resync clobbered what the user was mid-way through typing: we write the
  // TRIMMED query, so typing "the " and pausing snapped the field back to
  // "the", and the next keystrokes produced "thehobbit" — a multi-word search
  // could never be typed.
  const lastWrittenQuery = useRef(query);

  // Resync when `?q` changes for a reason other than our own debounced write
  // — back/forward nav, a shared link, or the "Show everything" action below.
  useEffect(() => {
    if (query === lastWrittenQuery.current) return;
    lastWrittenQuery.current = query;
    setSearchInput(query);
  }, [query]);

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === query) return;
    const id = window.setTimeout(() => {
      lastWrittenQuery.current = trimmed;
      void navigate({
        to: "/",
        search: (prev) => ({ ...prev, q: trimmed || undefined }),
        replace: true,
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const [sort, setSort] = useState<LibrarySort>("recent");

  const { books, isOffline, isLoading, isError, refetch } = useLibraryList(sort);
  const offlineDownload = useOfflineDownload();
  // `isOffline` gates the flush: the fallback rows are this device's own cached
  // snapshots, not the server's answer — see `useReconnectProgressSync`.
  useReconnectProgressSync(books, isOffline);

  // Several files upload one after another; one file is a queue of one.
  const uploads = useUploadQueue();
  const uploading = uploads.progress !== null;
  const uploadLabel =
    uploads.progress && uploads.progress.total > 1
      ? `Adding ${uploads.progress.current} of ${uploads.progress.total}…`
      : "Uploading…";
  const remove = useDeleteBook();
  // "Add to Discord queue" on music tiles. One fetch, no polling:
  // the guilds the bot is in rarely change while the home is open.
  const jukeboxPlayers = useJukeboxPlayers({ poll: false });
  const queueOnDiscord = useAddToQueue();
  const discord = useMemo<CoverDiscordProps | undefined>(() => {
    const players = jukeboxPlayers.data ?? [];
    if (players.length === 0) return undefined;
    return {
      players,
      onAdd: async (book, guildId) => {
        await queueOnDiscord.mutateAsync({ guildId, args: { bookId: book.id, at: "end" } });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jukeboxPlayers.data]);
  const uploadHandle = useRef<UploadZoneHandle | null>(null);
  const reduced = usePrefersReducedMotion();

  // The trimmed `query` is what actually filters; `searchInput` is only the
  // field's (undebounced) display text.
  const trimmedQuery = query.trim();

  // Chip counts come from the **query-filtered** set when a query is active,
  // so a chip that says N actually yields N — with no query, they describe
  // the whole library (round 2 fix: a chip used to advertise whole-library
  // counts while the grid was already narrowed by an active search, so
  // clicking a nonzero chip could still land on "No matches"). `kind` is
  // defensively defaulted for any pre-brief-23 cached row that predates the
  // field.
  const chips = useMemo<KindChoice[]>(() => {
    const scoped = trimmedQuery ? books.filter((b) => matchesQuery(b, trimmedQuery)) : books;
    const byKind = new Map<MediaKind, number>(MEDIA_KINDS.map((k) => [k, 0]));
    for (const book of scoped) {
      const bookKind = book.kind ?? "book";
      byKind.set(bookKind, (byKind.get(bookKind) ?? 0) + 1);
    }
    return [
      { kind: undefined, label: "All", count: scoped.length },
      ...MEDIA_KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k], count: byKind.get(k) ?? 0 })),
    ];
  }, [books, trimmedQuery]);

  // `visible` is what the grid actually shows — kind AND query, both
  // narrowing the same list, same scoping the chips above
  // now share.
  const visible = useMemo(() => {
    const byKind = kind ? books.filter((b) => (b.kind ?? "book") === kind) : books;
    return trimmedQuery ? byKind.filter((b) => matchesQuery(b, trimmedQuery)) : byKind;
  }, [books, kind, trimmedQuery]);

  const libraryEmpty = books.length === 0;
  const hasItems = visible.length > 0;

  // Resume follows the active filter — filtering to Music and being offered a
  // book to resume would be the filter lying.
  const resumeBooks = useMemo(() => pickResumeBooks(visible), [visible]);

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
        lookupDisabled={isOffline}
        discord={discord}
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
    [isOffline, offlineDownload, remove, openBook, discord],
  );

  const browse = () => uploadHandle.current?.browse();
  // The Add button: in the band at 1280, and as half of the matched pair under the title on a phone.
  const addButton = (
    <button
      type="button"
      onClick={browse}
      disabled={uploading || isOffline}
      title={isOffline ? "Requires connection" : undefined}
      className={`${BUTTON_SOLID} max-[820px]:h-12 max-[820px]:w-full`}
    >
      <PlusIcon />
      {uploading ? uploadLabel : "Add"}
    </button>
  );
  const sortSelect = !libraryEmpty && (
    <QuietSelect
      label="Sort by"
      value={sort}
      onChange={setSort}
      options={LIBRARY_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
    />
  );

  return (
    <main className={`${PAGE_FRAME} gap-5 text-ink`}>
      <AppHeader
        caption={
          <StorageCaption storage={offlineDownload.storage} downloadedCount={offlineDownload.downloaded.length} />
        }
        search={
          // No point offering search over an empty library — mirrors the
          // header Add button and the ambient uploader, both gated the same way.
          !libraryEmpty && (
            <LibrarySearchField
              value={searchInput}
              onChange={setSearchInput}
              resultsSummary={
                trimmedQuery
                  ? `${visible.length} ${visible.length === 1 ? "result" : "results"} for ${trimmedQuery}`
                  : undefined
              }
            />
          )
        }
        actions={!libraryEmpty && addButton}
      />

      {isOffline && <OfflineBanner />}

      {/* Ambient uploader (populated library only): the header "Add"
          button and the whole-window drag target handle uploads with no
          visible box competing with the grid. An empty library mounts its own
          `variant="hero"` UploadZone below instead — never both at once, since
          each instance runs its own window-level drag listener and a
          simultaneous second one would double-fire a single drop. */}
      {!libraryEmpty && (
        <UploadZone
          onFiles={uploads.add}
          busy={uploading}
          busyLabel={uploadLabel}
          disabled={isOffline}
          variant="ambient"
          browseRef={uploadHandle}
        />
      )}

      {uploads.failed.length > 0 && (
        <p
          role="alert"
          className="rounded-card border border-danger bg-danger-soft px-4 py-2.5 text-ui font-normal text-danger"
        >
          {uploads.failed.length === 1
            ? `Upload failed: ${uploads.failed[0]}. Is the API running? Please try again.`
            : `Couldn't add ${uploads.failed.length} files: ${uploads.failed.join(", ")}. Is the API running? Please try again.`}
        </p>
      )}

      <ContinueReading books={resumeBooks} onOpen={openBook} />

      <section aria-label="Library" className="flex flex-col gap-5 max-[820px]:gap-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className={PAGE_TITLE}>Your library</h1>
          {/* On a phone Sort by sits at the title row's right end; at 1280 it ends the chips row below. */}
          <div className="min-[821px]:hidden">{sortSelect}</div>
        </div>

        {/* A matched 48 px pair on a phone: Browse catalogs is the rail's at 1280. */}
        {!libraryEmpty && (
          <div className="grid grid-cols-2 gap-3 min-[821px]:hidden">
            <Link to="/discover" className={`${BUTTON} h-12 w-full`}>
              Browse catalogs
            </Link>
            {addButton}
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          {/* Chips replace the nav tabs AND the Group by / view controls. */}
          <KindChips active={kind} choices={chips} />
          <div className="max-[820px]:hidden">{sortSelect}</div>
        </div>

        {/* Count + clear: only while a search is active — the
            kind chips already carry their own counts, so this line is purely
            about the query on top of them. */}
        {trimmedQuery && !isLoading && !isError && (
          <div className="-mt-2 flex items-center justify-between gap-3">
            <p className="font-ui text-ui font-normal text-ink-variant">
              {visible.length} {visible.length === 1 ? "result" : "results"} for “{trimmedQuery}”
            </p>
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="rounded-sm font-ui text-ui font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              Clear search
            </button>
          </div>
        )}

        {isLoading ? (
          <GallerySkeleton />
        ) : isError ? (
          <EmptyState
            title="Couldn't load your library"
            body="The API may be offline. Start it with npm run dev and refresh."
            action={
              <button type="button" onClick={refetch} className={BUTTON}>
                Try again
              </button>
            }
          />
        ) : libraryEmpty ? (
          // The ONLY place the dashed dropzone still lives (the tiles and Continue row's "a
          // dropzone that leaves") — everywhere else, upload is the header
          // Add button plus window-level drag-and-drop (the `UploadZone
          // variant="ambient"` above). The greeting sits above it; "Browse
          // Gutenberg" is the secondary way in for someone with nothing to
          // drag yet.
          <div className="flex flex-col items-center gap-5 py-4 text-center">
            <div className="flex flex-col gap-1.5">
              <p className="font-display text-display-phone font-medium text-ink">Nothing here yet</p>
              <p className="max-w-md text-ink-variant">
                Add a book, a track or a video and it shows up here as a cover — or import a free classic from Project
                Gutenberg.
              </p>
            </div>
            <div className="w-full max-w-xl">
              <UploadZone
                onFiles={uploads.add}
                busy={uploading}
                busyLabel={uploadLabel}
                disabled={isOffline}
                variant="hero"
                browseRef={uploadHandle}
              />
            </div>
            <Link to="/discover" className={BUTTON}>
              Browse Gutenberg
            </Link>
          </div>
        ) : !hasItems ? (
          // The library has things in it, just none matching the active
          // filter(s) — a filter result, not an empty library, so the way out
          // is "show everything". Cross-library search: a search names what it searched
          // rather than reusing the bare kind-only copy.
          <EmptyState
            title={
              trimmedQuery ? "No matches" : kind ? `No ${KIND_LABELS[kind].toLowerCase()} yet` : "Nothing here yet"
            }
            body={
              trimmedQuery
                ? `Nothing in your library matches “${trimmedQuery}”${kind ? ` in ${KIND_LABELS[kind].toLowerCase()}` : ""}.`
                : "Nothing in your library matches this filter."
            }
            action={
              <Link
                to="/"
                // Clears BOTH filters explicitly (not just kind): with a query
                // active, dropping only kind could still leave zero results,
                // and this is the one action guaranteed to show something
                // (the library itself isn't empty, per the branch above).
                search={{ kind: undefined, q: undefined }}
                className={BUTTON}
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
 * The compact empty state, used for two of the three cases inside the
 * `aria-label="Library"` section below the chips: a load error, and a filter
 * that matches nothing. The THIRD case — an empty library — is bespoke markup
 * in `LibraryHome` instead: it's the one place the dashed dropzone
 * still lives, and reusing this title/body/action shape for it would either
 * bury the dropzone in an `action` slot or duplicate the greeting.
 */
function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-tile border border-line bg-paper-raised px-6 py-16 text-center shadow-l1">
      <p className="font-display text-title font-medium text-ink">{title}</p>
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
          <div className="aspect-[2/3] w-full rounded-cover bg-paper-container motion-safe:animate-pulse" />
          <div className="h-4 w-3/4 rounded-sm bg-paper-container motion-safe:animate-pulse" />
          <div className="h-3 w-1/2 rounded-sm bg-paper-container motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}
