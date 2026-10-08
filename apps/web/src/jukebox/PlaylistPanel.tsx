import { useMemo, useRef, useState } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { UploadZone, type UploadZoneHandle } from "../library/UploadZone";
import { formatTime } from "../player/format-time";
import { PlayIcon } from "../player/transport";
import { ConfirmStep, RemoteButton, TrackArt, trackByline } from "./controls";
import { QueueAddIcon, QueueNextIcon, SpeakerIcon, TrashIcon } from "./icons";
import { SECTION_HEAD } from "./QueuePanel";

/**
 * The Playlist (D56): every song in the library, in the order a Player walks
 * it, and the place to add and delete songs. Upload is the ordinary library
 * upload, MP3 only. Delete is the ordinary library delete, so it asks twice
 * and says plainly that the song goes for everyone.
 */
export function PlaylistPanel({
  tracks,
  currentId,
  offline,
  upload,
  onPlay,
  onQueue,
  onDelete,
}: {
  tracks: LibraryBook[];
  /** The Track the selected Player is on, marked in the list. */
  currentId: string | null;
  /** The bot is offline: "Play now" is a control, so it waits; queueing still works. */
  offline: boolean;
  upload: { add: (files: File[]) => void; busy: boolean; busyLabel: string; failed: string[] };
  /** Absent while there is no Player to play on or queue to. */
  onPlay?: (bookId: string) => void;
  onQueue?: (bookId: string, at: "next" | "end") => void;
  onDelete: (book: LibraryBook) => void;
}) {
  const [filter, setFilter] = useState("");
  const browse = useRef<UploadZoneHandle | null>(null);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((t) => [t.title, t.author, t.series].some((field) => field?.toLowerCase().includes(needle)));
  }, [tracks, filter]);

  return (
    <section aria-label="Playlist" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={SECTION_HEAD}>
          Playlist{" "}
          <span className="font-ui text-sm font-medium text-ink-variant tabular-nums">{tracks.length}</span>
        </h3>
        <button
          type="button"
          onClick={() => browse.current?.browse()}
          disabled={upload.busy}
          className="rounded-card bg-ink-fill px-4 py-2 font-ui text-sm font-semibold text-on-ink-fill tabular-nums transition hover:opacity-90 disabled:bg-paper-container disabled:text-ink-variant"
        >
          {upload.busy ? upload.busyLabel : "+ Add songs"}
        </button>
      </div>
      <p className="font-ui text-sm text-ink-variant">
        Every song in the library, in the order the bot plays them. Added songs join the library for everyone.
      </p>

      <UploadZone variant="ambient" audioOnly onFiles={upload.add} busy={upload.busy} browseRef={browse} />
      {upload.failed.length > 0 && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger-soft/50 px-4 py-2.5 text-sm text-danger">
          Couldn't add: {upload.failed.join(", ")}
        </p>
      )}

      {tracks.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="sr-only">Filter songs</span>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by title, artist or album"
            className="w-full rounded-card border border-line bg-paper-raised px-3 py-2 font-ui text-sm text-ink transition outline-none placeholder:text-ink-variant focus:border-accent sm:max-w-sm"
          />
        </label>
      )}

      {tracks.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-soft px-4 py-5 font-ui text-sm text-ink-variant">
          No songs yet. Add MP3s and the bot can play them in every server.
        </p>
      ) : shown.length === 0 ? (
        <p className="px-1 py-3 font-ui text-sm text-ink-variant">No songs match “{filter.trim()}”.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line-soft/70 rounded-card border border-line-soft bg-paper-raised">
          {shown.map((track) => (
            <PlaylistRow
              key={track.id}
              track={track}
              current={track.id === currentId}
              offline={offline}
              onPlay={onPlay}
              onQueue={onQueue}
              onDelete={onDelete}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function PlaylistRow({
  track,
  current,
  offline,
  onPlay,
  onQueue,
  onDelete,
}: {
  track: LibraryBook;
  current: boolean;
  offline: boolean;
  onPlay?: (bookId: string) => void;
  onQueue?: (bookId: string, at: "next" | "end") => void;
  onDelete: (book: LibraryBook) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const byline = trackByline(track.author, track.series);

  return (
    <li
      aria-current={current ? "true" : undefined}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 py-2 pr-2 pl-2.5 ${
        current ? "border-accent" : "border-transparent"
      }`}
    >
      <TrackArt book={track} className="w-10" />
      <div className="min-w-0 flex-1">
        <p
          className={`flex items-center gap-1.5 truncate font-ui text-sm font-semibold tracking-[-0.01em] ${
            current ? "text-accent" : "text-ink"
          }`}
        >
          {current && <SpeakerIcon className="h-4 w-4 shrink-0" />}
          <span className="truncate">{track.title}</span>
        </p>
        <p className="truncate font-ui text-xs text-ink-variant tabular-nums">
          {[byline, track.durationSeconds != null ? formatTime(track.durationSeconds) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {confirming ? (
        <ConfirmStep
          prompt="Delete from atrium for everyone?"
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            setConfirming(false);
            onDelete(track);
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="flex shrink-0 items-center">
          {onPlay && (
            <RemoteButton size="sm" label={`Play ${track.title} now`} onClick={() => onPlay(track.id)} disabled={offline}>
              <PlayIcon className="h-4 w-4" />
            </RemoteButton>
          )}
          {onQueue && (
            <>
              <RemoteButton size="sm" label={`Play ${track.title} next`} onClick={() => onQueue(track.id, "next")}>
                <QueueNextIcon className="h-4 w-4" />
              </RemoteButton>
              <RemoteButton size="sm" label={`Add ${track.title} to the queue`} onClick={() => onQueue(track.id, "end")}>
                <QueueAddIcon className="h-4 w-4" />
              </RemoteButton>
            </>
          )}
          <RemoteButton size="sm" label={`Delete ${track.title}`} onClick={() => setConfirming(true)}>
            <TrashIcon className="h-4 w-4" />
          </RemoteButton>
        </div>
      )}
    </li>
  );
}
