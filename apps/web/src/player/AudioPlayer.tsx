import { useEffect, useMemo, useState } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { coverUrl } from "../lib/library-api";
import { playbackItemFromBook, usePlaybackStore } from "../store/playback-store";
import { MediaFrame } from "./MediaFrame";
import { PlayPauseButton, ScrubTrack, SkipButton, TimeReadout } from "./transport";

/**
 * The full-surface audio view: the square embedded cover art (or the typographic
 * fallback tile) above the transport, inside the Reading Room frame.
 *
 * **Brief 31 removed this component's `<audio>` element.** It owns no element at
 * all now — it is a large remote control for the one the app shell owns
 * (`player/PlaybackHost`), driven entirely through the playback store. That is
 * what makes leaving this route harmless: the sound is not here to lose. It also
 * means there is only ever one audio element in the document, so this surface
 * cannot double up with the dock.
 *
 * Mounting hands the row to the store and starts it (`autoplay`) — opening a
 * track from the library is an explicit "play this". Re-loading the item that is
 * already loaded is a no-op for position and play state (see the store), so
 * arriving here from the dock title returns to a paused track still paused, and
 * to a playing one without restarting it. When the browser refuses an
 * unprompted `play()` (a refresh, with no user gesture) the store is corrected
 * back to paused and the play button is simply waiting to be pressed.
 *
 * Resume + the throttled progress PATCH (including the final flush) stay with
 * whichever element is mounted — here, the shell's, via `usePlaybackElement`.
 */
export function AudioPlayer({ book }: { book: LibraryBook }) {
  const load = usePlaybackStore((s) => s.load);
  const item = useMemo(() => playbackItemFromBook(book), [book]);
  const isCurrent = usePlaybackStore((s) => s.item?.id === book.id);

  useEffect(() => {
    if (item) load(item, { autoplay: true });
  }, [item, load]);

  return (
    <MediaFrame title={book.title} subtitle={book.author}>
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <AudioArt book={book} />
        {isCurrent ? (
          <div className="flex w-full flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <ScrubTrack />
              <TimeReadout split />
            </div>
            <div className="flex items-center justify-center gap-5">
              <SkipButton direction="back" />
              <PlayPauseButton size="lg" />
              <SkipButton direction="forward" />
            </div>
          </div>
        ) : null}
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
    <div className="aspect-square w-full max-w-xs overflow-hidden rounded-cover border border-line-soft bg-tint-music shadow-l1">
      {showArt ? (
        <img
          src={coverUrl(book.id)}
          alt=""
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center px-4 text-center font-display text-lg leading-tight font-semibold text-ink">
          {book.title}
        </span>
      )}
    </div>
  );
}
