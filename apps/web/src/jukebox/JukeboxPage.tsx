import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LibraryBook } from "@ebook-reader/shared";

import { AppHeader } from "../components/AppHeader";
import { QuietSelect } from "../components/QuietSelect";
import { useDeleteBook, useUploadQueue } from "../lib/use-library";
import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { NowPlaying } from "./NowPlaying";
import { PlaylistPanel } from "./PlaylistPanel";
import { QueuePanel } from "./QueuePanel";
import {
  jukeboxErrorMessage,
  jukeboxPlayersKey,
  useAddToQueue,
  useClearQueue,
  useControl,
  useJukeboxPlayers,
  useMoveInQueue,
  usePlaylist,
  useRemoveFromQueue,
  useSettings,
} from "./use-jukebox";

/**
 * `/jukebox` (brief 82; D56, D57): a remote for the Discord bot, "like VLC or
 * Winamp". Anyone signed in, on any profile, steers the same Players. Atrium
 * owns each Player and this page polls it every 1.5 s; every button is a
 * request to atrium, which queues a command for the bot. Nothing plays in this
 * browser. The Dock is local playback and stays out of it.
 */
export function JukeboxPage() {
  useApplyTheme();
  const qc = useQueryClient();
  const players = useJukeboxPlayers({ poll: true });
  const playlist = usePlaylist();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = players.data ?? [];
  const player = list.find((p) => p.guildId === selectedId) ?? list[0];
  const booksById = useMemo(() => new Map(playlist.tracks.map((t) => [t.id, t])), [playlist.tracks]);

  const control = useControl();
  const settings = useSettings();
  const addToQueue = useAddToQueue();
  const removeFromQueue = useRemoveFromQueue();
  const moveInQueue = useMoveInQueue();
  const clearQueue = useClearQueue();
  const deleteBook = useDeleteBook();
  const uploads = useUploadQueue();

  /** Every write reports the same way: the last failure, cleared by the next success. */
  const report = { onSuccess: () => setError(null), onError: (e: unknown) => setError(jukeboxErrorMessage(e)) };

  function remove(book: LibraryBook) {
    deleteBook.mutate(book, {
      onSuccess: () => {
        setError(null);
        // The delete reached into every Player's Queue and current Track.
        void qc.invalidateQueries({ queryKey: jukeboxPlayersKey });
      },
      onError: () => setError(`Couldn't delete “${book.title}”. Try again.`),
    });
  }

  const guildId = player?.guildId;
  const uploadLabel =
    uploads.progress && uploads.progress.total > 1
      ? `Adding ${uploads.progress.current} of ${uploads.progress.total}…`
      : "Uploading…";

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-6xl flex-col gap-8 px-page py-8 text-ink">
      <AppHeader />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-3xl font-semibold text-ink">Jukebox</h2>
          {list.length > 1 && player && (
            <QuietSelect
              label="Server"
              value={player.guildId}
              options={list.map((p) => ({ value: p.guildId, label: p.online ? p.guildName : `${p.guildName} (offline)` }))}
              onChange={setSelectedId}
            />
          )}
        </div>
        <p className="max-w-2xl font-ui text-sm text-ink-variant">
          Steer the Discord bot. Songs play in the voice channel, not in this browser.
          {player && list.length === 1 && (
            <>
              {" "}
              Server: <span className="font-medium text-ink">{player.guildName}</span>.
            </>
          )}
        </p>
      </div>

      {players.isLoading ? (
        <div className="h-64 rounded-card border border-line-soft bg-paper-container/40 motion-safe:animate-pulse" aria-hidden />
      ) : players.isError && !players.data ? (
        <Notice title="Couldn't load the Jukebox">
          The API may be offline.{" "}
          <button
            type="button"
            onClick={() => void players.refetch()}
            className="rounded font-medium text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            Try again
          </button>
        </Notice>
      ) : !player ? (
        <Notice title="The bot hasn't checked in yet">
          Once the Discord bot is running and signed in, each server it is in shows up here. Songs can be added and
          deleted below in the meantime.
        </Notice>
      ) : (
        <>
          {!player.online && (
            <Notice title="The bot is offline">
              The controls come back when it checks in again. The queue still takes changes, and the bot picks them up
              then.
            </Notice>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2">
            <NowPlaying
              player={player}
              book={player.track ? booksById.get(player.track.id) : undefined}
              onControl={(request) => control.mutate({ guildId: player.guildId, args: request }, report)}
              onSettings={(request) => settings.mutate({ guildId: player.guildId, args: request }, report)}
            />
            <QueuePanel
              player={player}
              booksById={booksById}
              onRemove={(entryId) => removeFromQueue.mutate({ guildId: player.guildId, args: entryId }, report)}
              onMove={(entryId, toIndex) =>
                moveInQueue.mutate({ guildId: player.guildId, args: { entryId, toIndex } }, report)
              }
              onClear={() => clearQueue.mutate({ guildId: player.guildId, args: undefined }, report)}
            />
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger-soft/50 px-4 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <PlaylistPanel
        tracks={playlist.tracks}
        currentId={player?.track?.id ?? null}
        offline={!player?.online}
        upload={{ add: uploads.add, busy: uploads.progress !== null, busyLabel: uploadLabel, failed: uploads.failed }}
        onPlay={
          guildId
            ? (bookId) => control.mutate({ guildId, args: { action: "playTrack", bookId } }, report)
            : undefined
        }
        onQueue={guildId ? (bookId, at) => addToQueue.mutate({ guildId, args: { bookId, at } }, report) : undefined}
        onDelete={remove}
      />
    </main>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="status" className="flex flex-col gap-1 rounded-card border border-line-soft bg-paper-low px-4 py-3">
      <p className="font-ui text-sm font-semibold text-ink">{title}</p>
      <p className="font-ui text-sm text-ink-variant">{children}</p>
    </div>
  );
}
