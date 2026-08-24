import { useState } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { coverUrl } from "../lib/library-api";
import { MediaFrame } from "./MediaFrame";
import { mediaFileUrl } from "./media-url";
import { useMediaProgress } from "./use-media-progress";

/**
 * Audio player (brief 23): the square embedded cover art (or the typographic
 * fallback tile) above native `<audio>` controls, inside the Reading Room frame.
 * Streams from the authenticated file URL (`?token=`); resumes at, and PATCHes,
 * the per-user position via `useMediaProgress`.
 */
export function AudioPlayer({ book }: { book: LibraryBook }) {
  const { mediaRef, onLoadedMetadata, onTimeUpdate, onPause } =
    useMediaProgress<HTMLAudioElement>(book.id, book.locator);

  return (
    <MediaFrame title={book.title} subtitle={book.author}>
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <AudioArt book={book} />
        <audio
          ref={mediaRef}
          src={mediaFileUrl(book.id)}
          controls
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPause={onPause}
          className="w-full"
        >
          Your browser doesn't support audio playback.
        </audio>
      </div>
    </MediaFrame>
  );
}

/** Square cover art centered on paper; typographic fallback when no art was
 *  embedded or the image fails to load. Mirrors the readers' cover-tile
 *  language (design.md) but square (400×400) rather than 2:3. */
function AudioArt({ book }: { book: LibraryBook }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showArt = book.hasCover && !imgFailed;
  return (
    <div className="aspect-square w-full max-w-xs overflow-hidden rounded-sm bg-reader-surface shadow-[0_8px_16px_-6px_rgba(28,27,27,0.25)] ring-1 ring-reader-border/50">
      {showArt ? (
        <img
          src={coverUrl(book.id)}
          alt=""
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center px-4 text-center font-display text-lg leading-tight font-semibold text-reader-fg/70">
          {book.title}
        </span>
      )}
    </div>
  );
}
