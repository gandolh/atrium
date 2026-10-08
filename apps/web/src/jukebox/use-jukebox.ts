import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { comparePlaylistOrder, type LibraryBook, type Player } from "@ebook-reader/shared";

import { useLibraryList } from "../lib/use-library";
import { ApiError } from "../lib/api-client";
import {
  addToQueue,
  changePlayerSettings,
  clearQueue,
  controlPlayer,
  fetchPlayers,
  moveQueueEntry,
  removeQueueEntry,
} from "./jukebox-api";

/**
 * Data for the Jukebox (brief 82; D56, D57). Atrium owns every Player and the
 * page polls it: the bot is steered by commands atrium queues, so what this
 * page shows is atrium's view, not a stream from Discord.
 *
 * Players are not per profile. Every profile on every account sees and steers
 * the same Players, so the key carries no profile id.
 */
export const jukeboxPlayersKey = ["jukebox", "players"] as const;

/** How often the page asks for the Players while it is open and visible (D57: 1 to 2 s). */
const POLL_MS = 1_500;

/**
 * The Players. `poll` is the Jukebox page itself. React Query's default
 * `refetchIntervalInBackground: false` stops the polling while the tab is
 * hidden. Without `poll` (the home grid's "Add to Discord queue") one fetch
 * is enough: the list of guilds barely changes.
 */
export function useJukeboxPlayers({ poll }: { poll: boolean }) {
  return useQuery({
    queryKey: jukeboxPlayersKey,
    queryFn: fetchPlayers,
    refetchInterval: poll ? POLL_MS : false,
    staleTime: poll ? 0 : 60_000,
    retry: poll ? 3 : false,
  });
}

/**
 * A write that answers with the new `Player`: put it straight into the cache,
 * so the change shows before the next poll.
 */
function usePlayerWrite<A>(write: (guildId: string, args: A) => Promise<Player>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ guildId, args }: { guildId: string; args: A }) => write(guildId, args),
    onSuccess: (player) => {
      qc.setQueryData<Player[]>(jukeboxPlayersKey, (players) =>
        players?.some((p) => p.guildId === player.guildId)
          ? players.map((p) => (p.guildId === player.guildId ? player : p))
          : [...(players ?? []), player],
      );
    },
    // A refused control (the bot just went offline) means the cached Player
    // is out of date: fetch it again rather than waiting for the poll.
    onError: () => void qc.invalidateQueries({ queryKey: jukeboxPlayersKey }),
  });
}

export const useControl = () => usePlayerWrite(controlPlayer);
export const useSettings = () => usePlayerWrite(changePlayerSettings);
export const useAddToQueue = () => usePlayerWrite(addToQueue);
export const useRemoveFromQueue = () => usePlayerWrite(removeQueueEntry);
export const useMoveInQueue = () =>
  usePlayerWrite((guildId: string, { entryId, toIndex }: { entryId: number; toIndex: number }) =>
    moveQueueEntry(guildId, entryId, toIndex),
  );
export const useClearQueue = () => usePlayerWrite((guildId: string, _: undefined) => clearQueue(guildId));

/** What a failed Jukebox write tells the person. */
export function jukeboxErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | undefined)?.error;
    if (code === "PLAYER_OFFLINE") return "The bot is offline, so nothing would act on that.";
    if (code === "NOT_A_TRACK") return "That isn't a song.";
    if (code === "ENTRY_NOT_FOUND") return "That song already left the queue.";
    if (code === "PLAYER_NOT_FOUND") return "The bot no longer knows this server.";
  }
  return "Couldn't reach atrium. Try again.";
}

/** The Playlist (D56): every song in the library, in the order a Player walks it. */
export function usePlaylist(): { tracks: LibraryBook[]; isLoading: boolean; isError: boolean } {
  const { books, isLoading, isError } = useLibraryList("recent");
  const tracks = useMemo(
    () =>
      books
        .filter((book) => book.kind === "audio")
        .sort((a, b) => comparePlaylistOrder(playlistKey(a), playlistKey(b))),
    [books],
  );
  return { tracks, isLoading, isError };
}

function playlistKey(book: LibraryBook) {
  return {
    id: book.id,
    title: book.title,
    artist: book.author,
    album: book.series,
    trackNumber: book.seriesIndex,
  };
}

/**
 * Where the current Track is, in milliseconds. While playing it moves on from
 * the bot's last measurement (`positionMs` at `positionAt`) between polls, so
 * the bar runs smoothly; paused or idle it holds.
 */
export function useLivePosition(player: Player | undefined): number {
  const playing = player?.state === "playing";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [playing]);
  if (!player) return 0;
  if (!playing || player.positionAt === null) return player.positionMs;
  return player.positionMs + Math.max(0, now - Date.parse(player.positionAt));
}
