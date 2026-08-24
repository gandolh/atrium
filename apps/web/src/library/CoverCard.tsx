import { useState } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { coverUrl } from "../lib/library-api";
import type { OfflineDownloadStatus } from "../lib/use-library";
import { CoverFallback } from "./CoverFallback";
import { OfflineToggle } from "./OfflineToggle";

/** Per-book offline download affordance (brief 20 item 2, rendering side). */
export interface CoverOfflineProps {
  state: OfflineDownloadStatus;
  progress: number | null | undefined;
  /** False while the library is serving cached offline rows (no network to download from). */
  canDownload: boolean;
  onDownload: () => void;
  onRemove: () => void;
}

/**
 * A single book in the library gallery (wiki/design.md "Cards (Book Covers)").
 * 2:3 portrait, 2px radius, bottom-heavy shadow so the book "stands on a
 * shelf". Format badge top-right; a thin blue progress bar along the bottom for
 * started books. Missing cover → a tinted tile with the title set in Newsreader.
 *
 * Brief 20 adds the offline toggle top-left (`offline`, omitted entirely when
 * IndexedDB isn't supported) and gates the "Remove" library action behind
 * `deleteDisabled` while offline (removing is an API call, not a local op).
 *
 * Brief 23c renders per `book.kind` inside the same unchanged 2:3 footprint:
 * `audio` centers the (optional) square embedded-art image on the paper tile;
 * `video` always uses the typographic fallback tile (no frame extraction, D-
 * per brief 23's grilled decision); both add a duration caption. The top-right
 * badge shows MUSIC/VIDEO for media in place of the format (books keep
 * EPUB/PDF). The offline toggle is book-only — media is excluded from offline
 * v1 (brief 23's grilled decision), so it's simply not rendered for `kind !==
 * "book"` regardless of whether the caller passed `offline`.
 */
export function CoverCard({
  book,
  onOpen,
  onDelete,
  deleteDisabled = false,
  offline,
}: {
  book: LibraryBook;
  onOpen: (book: LibraryBook) => void;
  onDelete: (book: LibraryBook) => void;
  deleteDisabled?: boolean;
  offline?: CoverOfflineProps;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const kind = book.kind ?? "book";
  const progressPct = Math.round(book.progress * 100);
  const durationLabel = book.durationSeconds != null ? formatDuration(book.durationSeconds) : null;

  // Per-media card shape (brief 25): books 2:3 portrait, music square (album
  // art), video 16:9 landscape — each media type in its native aspect instead
  // of everything squeezed into a book footprint.
  const aspect = kind === "audio" ? "aspect-square" : kind === "video" ? "aspect-video" : "aspect-[2/3]";

  return (
    <div className="group flex flex-col gap-3">
      {/* Wrapper carries the hover lift so the cover art AND the offline
          toggle move together; the toggle is a sibling (not nested inside
          the open-book button) to keep the DOM free of nested interactive
          elements. */}
      <div className={`relative ${aspect} w-full transition duration-200 group-hover:-translate-y-1`}>
        <button
          type="button"
          onClick={() => onOpen(book)}
          aria-label={`Open ${book.title}`}
          className="absolute inset-0 overflow-hidden rounded-(--radius-cover) bg-paper-container text-left shadow-[0_8px_16px_-6px_rgba(28,27,27,0.18)] ring-1 ring-line-soft/40 transition duration-200 group-hover:shadow-[0_14px_24px_-8px_rgba(28,27,27,0.28)] focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CoverArt book={book} imgFailed={imgFailed} onImgError={() => setImgFailed(true)} />


          {/* Kind/format badge (design.md chips: label-caps, subtle scrim, no
              border) — MUSIC/VIDEO replaces the format for media. */}
          <span className="absolute top-2.5 right-2.5 rounded-(--radius-cover) bg-ink/55 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.08em] text-white uppercase backdrop-blur-sm">
            {kind === "audio" ? "Music" : kind === "video" ? "Video" : book.format}
          </span>

          {/* Duration caption (audio/video only) — the m:ss / h:mm:ss sibling
              of a page count, bottom-left so it never collides with the
              kind/format badge. */}
          {durationLabel && (
            <span className="absolute bottom-2.5 left-2.5 rounded-(--radius-cover) bg-ink/55 px-2 py-1 font-ui text-[11px] leading-none text-white backdrop-blur-sm">
              {durationLabel}
            </span>
          )}

          {/* Reading progress: thin 2px blue bar at the bottom edge. */}
          {progressPct > 0 && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-ink/10">
              <span
                className="block h-full bg-accent"
                style={{ width: `${progressPct}%` }}
              />
            </span>
          )}
        </button>

        {/* Offline downloads are books-only for v1 (brief 23's grilled
            decision) — the toggle is simply omitted for media, regardless of
            what the caller passed. */}
        {offline && kind === "book" && (
          <OfflineToggle
            bookTitle={book.title}
            state={offline.state}
            progress={offline.progress}
            canDownload={offline.canDownload}
            onDownload={offline.onDownload}
            onRemove={offline.onRemove}
          />
        )}
      </div>

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Two-line clamp, not a single-line ellipsis — a book app that cuts
              titles to "The Apot…" undermines its one job. */}
          <p
            title={book.title}
            className="line-clamp-2 font-display text-base leading-snug font-semibold text-ink"
          >
            {book.title}
          </p>
          {book.author && (
            <p title={book.author} className="truncate text-sm text-ink-variant">
              {book.author}
            </p>
          )}
        </div>

        {/* Per-card overflow → delete (design.md: quiet, appears on hover/focus). */}
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label={`More actions for ${book.title}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            onBlur={() => setMenuOpen(false)}
            className="grid h-9 w-9 place-items-center rounded text-ink-variant opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-paper-low focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent max-md:opacity-100"
          >
            <DotsGlyph className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute top-8 right-0 z-10 w-40 overflow-hidden rounded border border-line-soft bg-paper-raised shadow-lg">
              <button
                type="button"
                disabled={deleteDisabled}
                // onMouseDown (not onClick) so it fires before the trigger's onBlur closes the menu.
                onMouseDown={() => {
                  if (!deleteDisabled) onDelete(book);
                }}
                title={deleteDisabled ? "Removing requires a connection" : undefined}
                className={`block w-full px-3 py-2 text-left text-sm ${
                  deleteDisabled
                    ? "cursor-not-allowed text-ink-variant/60"
                    : "text-danger hover:bg-danger-soft/50"
                }`}
              >
                {deleteDisabled ? "Remove (requires connection)" : "Remove"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The per-kind cover-art fill for a 2:3 tile, shared by `CoverCard` and the
 * stacks index so both branch on `book.kind` identically (rather than one of
 * them copying the markup): `audio` centers its square embedded art on the
 * paper ground (mp3 art is 400×400 — cropping to 2:3 would distort it), or the
 * typographic fallback when absent; `video` always uses the fallback (no frame
 * extraction, brief 23); books fill with their full-bleed cover image. The
 * caller owns the `imgFailed` state so it can also key other UI off it.
 */
export function CoverArt({
  book,
  imgFailed,
  onImgError,
}: {
  book: LibraryBook;
  imgFailed: boolean;
  onImgError: () => void;
}) {
  const kind = book.kind ?? "book";
  // Video never has a cover (no frame extraction, brief 23) so it always
  // falls to the typographic tile; audio shows its square art when present.
  const showImage = kind !== "video" && book.hasCover && !imgFailed;

  if (kind === "audio") {
    // The card itself is now square (brief 25), so album art fills it edge to
    // edge (it's a 400×400 square — no distortion) rather than floating small
    // on a paper ground.
    return showImage ? (
      <img
        src={coverUrl(book.id)}
        alt=""
        onError={onImgError}
        className="h-full w-full object-cover"
      />
    ) : (
      <CoverFallback title={book.title} kind="audio" />
    );
  }

  return showImage ? (
    <img
      src={coverUrl(book.id)}
      alt=""
      onError={onImgError}
      className="h-full w-full object-cover"
    />
  ) : (
    <CoverFallback title={book.title} kind={kind} />
  );
}

/**
 * Format a playback duration in seconds as `m:ss` (e.g. `3:07`), or `h:mm:ss`
 * once it reaches an hour (e.g. `1:04:12`) — the audio/video sibling of a page
 * count.
 */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours >= 1) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function DotsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
