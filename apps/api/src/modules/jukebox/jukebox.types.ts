import type { AddedByKind, PlayerState, RepeatMode } from "@ebook-reader/shared";

/** A `jukebox_players` row: one Discord guild's Player (D57). */
export interface PlayerRow {
  guild_id: string;
  guild_name: string;
  voice_channel_id: string | null;
  voice_channel_name: string | null;
  /** JSON `[{id, name}]`, the voice channels the bot last reported. */
  voice_channels: string;
  state: PlayerState;
  /** Up by one every time the current Track starts, a repeat included. */
  play_id: number;
  current_book_id: string | null;
  /** 1 when the current Track came from the Playlist, 0 from the Queue. */
  current_from_playlist: number;
  position_ms: number;
  /** When `position_ms` was true. Null while idle. */
  position_at: string | null;
  /** The last Track played from the Playlist. Queue plays never move it. */
  playlist_cursor_book_id: string | null;
  shuffle: number;
  /** JSON array of book ids: the Playlist Tracks shuffle has already picked. */
  shuffle_picks: string;
  repeat: RepeatMode;
  last_seen_at: string | null;
  updated_at: string;
}

export interface QueueEntryRow {
  id: number;
  guild_id: string;
  book_id: string;
  sort_key: number;
  added_by_kind: AddedByKind;
  added_by_name: string;
  added_at: string;
}

export interface HistoryRow {
  id: number;
  guild_id: string;
  book_id: string;
  from_playlist: number;
  played_at: string;
}

export interface CommandRow {
  id: number;
  guild_id: string;
  /** JSON: a `BotCommand` without its `id` and `guildId`, which are the row's. */
  body: string;
  created_at: string;
}

/** The `books` columns a Track is built from. */
export interface TrackSourceRow {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
  series_index: number | null;
  duration_seconds: number | null;
}
