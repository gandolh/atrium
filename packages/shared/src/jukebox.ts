import { z } from "zod";

/**
 * Jukebox contract (brief 81; D55, D56, D57). The Discord bot (just-a-bot)
 * plays atrium's music, and atrium owns every Player: the voice channel, the
 * Track playing, the Queue, shuffle and repeat. People steer a Player from the
 * Jukebox page (brief 82) and from Discord's `/jukebox` command, and both go
 * through these routes, so a Player has exactly one writer.
 *
 * just-a-bot briefs 25 to 27 restate these shapes. Change one only with a note
 * in all four briefs. Vocabulary: corpus/wiki/glossary-jukebox.md.
 */

/** A Discord snowflake: a guild or a channel id. */
export const DISCORD_ID_PATTERN = /^\d{17,20}$/;
export const discordIdSchema = z.string().regex(DISCORD_ID_PATTERN);

/** The longest `wait` a bot long-poll may ask for, in seconds. */
export const JUKEBOX_MAX_WAIT_SECONDS = 20;

/** A Player is `online` while the bot was last seen less than this long ago. */
export const PLAYER_ONLINE_WINDOW_MS = 30_000;

/** How many Tracks `upcoming` names: the Queue first, then the Playlist. */
export const UPCOMING_LENGTH = 2;

/** The longest Discord display name a Queue entry records. */
export const MAX_ADDED_BY_NAME = 64;

/**
 * A library item of kind `audio`, as the Jukebox plays it. The bot builds
 * `/library/:id/file` and `/library/:id/cover` from `id`. Artist, album and
 * track number are the library's `author`, `series` and `series_index`.
 */
export const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  trackNumber: z.number().nullable(),
  durationSeconds: z.number().nullable(),
});
export type Track = z.infer<typeof trackSchema>;

/** Where a Queue entry came from: a profile in atrium, or a name in Discord. */
export const ADDED_BY_KINDS = ["profile", "discord"] as const;
export const addedByKindSchema = z.enum(ADDED_BY_KINDS);
export type AddedByKind = z.infer<typeof addedByKindSchema>;

export const queueEntrySchema = z.object({
  id: z.number().int(),
  track: trackSchema,
  addedBy: z.object({ kind: addedByKindSchema, name: z.string() }),
  addedAt: z.string(),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

export const voiceChannelSchema = z.object({ id: discordIdSchema, name: z.string() });
export type VoiceChannel = z.infer<typeof voiceChannelSchema>;

export const PLAYER_STATES = ["idle", "playing", "paused"] as const;
export const playerStateSchema = z.enum(PLAYER_STATES);
export type PlayerState = z.infer<typeof playerStateSchema>;

export const REPEAT_MODES = ["off", "one", "all"] as const;
export const repeatModeSchema = z.enum(REPEAT_MODES);
export type RepeatMode = z.infer<typeof repeatModeSchema>;

/**
 * One guild's Jukebox state. `online` means the bot was seen in the last
 * `PLAYER_ONLINE_WINDOW_MS`. `playId` goes up by one every time the current
 * Track starts, a repeat of the same Track included. `positionMs` is what the
 * bot measured at `positionAt`. `upcoming` is the next `UPCOMING_LENGTH`
 * Tracks: the Queue first, then the Playlist.
 */
export const playerSchema = z.object({
  guildId: discordIdSchema,
  guildName: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  voiceChannel: voiceChannelSchema.nullable(),
  voiceChannels: z.array(voiceChannelSchema),
  state: playerStateSchema,
  playId: z.number().int(),
  track: trackSchema.nullable(),
  positionMs: z.number().int(),
  positionAt: z.string().nullable(),
  shuffle: z.boolean(),
  repeat: repeatModeSchema,
  queue: z.array(queueEntrySchema),
  upcoming: z.array(trackSchema),
});
export type Player = z.infer<typeof playerSchema>;
export const playerListSchema = z.array(playerSchema);

/** What the bot is told to do, down the long-poll. `id` is the poll cursor. */
const commandBase = { id: z.number().int(), guildId: discordIdSchema };
export const botCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...commandBase, kind: z.literal("join"), channelId: discordIdSchema }),
  z.object({ ...commandBase, kind: z.literal("leave") }),
  z.object({
    ...commandBase,
    kind: z.literal("play"),
    playId: z.number().int(),
    track: trackSchema,
    upcoming: z.array(trackSchema),
  }),
  z.object({ ...commandBase, kind: z.literal("pause") }),
  z.object({ ...commandBase, kind: z.literal("resume") }),
  z.object({ ...commandBase, kind: z.literal("stop") }),
  z.object({ ...commandBase, kind: z.literal("upcoming"), upcoming: z.array(trackSchema) }),
]);
export type BotCommand = z.infer<typeof botCommandSchema>;

/** `GET /jukebox/bot/commands` response. */
export const botCommandsResponseSchema = z.object({
  cursor: z.number().int(),
  commands: z.array(botCommandSchema),
});
export type BotCommandsResponse = z.infer<typeof botCommandsResponseSchema>;

/** `GET /jukebox/bot/commands` query. A `wait` past the maximum is clamped. */
export const botCommandsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  wait: z.coerce
    .number()
    .min(0)
    .default(0)
    .transform((seconds) => Math.min(seconds, JUKEBOX_MAX_WAIT_SECONDS)),
});

/** `POST /jukebox/players/:guildId/control` body. */
export const SIMPLE_CONTROL_ACTIONS = ["play", "pause", "resume", "next", "previous", "stop", "leave"] as const;
export const controlRequestSchema = z.union([
  z.object({ action: z.enum(SIMPLE_CONTROL_ACTIONS) }),
  z.object({ action: z.literal("join"), channelId: discordIdSchema }),
  z.object({ action: z.literal("playTrack"), bookId: z.string().min(1) }),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;

/** `PATCH /jukebox/players/:guildId/settings` body. */
export const settingsRequestSchema = z.object({
  shuffle: z.boolean().optional(),
  repeat: repeatModeSchema.optional(),
});
export type SettingsRequest = z.infer<typeof settingsRequestSchema>;

/**
 * `POST /jukebox/players/:guildId/queue` body. `addedBy` is read from the bot
 * account only, which must send it. A person's entry takes the active
 * profile's name, and any `addedBy` they send is ignored.
 */
export const QUEUE_POSITIONS = ["end", "next"] as const;
export const queueAddRequestSchema = z.object({
  bookId: z.string().min(1),
  at: z.enum(QUEUE_POSITIONS),
  addedBy: z.object({ name: z.string().trim().min(1).max(MAX_ADDED_BY_NAME) }).optional(),
});
export type QueueAddRequest = z.infer<typeof queueAddRequestSchema>;

/** `POST /jukebox/players/:guildId/queue/:entryId/move` body. */
export const queueMoveRequestSchema = z.object({ toIndex: z.number().int().min(0) });
export type QueueMoveRequest = z.infer<typeof queueMoveRequestSchema>;

/** `POST /jukebox/bot/status` body: the bot's view of one guild. */
export const botStatusRequestSchema = z.object({
  guildId: discordIdSchema,
  guildName: z.string().min(1).max(100),
  voiceChannel: voiceChannelSchema.nullable(),
  voiceChannels: z.array(voiceChannelSchema).max(500),
  playId: z.number().int().min(0),
  state: playerStateSchema,
  positionMs: z.number().int().min(0),
});
export type BotStatusRequest = z.infer<typeof botStatusRequestSchema>;

export const botStatusResponseSchema = z.object({ upcoming: z.array(trackSchema) });
export type BotStatusResponse = z.infer<typeof botStatusResponseSchema>;

/** `POST /jukebox/bot/players/:guildId/advance` body. */
export const ADVANCE_REASONS = ["ended", "error"] as const;
export const botAdvanceRequestSchema = z.object({
  playId: z.number().int().min(0),
  reason: z.enum(ADVANCE_REASONS),
});
export type BotAdvanceRequest = z.infer<typeof botAdvanceRequestSchema>;

export const jukeboxPlaySchema = z.object({
  playId: z.number().int(),
  track: trackSchema,
  upcoming: z.array(trackSchema),
});
export type JukeboxPlay = z.infer<typeof jukeboxPlaySchema>;

/** `advance` answers `stale: true`, and changes nothing, when `playId` is old. */
export const botAdvanceResponseSchema = z.object({
  play: jukeboxPlaySchema.nullable(),
  stale: z.literal(true).optional(),
});
export type BotAdvanceResponse = z.infer<typeof botAdvanceResponseSchema>;

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Empty values sort after every present one. */
function compareText(a: string | null, b: string | null): number {
  const left = a?.trim() ?? "";
  const right = b?.trim() ?? "";
  if (left === "" || right === "") return left === right ? 0 : left === "" ? 1 : -1;
  return collator.compare(left, right);
}

function compareNumber(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/**
 * Playlist order (D56): artist, then album, then track number, then title,
 * case-insensitive, with empty values last. The id breaks a full tie, so the
 * order is total and "the Track after the cursor" always has one answer. The
 * API and the Jukebox page both sort with this.
 */
export function comparePlaylistOrder(
  a: Pick<Track, "id" | "title" | "artist" | "album" | "trackNumber">,
  b: Pick<Track, "id" | "title" | "artist" | "album" | "trackNumber">,
): number {
  return (
    compareText(a.artist, b.artist) ||
    compareText(a.album, b.album) ||
    compareNumber(a.trackNumber, b.trackNumber) ||
    compareText(a.title, b.title) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
