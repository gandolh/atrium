import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LibraryBook } from "@ebook-reader/shared";

import { captureAndUploadVideoCover } from "../lib/video-cover";
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
 *
 * This is also the playback half of the video cover backfill (brief 42, D40
 * item 1): the first `play` of a coverless video captures and posts a frame
 * here. It belongs on THIS surface, not on the dock's `<audio>` — a video item
 * can only ever reach dock output via `releaseSurface`, i.e. after mounting
 * here first, so this is the one place every video play passes through at
 * least once, and the only element with an actual picture to capture from.
 */
export function VideoPlayer({ book }: { book: LibraryBook }) {
  const item = useMemo(() => playbackItemFromBook(book), [book]);

  return (
    <MediaFrame title={book.title} subtitle={book.author}>
      {item ? (
        <VideoSurface item={item} book={book} />
      ) : (
        <p className="text-reader-fg/70">This item can't be played as video.</p>
      )}
    </MediaFrame>
  );
}

function VideoSurface({ item, book }: { item: PlaybackItem; book: LibraryBook }) {
  const load = usePlaybackStore((s) => s.load);
  const releaseSurface = usePlaybackStore((s) => s.releaseSurface);
  const { mediaRef, handlers } = usePlaybackElement<HTMLVideoElement>(item);
  const qc = useQueryClient();
  // The one-shot guard for THIS mount: a pause/resume, a seek or a loop all
  // raise further `play` events on the same element, and only the first of them
  // should capture. `!book.hasCover` (checked in `handlePlay`) is the durable,
  // cross-mount guard (D40 item 2) — this ref just stops a second attempt
  // within one mount before that prop has had a chance to flip.
  //
  // Claimed from the RESOLVED outcome, not before the call: the helper declines
  // while an upload-time capture for the same id is still in flight, and that
  // window is the common one (the card is on screen before that capture
  // finishes, because the library query is invalidated first). Claiming up
  // front spent this mount's only attempt on a call that created nothing — and
  // if the upload-time capture then failed, which is the exact case the
  // backfill exists for, the item stayed coverless for the session.
  const backfillAttempted = useRef<string | null>(null);

  useEffect(() => {
    load(item, { autoplay: true, output: "surface" });
    return () => releaseSurface(item.id);
  }, [item, load, releaseSurface]);

  const handlePlay = () => {
    handlers.onPlay();
    if (book.hasCover || backfillAttempted.current === book.id) return;
    // A dedicated cross-origin load (NOT this playing element — see
    // `video-cover.ts`'s module comment on tainted canvases). Fire-and-forget:
    // the helper never throws or rejects, so a capture failure can't surface
    // as a playback error, and playback itself is already under way by the
    // time this runs (it's wired off the `play` event, not before it).
    void captureAndUploadVideoCover(book.id, {
      kind: "url",
      url: mediaFileUrl(book.id),
      crossOrigin: "anonymous",
    }).then((outcome) => {
      // Spend the one-shot on a real attempt, or on the session's attempt
      // budget being gone (nothing but a reload changes that, so there is no
      // point asking again on the next `play`). An `"in-flight"` decline is
      // neither: leave the ref clear so a later `play` on this element — the
      // resume, seek or rewatch that follows — gets the attempt the helper
      // never made. Repeat `play`s meanwhile just re-decline, which is two
      // hash lookups and no decoder work.
      if (outcome.attempted || outcome.declined === "attempts-spent") {
        backfillAttempted.current = book.id;
      }
      // Refetch only on an actually-stored cover: a failed capture changed
      // nothing on the server, so refetching would just be noise (same
      // reasoning as the upload-time capture in `use-library.ts`).
      if (outcome.stored) void qc.invalidateQueries({ queryKey: ["library"] });
    });
  };

  return (
    <video
      ref={mediaRef}
      src={mediaFileUrl(item.id)}
      controls
      playsInline
      preload="metadata"
      {...handlers}
      onPlay={handlePlay}
      className="max-h-[80vh] w-full max-w-4xl rounded-cover border border-line-soft bg-black shadow-l1"
    >
      Your browser doesn't support video playback.
    </video>
  );
}
