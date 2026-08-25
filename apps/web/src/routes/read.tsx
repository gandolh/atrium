import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { kindForFormat, type FileType, type LibraryBook, type MediaKind } from "@ebook-reader/shared";

import { useReaderStore } from "../store/reader-store";
import { coverUrl, fetchBookById, fetchLibrary, updateProgress } from "../lib/library-api";
import { useActiveProfileId } from "../lib/auth";
import { libraryKey } from "../lib/use-library";
import { useProgressSync } from "../lib/use-progress-sync";
import { useHydrateBook } from "../lib/use-hydrate-book";
import { useDevSampleFile } from "../reader/pdf/dev/use-dev-sample-file";
import { useDevSampleEpub } from "../reader/epub/dev/use-dev-sample-epub";
import { ReaderChunkErrorBoundary } from "../reader/ReaderChunkErrorBoundary";
import { useMotionTransition } from "../lib/motion";
import { coverLayoutId } from "../lib/cover-layout-id";

const routeApi = getRouteApi("/read");

// Code-split the two renderers (react-pdf/pdf.js and react-reader/epub.js are
// both heavy) so the library home never pays for either, and each format's
// bundle loads only once that format is actually opened. The barrels export
// named bindings (reused elsewhere), so adapt to the default export `lazy`
// requires here rather than changing their public shape.
const PdfReader = lazy(() => import("../reader/pdf").then((m) => ({ default: m.PdfReader })));
const EpubReader = lazy(() => import("../reader/epub").then((m) => ({ default: m.EpubReader })));

// The media players (brief 23) are code-split exactly like the readers above, so
// the book-reading path never downloads player code and vice versa.
const AudioPlayer = lazy(() => import("../player/AudioPlayer").then((m) => ({ default: m.AudioPlayer })));
const VideoPlayer = lazy(() => import("../player/VideoPlayer").then((m) => ({ default: m.VideoPlayer })));

/**
 * `/read` — the reader/player view. Branches on the media `kind` derived from
 * the format (`kindForFormat`): pdf/epub open the book readers below (unchanged),
 * mp3 opens the AudioPlayer, mp4/webm the VideoPlayer (brief 23). Split into
 * child components so each path calls its own hooks (the book path hydrates an
 * in-memory `File`; the media path only resolves the row and streams from the
 * file URL) without violating the rules of hooks.
 */
export function Read() {
  const search = routeApi.useSearch();
  // The fresh URL `format` param wins over the store's `loadedFormat`: opening a
  // media item from the library must not be captured by a STALE `loadedFormat`
  // left over from a previously-read book (which would misroute media down the
  // byte-buffering book path). `loadedFormat` is only the fallback for an in-app
  // book open that navigated without the param. This is a best-effort guess;
  // the resolved library row's `kind` is the authority (see BookReader).
  const loadedFormat = useReaderStore((s) => s.loadedFormat);
  const effectiveFormat = (search.format ?? loadedFormat ?? null) as FileType | null;
  const kind: MediaKind = effectiveFormat ? kindForFormat(effectiveFormat) : "book";

  if (kind === "audio" || kind === "video") {
    // Key by book id so switching between two media items remounts the player —
    // a fresh element and a fresh resume seek for the new track.
    return <MediaRoute key={search.book ?? ""} bookId={search.book} kind={kind} />;
  }

  return <BookReader />;
}

/**
 * `true` when `a` is a strictly more recent ISO timestamp than `b` (brief 34
 * decision 11: "newest wins, null means never opened"). Both are
 * `reading_progress.updated_at` values, which are always written by the same
 * server clock as `new Date().toISOString()`, so lexical comparison is exactly
 * chronological comparison. Neither a `null` vs `null` tie nor an exact-equal
 * pair counts as "newer" — the caller's own default wins those.
 */
function isNewer(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

/**
 * The book (pdf/epub) reading view. Reads the in-memory `File` handed over by the
 * library (Zustand `loadedFile`, set when a cover card is opened) and mounts
 * the matching renderer behind the shared chrome. The `File` lives only in
 * memory, so a direct visit / refresh with nothing loaded shows a "go to
 * library" state (the book itself is persisted server-side per D24 — reopen it
 * from the library home).
 *
 * Format routing: this brief (06) implements PDF. EPUB lands in brief 07, which
 * mounts its renderer here and REUSES the shared chrome (apps/web/src/reader/
 * chrome). The `format` search param stays the type-safe seam; the actual file
 * comes from the store.
 */
function BookReader() {
  const { format, book, dev } = routeApi.useSearch();
  const loadedFile = useReaderStore((s) => s.loadedFile);
  const loadedFormat = useReaderStore((s) => s.loadedFormat);
  const loadedBookId = useReaderStore((s) => s.loadedBookId);

  // Brief 34 step 7: which of a convert pair's two rows to actually hydrate.
  // The requested `book` is always a SOURCE id (only source rows ever appear
  // in the grid, D34), so its own row — and `lastReadAt` — comes straight off
  // the same list cache the library home and `useHydrateBook` itself already
  // populate (`libraryKey`): no extra request for the common case of a book
  // with no conversion at all.
  const profileId = useActiveProfileId();
  const libraryQuery = useQuery({
    queryKey: libraryKey(profileId, "recent"),
    queryFn: () => fetchLibrary("recent"),
    enabled: Boolean(book),
  });
  const sourceRow = libraryQuery.data?.find((b) => b.id === book) ?? null;
  const partnerId = sourceRow?.convertedFrom ?? sourceRow?.convertedTo ?? null;

  // The PARTNER, when one exists, is a converted row — `GET /library` above
  // excludes those on purpose (one card per book), so its `lastReadAt` is
  // reachable only by asking for it directly. Query key intentionally matches
  // `use-hydrate-book.ts`'s own by-id fallback (see that file's handoff
  // comment) so opening straight into this id afterward reuses the same
  // cache entry instead of double-fetching the row.
  const partnerRowQuery = useQuery({
    queryKey: ["library", "book", partnerId] as const,
    queryFn: () => fetchBookById(partnerId as string),
    enabled: Boolean(partnerId),
  });

  // Frozen per requested `book` id: either cache can refetch later (focus,
  // the touch PATCH below) and re-deriving from newer data must never swap
  // the open file out from under an already-reading reader — see decision 11
  // and the "ordering and loops" note on this brief's step 7.
  //
  // Deliberately `undefined`, never `book`, while unresolved (proven the hard
  // way): `useHydrateBook` treats ANY id as a green light to fully hydrate and
  // MOUNT that format's reader. Handing it the unresolved `book` as a
  // stand-in "for now" briefly mounted the wrong reader in testing, and that
  // reader's own `useProgressSync` ran for real — PATCHing a bogus position
  // onto that row before the resolved id arrived and swapped it out. `book`
  // is only safe to return once we've confirmed there's no partner to lose a
  // race against; until then, `undefined` keeps `useHydrateBook` inert (its
  // `needsHydrate` requires a truthy id) and `BookReader` shows the ordinary
  // opening screen, exactly as if the fetch simply hadn't landed yet.
  const resolvedIdRef = useRef<{ requested: string; resolved: string } | null>(null);
  const resolvedBookId = useMemo(() => {
    if (!book) return book;
    if (resolvedIdRef.current?.requested === book) return resolvedIdRef.current.resolved;

    // Not frozen yet and the source list hasn't landed — nothing hydrates
    // until we at least know whether `book` even HAS a partner to race
    // against.
    if (!libraryQuery.data) return undefined;

    if (!partnerId) {
      resolvedIdRef.current = { requested: book, resolved: book };
      return book;
    }
    // A partner exists but its row hasn't arrived yet — keep waiting rather
    // than hydrating `book` "provisionally": that's exactly the window that
    // caused the corruption above.
    if (!partnerRowQuery.data || partnerRowQuery.data.id !== partnerId) return undefined;

    // If the store already has the OTHER half of this exact pair loaded, this
    // navigation is the in-reader format switch landing on purpose (it can
    // only get here by explicitly choosing this id) — not a fresh open from
    // the library. Resolving anyway would compare timestamps and immediately
    // bounce the switch back to the format it's trying to leave, since the
    // just-left format is (until the touch effect below fires) still the
    // newer of the two.
    const isExplicitSwitch = loadedBookId === partnerId;

    let winner = book;
    if (!isExplicitSwitch && isNewer(partnerRowQuery.data.lastReadAt, sourceRow?.lastReadAt ?? null)) {
      winner = partnerId;
    }
    resolvedIdRef.current = { requested: book, resolved: winner };
    return winner;
  }, [book, libraryQuery.data, partnerId, partnerRowQuery.data, sourceRow, loadedBookId]);

  // Cover-card clicks navigate here immediately (brief 10); this hook is the
  // single download path for both that and refresh / direct visits (D24).
  // Hydrates `resolvedBookId`, NOT the raw `book` param — see above. When the
  // two differ the store's `loadedFormat`/`loadedBookId` (set together by
  // `setLoadedBook`) become the resolved row's own once the file lands, so
  // nothing downstream needs to know a substitution happened.
  const hydrate = useHydrateBook(resolvedBookId);

  // Brief 34 step 7: touch the opened row's `updated_at` so the format choice
  // sticks even if the reader closes without reading a page — otherwise
  // switching format and reading nothing would leave the just-opened row's
  // `lastReadAt` untouched, and the NEXT open would resolve straight back to
  // the other one. Re-PATCHes the row's OWN current progress/locator
  // unchanged (controller's ruling) so only the timestamp moves — sending a
  // placeholder here would overwrite a real resume position. Guarded by
  // `touchedRowRef` so this fires once per distinct row actually opened, not
  // on every render, and it never fires for a book with no convert pair at
  // all (nothing to keep "sticky" there).
  const touchedRowRef = useRef<string | null>(null);
  useEffect(() => {
    const row = hydrate.book;
    if (!row || (row.convertedFrom === null && row.convertedTo === null)) return;
    if (touchedRowRef.current === row.id) return;
    touchedRowRef.current = row.id;
    void updateProgress(row.id, row.progress, row.locator);
  }, [hydrate.book]);

  // Persist coarse reading progress back to the library when the book came
  // from it (D24). No-op for dev samples / direct visits.
  useProgressSync();

  // Dev-only, opt-in (`?dev=1`) sample files so `/read` is testable without the
  // uploader. Both return null in production and when not enabled. The `format`
  // param picks which sample: `?format=epub&dev=1` loads the EPUB, otherwise PDF.
  const devWantsEpub = (loadedFormat ?? format) === "epub";
  const devPdf = useDevSampleFile(Boolean(dev) && !devWantsEpub);
  const devEpub = useDevSampleEpub(Boolean(dev) && devWantsEpub);
  const devFile = devWantsEpub ? devEpub : devPdf;

  // Self-correct a misrouted media row: `/read?book=<id>` with no `format` param
  // (or a stale `loadedFormat`) can land media here as a "book". The resolved
  // library row's `kind` is the authority — hand off to the player route BEFORE
  // any file bytes download (the byte download is likewise short-circuited in
  // useHydrateBook for a non-book row, so nothing was buffered getting here).
  if (hydrate.book && hydrate.book.kind !== "book") {
    return <MediaRoute key={book ?? ""} bookId={book} kind={hydrate.book.kind} />;
  }

  const file = loadedFile ?? devFile;
  // Prefer the store's detected format; fall back to the URL param. When a dev
  // sample is in play, infer the format from which sample loaded.
  const effectiveFormat =
    loadedFormat ?? format ?? (devFile ? (devWantsEpub ? "epub" : "pdf") : null);

  if (!file) {
    // Having a `?book=` to open IS the opening state. `hydrate.status` is still
    // "idle" on the FIRST commit — it only becomes "loading" inside the hydrate
    // effect — so keying the opening screen on "loading" alone flashed the "No
    // book open" screen for a frame AND killed the cover → reader morph: a
    // shared-layout animation can only fire on the commit where the library
    // tile unmounts, and on that commit there was no `motion.div` here at all.
    if (hydrate.status === "loading" || (book && hydrate.status === "idle")) {
      return <OpeningState book={hydrate.book ?? sourceRow} bookId={book} progress={hydrate.progress} />;
    }
    if (hydrate.status === "error") {
      return <OpeningErrorState book={hydrate.book ?? sourceRow} bookId={book} onRetry={hydrate.retry} />;
    }
    return <NoFileState format={effectiveFormat} notFound={hydrate.status === "not-found"} />;
  }

  // Suspense fallback while the lazy chunk downloads: reuse the same opening
  // screen shown during the file download above, so a slow network doesn't
  // introduce a visibly different loading state between "fetching the file"
  // and "fetching the renderer".
  // The lazy reader chunk can fail to download (stale deploy / flaky net); the
  // boundary turns that from an app crash into the same recoverable error screen
  // the file download uses, with a retry (a reload — see the boundary).
  const chunkErrorFallback = (retry: () => void) => (
    <OpeningErrorState
      book={hydrate.book}
      bookId={book}
      onRetry={retry}
      detail="Couldn't load the reader — the app may have updated. Reload to try again."
    />
  );

  // Brief 34 (D34, decision 10): the convert trigger and format switch live in
  // the READER and nowhere else. The resolved row is handed down as DATA rather
  // than as a rendered node — building the element here would pull the reader
  // chrome ConvertControl imports into the ENTRY chunk (measured: +41 kB gzip),
  // undoing brief 15's code-splitting. The readers are already lazy, so letting
  // each import ConvertControl itself keeps it in the reader chunk where it
  // belongs. Neither reader gains any convert logic, and no second fetch is
  // needed for a row this route already holds.
  if (effectiveFormat === "pdf") {
    return (
      <ReaderChunkErrorBoundary fallback={chunkErrorFallback}>
        <Suspense fallback={<OpeningState book={hydrate.book} bookId={book} progress={null} />}>
          <PdfReader file={file} book={hydrate.book} />
        </Suspense>
      </ReaderChunkErrorBoundary>
    );
  }

  if (effectiveFormat === "epub") {
    // Brief 07: the EPUB reader (react-reader) reuses this brief's shared chrome.
    return (
      <ReaderChunkErrorBoundary fallback={chunkErrorFallback}>
        <Suspense fallback={<OpeningState book={hydrate.book} bookId={book} progress={null} />}>
          <EpubReader file={file} book={hydrate.book} />
        </Suspense>
      </ReaderChunkErrorBoundary>
    );
  }

  return <NoFileState format={effectiveFormat} />;
}

/**
 * The media (audio/video) playback view (brief 23). Unlike the book path it
 * never hydrates an in-memory `File`: `useHydrateBook` (kind-aware) resolves the
 * library ROW only, and the lazily-loaded player streams from the authenticated
 * file URL. Resume + progress-PATCH live in the player via `useMediaProgress`.
 */
function MediaRoute({ bookId, kind }: { bookId: string | undefined; kind: MediaKind }) {
  const hydrate = useHydrateBook(bookId, kind);

  // A direct visit / refresh with no book id has nothing to play.
  if (!bookId) {
    return <NoFileState format={null} />;
  }

  // Until the row is known, mirror the book path's opening/error/not-found states.
  if (!hydrate.book) {
    if (hydrate.status === "error") {
      return <OpeningErrorState book={hydrate.book} onRetry={hydrate.retry} />;
    }
    if (hydrate.status === "not-found") {
      return <NoFileState format={null} notFound />;
    }
    return <OpeningState book={hydrate.book} progress={null} />;
  }

  const chunkErrorFallback = (retry: () => void) => (
    <OpeningErrorState
      book={hydrate.book}
      onRetry={retry}
      detail="Couldn't load the player — the app may have updated. Reload to try again."
    />
  );

  const Player = kind === "audio" ? AudioPlayer : VideoPlayer;
  return (
    <ReaderChunkErrorBoundary fallback={chunkErrorFallback}>
      <Suspense fallback={<OpeningState book={hydrate.book} progress={null} />}>
        <Player book={hydrate.book} />
      </Suspense>
    </ReaderChunkErrorBoundary>
  );
}

function NoFileState({ format, notFound }: { format: string | null; notFound?: boolean }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-12">
      <h1 className="font-display text-2xl font-semibold">No book open</h1>
      <p className="text-reader-fg/70">
        {notFound
          ? "That book isn't in your library anymore — it may have been removed."
          : `Nothing to read yet. The open file lives only in memory, so a direct visit or refresh has nothing to show${format ? ` for “${format}”` : ""}. Your books are saved though — reopen one from your library.`}
      </p>
      <Link
        to="/"
        className="w-fit rounded-md border border-reader-border bg-reader-surface px-4 py-2 text-sm font-medium"
      >
        Go to your library
      </Link>
    </main>
  );
}

/**
 * The opening screen (brief 10): shown from the instant a cover is clicked
 * until the file is in memory. Cover + title identify what's opening; a
 * determinate accent bar tracks the download (the transfer is the wait — a
 * 24MB EPUB on a slow link is tens of seconds). Indeterminate → pulsing bar.
 */
function OpeningState({
  book,
  bookId,
  progress,
}: {
  book: LibraryBook | null;
  /** The `?book=` id — the morph's identity even before the row resolves. */
  bookId?: string;
  progress: number | null;
}) {
  const pct = progress !== null ? Math.round(progress * 100) : null;
  return (
    <main className="grid min-h-[calc(100vh-var(--dock-height,0px))] place-items-center bg-reader-bg px-4">
      <div className="flex w-full max-w-xs flex-col items-center gap-6 text-center">
        <BookCoverTile book={book} bookId={bookId} />
        <div className="flex w-full flex-col gap-3">
          <h1 className="font-display text-xl leading-snug font-semibold text-reader-fg">
            {book ? book.title : "Opening your book…"}
          </h1>
          <div
            role="progressbar"
            aria-label="Downloading book"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            className="h-1 w-full overflow-hidden rounded-full bg-reader-border/60"
          >
            {pct !== null ? (
              <div
                className="h-full rounded-full bg-reader-accent transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <div className="h-full w-1/3 motion-safe:animate-pulse rounded-full bg-reader-accent" />
            )}
          </div>
          <p className="text-sm text-reader-fg/60">
            {pct !== null ? `Downloading… ${pct}%` : "Fetching from your library…"}
          </p>
        </div>
      </div>
    </main>
  );
}

/** Download failed (API offline, connection dropped) — or, with a custom
 * `detail`, a reader chunk that failed to load (stale deploy / flaky net).
 * Today's silent failure becomes an explicit state with a retry. */
function OpeningErrorState({
  book,
  bookId,
  onRetry,
  detail = "The download didn't finish — the connection may have dropped.",
}: {
  book: LibraryBook | null;
  /** See `OpeningState`. */
  bookId?: string;
  onRetry: () => void;
  detail?: string;
}) {
  return (
    <main className="grid min-h-[calc(100vh-var(--dock-height,0px))] place-items-center bg-reader-bg px-4">
      <div className="flex w-full max-w-xs flex-col items-center gap-5 text-center">
        <BookCoverTile book={book} bookId={bookId} dimmed />
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-xl leading-snug font-semibold text-reader-fg">
            Couldn't open {book ? `“${book.title}”` : "your book"}
          </h1>
          <p className="text-sm text-reader-fg/60">{detail}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* design.md "accent means state only, never a button fill": this
              was accent-filled (a brief 27 conformance gap) — ink-filled
              primary, matching the system's one solid-button style. */}
          <button
            type="button"
            onClick={onRetry}
            className="rounded-card bg-ink-fill px-4 py-2 text-sm font-medium text-on-ink-fill"
          >
            Try again
          </button>
          <Link
            to="/"
            className="rounded-md border border-reader-border bg-reader-surface px-4 py-2 text-sm font-medium text-reader-fg"
          >
            Back to library
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * Small 2:3 cover for the opening/error screens; typographic fallback tile
 * when the book has no cover, its cover fails to load (API down), or the row
 * isn't known yet.
 *
 * This is the READER-side landing target for the cover → reader shared-layout
 * transition (design.md "Motion": "Cover expands into the page", 420ms —
 * brief 32 step 5). It's the first thing this route paints — the tile flips
 * to `/read` instantly (wiki/reader.md "Opening from library home") and the
 * actual PDF/EPUB bytes can take tens of seconds to land, so the morph has to
 * resolve HERE, not at the eventual `PdfReader`/`EpubReader` mount. The
 * matching `motion.div layoutId` on the library side (`library/CoverCard.tsx`,
 * brief 29 — see this brief's handoff) is what makes the FLIP fire; without
 * it this is just an ordinary div and the navigation looks exactly as it does
 * today.
 *
 * Two things have to line up for that, and both were wrong at first: this tile
 * must be mounted on the SAME commit that unmounts the library tile (hence the
 * "idle" branch in `BookReader` — Motion pairs a removed `layoutId` node with a
 * newly added one, so a one-frame `NoFileState` in between loses the pairing),
 * and the id must not depend on the library row having resolved (hence
 * `bookId`). `useMotionTransition("expand")` already collapses to a 0ms jump
 * under `prefers-reduced-motion` (lib/motion.ts) — no separate reduced-motion
 * branch needed here.
 */
function BookCoverTile({
  book,
  bookId,
  dimmed,
}: {
  book: LibraryBook | null;
  bookId?: string;
  dimmed?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const transition = useMotionTransition("expand");
  // `bookId` (the URL's `?book=`) wins over `book.id` — needed for two
  // separate reasons that happen to want the same order. First, the row
  // hasn't resolved yet on the very first commit, which is exactly when the
  // library row may still be a cache miss: the morph has to be wired then,
  // from the URL alone. Second, since brief 34 step 7 `hydrate.book` can
  // resolve to a CONVERTED book that the reader silently opened instead of
  // the clicked one (decision 11) — but the library grid only ever hands out
  // a `layoutId` for the SOURCE row (converted rows are hidden from it), so
  // matching against `book.id` there would break the FLIP by pairing with a
  // layoutId that was never mounted. `bookId` is always the clicked (source)
  // id, so it's the one identity that's guaranteed to match the grid.
  const layoutId = bookId ?? book?.id;
  return (
    <motion.div
      layoutId={layoutId ? coverLayoutId(layoutId) : undefined}
      layout
      transition={transition}
      className={`aspect-[2/3] w-28 overflow-hidden rounded-sm bg-reader-surface shadow-[0_8px_16px_-6px_rgba(28,27,27,0.25)] ring-1 ring-reader-border/50 ${
        dimmed ? "opacity-60" : ""
      }`}
    >
      {book?.hasCover && !imgFailed ? (
        <img
          src={coverUrl(book.id)}
          alt=""
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center px-2 text-center font-display text-sm leading-tight font-semibold text-reader-fg/70">
          {book?.title ?? ""}
        </span>
      )}
    </motion.div>
  );
}
