import { useState } from "react";
import type { LibraryBook, Player } from "@ebook-reader/shared";

import { ConfirmStep, RemoteButton, TrackArt, trackByline } from "./controls";
import { CloseIcon, DownIcon, UpIcon } from "./icons";

/** The section head every Jukebox panel uses: Newsreader `section` (design.md). */
export const SECTION_HEAD = "font-display text-[27px] leading-[1.2] font-medium tracking-[-0.02em] text-ink";

/**
 * A Player's Queue (brief 82): the songs that play before the Playlist
 * continues, each with who added it. Reorder, remove and clear work here and
 * nowhere else, and they keep working while the bot is offline: the Queue is
 * atrium's, and the bot reads it when it is back.
 */
export function QueuePanel({
  player,
  booksById,
  onRemove,
  onMove,
  onClear,
}: {
  player: Player;
  booksById: Map<string, LibraryBook>;
  onRemove: (entryId: number) => void;
  onMove: (entryId: number, toIndex: number) => void;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const queue = player.queue;
  const count = queue.length;

  return (
    <section aria-label="Queue" className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h3 className={SECTION_HEAD}>
          Queue <span className="font-ui text-sm font-medium text-ink-variant tabular-nums">{count}</span>
        </h3>
        {count > 0 &&
          (confirming ? (
            <ConfirmStep
              prompt={count === 1 ? "Clear 1 song?" : `Clear ${count} songs?`}
              confirmLabel="Clear"
              danger
              onConfirm={() => {
                setConfirming(false);
                onClear();
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-card px-2 py-1 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              Clear
            </button>
          ))}
      </div>

      {count === 0 ? (
        <p className="rounded-card border border-dashed border-line-soft px-4 py-5 font-ui text-sm text-ink-variant">
          Nothing queued. Songs added here play before the playlist carries on.
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-line-soft/70 rounded-card border border-line-soft bg-paper-raised">
          {queue.map((entry, index) => (
            <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
              <TrackArt book={booksById.get(entry.track.id)} className="w-10" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-ui text-sm font-semibold tracking-[-0.01em] text-ink">{entry.track.title}</p>
                {trackByline(entry.track.artist, entry.track.album) && (
                  <p className="truncate font-ui text-xs text-ink-variant">
                    {trackByline(entry.track.artist, entry.track.album)}
                  </p>
                )}
                <p className="truncate font-ui text-xs text-ink-variant">Added by {entry.addedBy.name}</p>
              </div>
              <div className="flex shrink-0 items-center">
                <RemoteButton
                  size="sm"
                  label={`Move ${entry.track.title} up`}
                  onClick={() => onMove(entry.id, index - 1)}
                  disabled={index === 0}
                >
                  <UpIcon className="h-4 w-4" />
                </RemoteButton>
                <RemoteButton
                  size="sm"
                  label={`Move ${entry.track.title} down`}
                  onClick={() => onMove(entry.id, index + 1)}
                  disabled={index === count - 1}
                >
                  <DownIcon className="h-4 w-4" />
                </RemoteButton>
                <RemoteButton size="sm" label={`Remove ${entry.track.title} from the queue`} onClick={() => onRemove(entry.id)}>
                  <CloseIcon className="h-4 w-4" />
                </RemoteButton>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
