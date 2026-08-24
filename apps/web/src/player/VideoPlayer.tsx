import type { LibraryBook } from "@ebook-reader/shared";

import { MediaFrame } from "./MediaFrame";
import { mediaFileUrl } from "./media-url";
import { useMediaProgress } from "./use-media-progress";

/**
 * Video player (brief 23): just the native `<video>` element (no cover art —
 * video covers are always absent) inside the Reading Room frame. Streams from the
 * authenticated file URL (`?token=`); resumes at, and PATCHes, the per-user
 * position via `useMediaProgress`. The server's Range support lets the element
 * seek/scrub without downloading the whole file.
 */
export function VideoPlayer({ book }: { book: LibraryBook }) {
  const { mediaRef, onLoadedMetadata, onTimeUpdate, onPause } =
    useMediaProgress<HTMLVideoElement>(book.id, book.locator);

  return (
    <MediaFrame title={book.title} subtitle={book.author}>
      <video
        ref={mediaRef}
        src={mediaFileUrl(book.id)}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onPause={onPause}
        className="max-h-[80vh] w-full max-w-4xl rounded-sm bg-black shadow-[0_8px_16px_-6px_rgba(28,27,27,0.25)] ring-1 ring-reader-border/50"
      >
        Your browser doesn't support video playback.
      </video>
    </MediaFrame>
  );
}
