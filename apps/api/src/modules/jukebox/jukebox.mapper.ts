import {
  PLAYER_ONLINE_WINDOW_MS,
  voiceChannelSchema,
  type Player,
  type QueueEntry,
  type Track,
  type VoiceChannel,
} from "@ebook-reader/shared";
import { z } from "zod";
import type { PlayerRow, QueueEntryRow, TrackSourceRow } from "./jukebox.types.js";

/** Row → wire for the Jukebox. Artist, album and track number are the library's own columns. */
export function toTrack(row: TrackSourceRow): Track {
  return {
    id: row.id,
    title: row.title,
    artist: row.author,
    album: row.series,
    trackNumber: row.series_index,
    durationSeconds: row.duration_seconds,
  };
}

export function toQueueEntry(row: QueueEntryRow, track: Track): QueueEntry {
  return {
    id: row.id,
    track,
    addedBy: { kind: row.added_by_kind, name: row.added_by_name },
    addedAt: row.added_at,
  };
}

const storedChannels = z.array(voiceChannelSchema);

/** The stored channel list, or none if it no longer parses. Never a 500. */
export function storedVoiceChannels(raw: string): VoiceChannel[] {
  try {
    const parsed = storedChannels.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The stored shuffle picks, as book ids. */
export function storedPicks(raw: string): string[] {
  try {
    const decoded: unknown = JSON.parse(raw);
    return Array.isArray(decoded) ? decoded.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function isOnline(row: PlayerRow, now: Date): boolean {
  if (row.last_seen_at === null) return false;
  return now.getTime() - Date.parse(row.last_seen_at) < PLAYER_ONLINE_WINDOW_MS;
}

export function toPlayer(
  row: PlayerRow,
  parts: { track: Track | null; queue: QueueEntry[]; upcoming: Track[]; now: Date },
): Player {
  return {
    guildId: row.guild_id,
    guildName: row.guild_name,
    online: isOnline(row, parts.now),
    lastSeenAt: row.last_seen_at,
    voiceChannel:
      row.voice_channel_id === null ? null : { id: row.voice_channel_id, name: row.voice_channel_name ?? "" },
    voiceChannels: storedVoiceChannels(row.voice_channels),
    state: row.state,
    playId: row.play_id,
    track: parts.track,
    positionMs: row.position_ms,
    positionAt: row.position_at,
    shuffle: row.shuffle === 1,
    repeat: row.repeat,
    queue: parts.queue,
    upcoming: parts.upcoming,
  };
}
