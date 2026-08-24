import { useEffect, useMemo } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { playbackItemFromBook, usePlaybackStore, type PlaybackItem } from "../store/playback-store";
import { MediaFrame } from "./MediaFrame";
import { mediaFileUrl } from "./media-url";
import { usePlaybackElement } from "./use-playback-element";

/**
 * The full-surface video view (brief 31): unlike `AudioPlayer`, this surface
 * DOES own an element — video needs its own `<video>` for the picture — and
 * claims the playback output while mounted (`output: "surface"`). That claim
 * is what unmounts the shell's `<audio>` (see `PlaybackHost` and the playback
 * store's module comment): the no-double-audio guarantee is structural, not a
 * mute flag, so opening a video while a track is playing can't sound both at
 * once.
 *
 * Mounting hands the row to the store and starts it (`load(item, { autoplay:
 * true, output: "surface" })`) — opening a video from the library is an
 * explicit "play this". Unmounting hands the output back to the dock
 * (`releaseSurface`), which is the brief's "hands off to the player and
 * back": leaving a playing video via the Library link continues its audio in
 * the dock.
 *
 * The element itself is bound through `usePlaybackElement`, the same
 * store↔element wiring the dock's `<audio>` uses, so position/play-state stay
 * truthful in the dock and resume + the throttled progress PATCH (including
 * the final flush on unmount, brief 23) stay exactly where they were.
 */
export function VideoPlayer({ book }: { book: LibraryBook }) {
  const item = useMemo(() => playbackItemFromBook(book), [book]);

  return (
    <MediaFrame title={book.title} subtitle={book.author}>
      {item ? (
        <VideoSurface item={item} />
      ) : (
        <p className="text-reader-fg/70">This item can't be played as video.</p>
      )}
    </MediaFrame>
  );
}

function VideoSurface({ item }: { item: PlaybackItem }) {
  const load = usePlaybackStore((s) => s.load);
  const releaseSurface = usePlaybackStore((s) => s.releaseSurface);
  const { mediaRef, handlers } = usePlaybackElement<HTMLVideoElement>(item);

  useEffect(() => {
    load(item, { autoplay: true, output: "surface" });
    return () => releaseSurface(item.id);
  }, [item, load, releaseSurface]);

  return (
    <video
      ref={mediaRef}
      src={mediaFileUrl(item.id)}
      controls
      playsInline
      preload="metadata"
      {...handlers}
      className="max-h-[80vh] w-full max-w-4xl rounded-cover border border-line-soft bg-black shadow-l1"
    >
      Your browser doesn't support video playback.
    </video>
  );
}
