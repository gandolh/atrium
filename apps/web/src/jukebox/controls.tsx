import { useState, type ReactNode } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { coverUrl } from "../lib/library-api";
import { NoteIcon } from "./icons";

/**
 * Small pieces the Jukebox's panels share. The transport's quiet icon button
 * mirrors `player/transport.tsx`'s, plus the two things a remote needs that a
 * local player doesn't: `disabled` (the bot is offline) and `pressed` (shuffle
 * and repeat are toggles, and accent marks their state, never fills them).
 */

export function RemoteButton({
  label,
  onClick,
  disabled = false,
  pressed,
  size = "md",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A toggle's state. Set only on toggles, so plain buttons carry no `aria-pressed`. */
  pressed?: boolean;
  size?: "sm" | "md";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`grid shrink-0 place-items-center rounded-card transition-colors ease-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${
        size === "sm" ? "h-8 w-8" : "h-10 w-10"
      } ${pressed ? "text-accent" : "text-ink-variant enabled:hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

/**
 * A song's artwork: its embedded cover at the 2px artwork radius, or the music
 * tint with a note when it has none. A row thumbnail is too small for the
 * grid's title-initial fallback, so it keeps just the kind's ground and glyph.
 */
export function TrackArt({ book, className = "" }: { book: LibraryBook | undefined; className?: string }) {
  const [failed, setFailed] = useState(false);
  const showImage = book?.hasCover && !failed;
  return (
    <span
      className={`grid aspect-square shrink-0 place-items-center overflow-hidden rounded-cover border border-line-soft bg-tint-music text-ink-variant ${className}`}
    >
      {showImage ? (
        <img
          src={coverUrl(book.id, book.coverVersion)}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <NoteIcon className="h-1/2 max-h-10 w-1/2 max-w-10 opacity-70" />
      )}
    </span>
  );
}

/** "Artist · Album", whichever of the two a song has. */
export function trackByline(artist: string | null, album: string | null): string {
  return [artist, album].filter(Boolean).join(" · ");
}

/**
 * An inline two-step confirm, copied from `LatexFileTree`'s delete: the first
 * click arms it, the second does it, and "No" backs out. No modal and no
 * `window.confirm`, which the design system has no say over.
 */
export function ConfirmStep({
  prompt,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
}: {
  prompt: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <span role="group" aria-label={prompt} className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <span className="text-right font-ui text-xs text-ink-variant">{prompt}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-card px-2 py-1 font-ui text-xs font-semibold transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-accent ${
            danger ? "text-danger" : "text-ink"
          }`}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-card px-2 py-1 font-ui text-xs text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          No
        </button>
      </span>
    </span>
  );
}
