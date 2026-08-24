import { lazy, Suspense, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { kindForFormat, type FileType, type LibraryBook, type MediaKind } from "@ebook-reader/shared";

import { useReaderStore } from "../store/reader-store";
import { coverUrl } from "../lib/library-api";
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

  // Cover-card clicks navigate here immediately (brief 10); this hook is the
  // single download path for both that and refresh / direct visits (D24).
  const hydrate = useHydrateBook(book);

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
    if (hydrate.status === "loading") {
      return <OpeningState book={hydrate.book} progress={hydrate.progress} />;
    }
    if (hydrate.status === "error") {
      return <OpeningErrorState book={hydrate.book} onRetry={hydrate.retry} />;
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
      onRetry={retry}
      detail="Couldn't load the reader — the app may have updated. Reload to try again."
    />
  );

  if (effectiveFormat === "pdf") {
    return (
      <ReaderChunkErrorBoundary fallback={chunkErrorFallback}>
        <Suspense fallback={<OpeningState book={hydrate.book} progress={null} />}>
          <PdfReader file={file} />
        </Suspense>
      </ReaderChunkErrorBoundary>
    );
  }

  if (effectiveFormat === "epub") {
    // Brief 07: the EPUB reader (react-reader) reuses this brief's shared chrome.
    return (
      <ReaderChunkErrorBoundary fallback={chunkErrorFallback}>
        <Suspense fallback={<OpeningState book={hydrate.book} progress={null} />}>
          <EpubReader file={file} />
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
function OpeningState({ book, progress }: { book: LibraryBook | null; progress: number | null }) {
  const pct = progress !== null ? Math.round(progress * 100) : null;
  return (
    <main className="grid min-h-screen place-items-center bg-reader-bg px-4">
      <div className="flex w-full max-w-xs flex-col items-center gap-6 text-center">
        <BookCoverTile book={book} />
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
              <div className="h-full w-1/3 animate-pulse rounded-full bg-reader-accent" />
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
  onRetry,
  detail = "The download didn't finish — the connection may have dropped.",
}: {
  book: LibraryBook | null;
  onRetry: () => void;
  detail?: string;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-reader-bg px-4">
      <div className="flex w-full max-w-xs flex-col items-center gap-5 text-center">
        <BookCoverTile book={book} dimmed />
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
 * today. `useMotionTransition("expand")` already collapses to a 0ms jump
 * under `prefers-reduced-motion` (lib/motion.ts) — no separate reduced-motion
 * branch needed here.
 */
function BookCoverTile({ book, dimmed }: { book: LibraryBook | null; dimmed?: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);
  const transition = useMotionTransition("expand");
  return (
    <motion.div
      layoutId={book ? coverLayoutId(book.id) : undefined}
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
