import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { Knex } from "knex";
import {
  comparePlaylistOrder,
  UPCOMING_LENGTH,
  type BotAdvanceRequest,
  type BotAdvanceResponse,
  type BotCommand,
  type BotCommandsResponse,
  type BotStatusRequest,
  type ControlRequest,
  type Player,
  type QueueAddRequest,
  type SettingsRequest,
  type Track,
} from "@ebook-reader/shared";
import { knex } from "../../database/knex.js";
import { isOnline, storedPicks, storedVoiceChannels, toPlayer, toQueueEntry, toTrack } from "./jukebox.mapper.js";
import {
  clearQueueRows,
  commandSequence,
  deleteHistoryRow,
  deleteQueueRow,
  getPlayerRow,
  insertCommandRow,
  insertPlayerRow,
  insertQueueRow,
  listCommandRowsAfter,
  listHistoryRows,
  listPlayerRows,
  listQueueRows,
  pushHistoryRow,
  selectTrackRows,
  setQueueSortKey,
  touchAllPlayers,
  updatePlayerRow,
} from "./jukebox.model.js";
import type { CommandRow, PlayerRow } from "./jukebox.types.js";

/**
 * The Jukebox's rules (brief 81; D56, D57).
 *
 * Atrium owns every Player. People and Discord's slash commands change a
 * Player through these functions, each in one transaction, and every change
 * the bot has to act on is written to `jukebox_commands`. The bot holds a
 * long-poll open on that table and reports back on its own requests. Audio
 * never travels here: the bot fetches each Track from `GET /library/:id/file`.
 */

/** A refusal the controller answers as `{error: code}`. */
export class JukeboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Shuffle avoids the last this-many Tracks played, or n-1 in a smaller library. */
const SHUFFLE_LOOKBACK = 50;

/**
 * Wakes waiting long-polls. The API is one process (one container), so an
 * in-process emitter reaches every waiter. Emitted only after the transaction
 * that wrote the command has committed.
 */
const commandEvents = new EventEmitter();
commandEvents.setMaxListeners(0);

/** The Playlist, in order, and every Track by id. */
interface Playlist {
  tracks: Track[];
  byId: Map<string, Track>;
}

async function loadPlaylist(db: Knex): Promise<Playlist> {
  const tracks = (await selectTrackRows(db)).map(toTrack).sort(comparePlaylistOrder);
  return { tracks, byId: new Map(tracks.map((track) => [track.id, track])) };
}

/** The Tracks in the Playlist, `q` matched against title, artist and album. */
export async function searchTracks(q: string | undefined): Promise<Track[]> {
  const { tracks } = await loadPlaylist(knex);
  const needle = q?.trim().toLowerCase();
  if (!needle) return tracks;
  return tracks.filter((track) =>
    [track.title, track.artist, track.album].some((field) => field?.toLowerCase().includes(needle)),
  );
}

/** A `BotCommand` as stored: its `id` and `guildId` are the row's own. */
type CommandBody = BotCommand extends infer C ? (C extends BotCommand ? Omit<C, "id" | "guildId"> : never) : never;

type PendingCommand = "join" | "leave" | "play" | "pause" | "resume" | "stop" | "upcoming";

/**
 * One operation on one Player, inside one transaction. `row` is kept current
 * as the operation writes, and `commands` collects what the bot must be told,
 * written once the operation is done so a `play` carries the final `upcoming`.
 */
interface Op {
  trx: Knex.Transaction;
  row: PlayerRow;
  playlist: Playlist;
  now: Date;
  commands: PendingCommand[];
  joinChannelId?: string;
}

async function patch(op: Op, changes: Partial<PlayerRow>): Promise<void> {
  const next = { ...changes, updated_at: op.now.toISOString() };
  await updatePlayerRow(op.trx, op.row.guild_id, next);
  op.row = { ...op.row, ...next };
}

/** The position now, extrapolated from the bot's last measurement while playing. */
function livePosition(row: PlayerRow, now: Date): number {
  if (row.state !== "playing" || row.position_at === null) return row.position_ms;
  return row.position_ms + Math.max(0, now.getTime() - Date.parse(row.position_at));
}

// --- Shuffle --------------------------------------------------------------

/**
 * Keep `UPCOMING_LENGTH` shuffle picks stored, so `upcoming` is the same on
 * every poll until something consumes a pick or the settings change. A pick is
 * a random Track not among the last 50 played (or n-1, for a smaller library)
 * and not already picked. Picks of deleted Tracks are dropped here, since the
 * foreign keys cannot reach into a JSON column.
 */
async function ensurePicks(op: Op): Promise<string[]> {
  if (op.row.shuffle !== 1) return [];
  const stored = storedPicks(op.row.shuffle_picks);
  const picks = stored.filter((id) => op.playlist.byId.has(id)).slice(0, UPCOMING_LENGTH);
  const all = op.playlist.tracks.map((track) => track.id);

  if (picks.length < UPCOMING_LENGTH && all.length > 0) {
    const lookback = Math.min(SHUFFLE_LOOKBACK, all.length - 1);
    const recent: string[] = [];
    if (op.row.current_book_id !== null) recent.push(op.row.current_book_id);
    for (const entry of await listHistoryRows(op.trx, op.row.guild_id, SHUFFLE_LOOKBACK)) {
      if (!recent.includes(entry.book_id)) recent.push(entry.book_id);
    }
    const avoid = new Set(recent.slice(0, lookback));
    while (picks.length < UPCOMING_LENGTH) {
      let pool = all.filter((id) => !avoid.has(id) && !picks.includes(id));
      if (pool.length === 0) pool = all.filter((id) => !picks.includes(id));
      if (pool.length === 0) pool = all;
      picks.push(pool[randomInt(pool.length)]);
    }
  }

  if (JSON.stringify(picks) !== JSON.stringify(stored)) {
    await patch(op, { shuffle_picks: JSON.stringify(picks) });
  }
  return picks;
}

// --- Next-Track rules -------------------------------------------------------

/** The Playlist Track after the cursor. At the end, `all` wraps and `off` gives none. */
function playlistAfterCursor(op: Op, wrap: boolean): Track | null {
  const { tracks } = op.playlist;
  if (tracks.length === 0) return null;
  const cursor = op.row.playlist_cursor_book_id;
  const index = cursor === null ? -1 : tracks.findIndex((track) => track.id === cursor);
  if (index + 1 < tracks.length) return tracks[index + 1];
  return wrap ? tracks[0] : null;
}

/** The next `count` Tracks: the Queue first, then the Playlist. */
async function computeUpcoming(op: Op, count = UPCOMING_LENGTH): Promise<Track[]> {
  const upcoming: Track[] = [];
  for (const entry of await listQueueRows(op.trx, op.row.guild_id)) {
    if (upcoming.length === count) return upcoming;
    const track = op.playlist.byId.get(entry.book_id);
    if (track) upcoming.push(track);
  }
  if (op.row.shuffle === 1) {
    for (const id of await ensurePicks(op)) {
      if (upcoming.length === count) break;
      const track = op.playlist.byId.get(id);
      if (track) upcoming.push(track);
    }
    return upcoming;
  }
  const { tracks } = op.playlist;
  let index = tracks.findIndex((track) => track.id === op.row.playlist_cursor_book_id);
  while (upcoming.length < count && tracks.length > 0) {
    index += 1;
    if (index >= tracks.length) {
      if (op.row.repeat !== "all") break;
      index = 0;
    }
    upcoming.push(tracks[index]);
  }
  return upcoming;
}

interface NextPick {
  track: Track;
  fromPlaylist: boolean;
}

/**
 * Take what plays next: the Queue head, else the Playlist. Shuffle takes its
 * first pick and never runs out. Otherwise the Playlist continues after the
 * cursor, and at its end `repeat: all` wraps and `off` gives nothing.
 * `wrapAnyway` is Play from idle, which starts over rather than stopping.
 */
async function takeNext(op: Op, wrapAnyway = false): Promise<NextPick | null> {
  for (const entry of await listQueueRows(op.trx, op.row.guild_id)) {
    await deleteQueueRow(op.trx, op.row.guild_id, entry.id);
    const track = op.playlist.byId.get(entry.book_id);
    if (track) return { track, fromPlaylist: false };
  }
  if (op.row.shuffle === 1) {
    const [first, ...rest] = await ensurePicks(op);
    if (first === undefined) return null;
    await patch(op, { shuffle_picks: JSON.stringify(rest) });
    return { track: op.playlist.byId.get(first)!, fromPlaylist: true };
  }
  const track = playlistAfterCursor(op, wrapAnyway || op.row.repeat === "all");
  return track ? { track, fromPlaylist: true } : null;
}

/** The current Track stops being current: record it, unless it is being replayed. */
async function retireCurrent(op: Op): Promise<void> {
  if (op.row.current_book_id === null) return;
  await pushHistoryRow(op.trx, {
    guild_id: op.row.guild_id,
    book_id: op.row.current_book_id,
    from_playlist: op.row.current_from_playlist,
    played_at: op.now.toISOString(),
  });
}

/**
 * Make `track` current under a new `play_id`. A Playlist Track moves the
 * cursor unless `moveCursor` says otherwise (Previous with shuffle on).
 */
async function startTrack(
  op: Op,
  pick: NextPick,
  options: { retire: boolean; moveCursor?: boolean },
): Promise<void> {
  if (options.retire) await retireCurrent(op);
  const moveCursor = options.moveCursor ?? pick.fromPlaylist;
  await patch(op, {
    state: "playing",
    play_id: op.row.play_id + 1,
    current_book_id: pick.track.id,
    current_from_playlist: pick.fromPlaylist ? 1 : 0,
    position_ms: 0,
    position_at: op.now.toISOString(),
    ...(moveCursor ? { playlist_cursor_book_id: pick.track.id } : {}),
  });
  // Refill after the change, so the new current Track counts as recently played.
  await ensurePicks(op);
}

/** Idle, with no current Track. The Queue, the cursor and the voice channel stay. */
async function goIdle(op: Op, extra: Partial<PlayerRow> = {}): Promise<void> {
  await retireCurrent(op);
  await patch(op, { state: "idle", current_book_id: null, position_ms: 0, position_at: null, ...extra });
}

/** Next: the button, `/jukebox skip`, or the bot's `error`. Always advances. */
async function next(op: Op): Promise<void> {
  const pick = await takeNext(op);
  if (pick) {
    await startTrack(op, pick, { retire: true });
    op.commands.push("play");
  } else {
    await goIdle(op);
    op.commands.push("stop");
  }
}

/** The current Track again, under a new `play_id`. */
async function replayCurrent(op: Op): Promise<boolean> {
  const track = op.row.current_book_id === null ? undefined : op.playlist.byId.get(op.row.current_book_id);
  if (!track) return false;
  await startTrack(op, { track, fromPlaylist: op.row.current_from_playlist === 1 }, { retire: false, moveCursor: false });
  return true;
}

/**
 * Previous: play the newest history entry and take it off the history. The
 * Track it replaces is not pushed, or two presses would swap back and forth.
 * A Playlist Track moves the cursor while shuffle is off. With no history, the
 * current Track restarts.
 */
async function previous(op: Op): Promise<void> {
  for (const entry of await listHistoryRows(op.trx, op.row.guild_id, 1)) {
    await deleteHistoryRow(op.trx, entry.id);
    const track = op.playlist.byId.get(entry.book_id);
    if (!track) continue;
    const fromPlaylist = entry.from_playlist === 1;
    await startTrack(op, { track, fromPlaylist }, { retire: false, moveCursor: fromPlaylist && op.row.shuffle !== 1 });
    op.commands.push("play");
    return;
  }
  if (await replayCurrent(op)) op.commands.push("play");
}

async function applyControl(op: Op, request: ControlRequest): Promise<void> {
  switch (request.action) {
    case "play": {
      if (op.row.state === "paused") {
        await patch(op, { state: "playing", position_at: op.now.toISOString() });
        op.commands.push("resume");
      } else if (op.row.state === "idle") {
        const pick = await takeNext(op, true);
        if (pick) {
          await startTrack(op, pick, { retire: true });
          op.commands.push("play");
        }
      }
      return;
    }
    case "pause":
      if (op.row.state === "playing") {
        await patch(op, {
          state: "paused",
          position_ms: livePosition(op.row, op.now),
          position_at: op.now.toISOString(),
        });
        op.commands.push("pause");
      }
      return;
    case "resume":
      if (op.row.state === "paused") {
        await patch(op, { state: "playing", position_at: op.now.toISOString() });
        op.commands.push("resume");
      }
      return;
    case "next":
      return next(op);
    case "previous":
      return previous(op);
    case "stop":
      await goIdle(op);
      op.commands.push("stop");
      return;
    case "leave":
      await goIdle(op, { voice_channel_id: null, voice_channel_name: null });
      op.commands.push("leave");
      return;
    case "join": {
      const known = storedVoiceChannels(op.row.voice_channels).find((channel) => channel.id === request.channelId);
      await patch(op, { voice_channel_id: request.channelId, voice_channel_name: known?.name ?? null });
      op.joinChannelId = request.channelId;
      op.commands.push("join");
      return;
    }
    case "playTrack": {
      const track = op.playlist.byId.get(request.bookId);
      if (!track) throw new JukeboxError(400, "NOT_A_TRACK");
      await startTrack(op, { track, fromPlaylist: true }, { retire: true });
      op.commands.push("play");
      return;
    }
  }
}

// --- Running an operation ---------------------------------------------------

async function writeCommands(op: Op): Promise<boolean> {
  if (op.commands.length === 0) return false;
  const upcoming = await computeUpcoming(op);
  for (const kind of op.commands) {
    let body: CommandBody;
    switch (kind) {
      case "play": {
        const track = op.row.current_book_id === null ? undefined : op.playlist.byId.get(op.row.current_book_id);
        if (!track) continue;
        body = { kind, playId: op.row.play_id, track, upcoming };
        break;
      }
      case "upcoming":
        body = { kind, upcoming };
        break;
      case "join":
        body = { kind, channelId: op.joinChannelId! };
        break;
      default:
        body = { kind };
    }
    await insertCommandRow(op.trx, op.row.guild_id, JSON.stringify(body), op.now);
  }
  return true;
}

async function buildPlayer(op: Op): Promise<Player> {
  const queueRows = await listQueueRows(op.trx, op.row.guild_id);
  const queue = queueRows.flatMap((entry) => {
    const track = op.playlist.byId.get(entry.book_id);
    return track ? [toQueueEntry(entry, track)] : [];
  });
  const upcoming = await computeUpcoming(op);
  const track = op.row.current_book_id === null ? null : (op.playlist.byId.get(op.row.current_book_id) ?? null);
  return toPlayer(op.row, { track, queue, upcoming, now: op.now });
}

/**
 * Run `fn` on one Player in one transaction, write the commands it queued,
 * and wake the long-polls once the transaction has committed.
 */
async function withPlayer<T>(
  guildId: string,
  fn: (op: Op) => Promise<T>,
  options: { create?: (trx: Knex.Transaction, now: Date) => Promise<void> } = {},
): Promise<T> {
  const now = new Date();
  let wrote = false;
  const result = await knex.transaction(async (trx) => {
    let row = await getPlayerRow(trx, guildId);
    if (!row && options.create) {
      await options.create(trx, now);
      row = await getPlayerRow(trx, guildId);
    }
    if (!row) throw new JukeboxError(404, "PLAYER_NOT_FOUND");
    const op: Op = { trx, row, playlist: await loadPlaylist(trx), now, commands: [] };
    const value = await fn(op);
    wrote = await writeCommands(op);
    return value;
  });
  if (wrote) commandEvents.emit("command");
  return result;
}

// --- People and the bot -----------------------------------------------------

export async function listPlayers(): Promise<Player[]> {
  const now = new Date();
  return knex.transaction(async (trx) => {
    const playlist = await loadPlaylist(trx);
    const players: Player[] = [];
    for (const row of await listPlayerRows(trx)) {
      players.push(await buildPlayer({ trx, row, playlist, now, commands: [] }));
    }
    return players;
  });
}

export async function readPlayer(guildId: string): Promise<Player> {
  return withPlayer(guildId, buildPlayer);
}

/** A control action. Refused with 409 while the bot is offline: nothing would act on it. */
export async function control(guildId: string, request: ControlRequest): Promise<Player> {
  return withPlayer(guildId, async (op) => {
    if (!isOnline(op.row, op.now)) throw new JukeboxError(409, "PLAYER_OFFLINE");
    await applyControl(op, request);
    return buildPlayer(op);
  });
}

export async function changeSettings(guildId: string, request: SettingsRequest): Promise<Player> {
  return withPlayer(guildId, async (op) => {
    const changes: Partial<PlayerRow> = {};
    if (request.repeat !== undefined) changes.repeat = request.repeat;
    if (request.shuffle !== undefined && (request.shuffle ? 1 : 0) !== op.row.shuffle) {
      // Fresh picks either way: turning shuffle on picks anew, off forgets them.
      changes.shuffle = request.shuffle ? 1 : 0;
      changes.shuffle_picks = "[]";
    }
    await patch(op, changes);
    op.commands.push("upcoming");
    return buildPlayer(op);
  });
}

/** Who added a Queue entry: the active profile, or the Discord name the bot sends. */
export type QueueAdder = { kind: "profile"; name: string } | { kind: "discord"; name: string };

export async function addToQueue(guildId: string, request: QueueAddRequest, adder: QueueAdder): Promise<Player> {
  return withPlayer(guildId, async (op) => {
    if (!op.playlist.byId.has(request.bookId)) throw new JukeboxError(400, "NOT_A_TRACK");
    const entries = await listQueueRows(op.trx, op.row.guild_id);
    const sortKey =
      entries.length === 0
        ? 0
        : request.at === "next"
          ? entries[0].sort_key - 1
          : entries[entries.length - 1].sort_key + 1;
    await insertQueueRow(op.trx, {
      guild_id: op.row.guild_id,
      book_id: request.bookId,
      sort_key: sortKey,
      added_by_kind: adder.kind,
      added_by_name: adder.name,
      added_at: op.now.toISOString(),
    });
    op.commands.push("upcoming");
    return buildPlayer(op);
  });
}

export async function removeFromQueue(guildId: string, entryId: number): Promise<Player> {
  return withPlayer(guildId, async (op) => {
    if ((await deleteQueueRow(op.trx, op.row.guild_id, entryId)) === 0) {
      throw new JukeboxError(404, "ENTRY_NOT_FOUND");
    }
    op.commands.push("upcoming");
    return buildPlayer(op);
  });
}

/** Move an entry to `toIndex` (clamped to the Queue), and renumber the Queue. */
export async function moveInQueue(guildId: string, entryId: number, toIndex: number): Promise<Player> {
  return withPlayer(guildId, async (op) => {
    const entries = await listQueueRows(op.trx, op.row.guild_id);
    const from = entries.findIndex((entry) => entry.id === entryId);
    if (from === -1) throw new JukeboxError(404, "ENTRY_NOT_FOUND");
    const [moved] = entries.splice(from, 1);
    entries.splice(Math.min(toIndex, entries.length), 0, moved);
    for (const [index, entry] of entries.entries()) {
      if (entry.sort_key !== index) await setQueueSortKey(op.trx, entry.id, index);
    }
    op.commands.push("upcoming");
    return buildPlayer(op);
  });
}

export async function clearQueue(guildId: string): Promise<Player> {
  return withPlayer(guildId, async (op) => {
    await clearQueueRows(op.trx, op.row.guild_id);
    op.commands.push("upcoming");
    return buildPlayer(op);
  });
}

// --- The bot only -----------------------------------------------------------

/**
 * The bot's report on one guild, and how Players come to exist.
 *
 * Only a report about the current play (`playId` matches) carries the bot's
 * state and position, and only while atrium has not already stopped that play:
 * Stop, Leave and the end of the Playlist set idle without a new `playId`, so a
 * report sent before the bot saw the `stop` must not start it again. Any other
 * report carries just the voice fields and liveness.
 *
 * No voice channel on the current play means the bot lost its voice
 * connection, so the Player goes idle and keeps its Queue. A report for an
 * older play says nothing about the current one: the bot may not have reached
 * the `join` and `play` that atrium just queued. A bot restart is caught
 * earlier and more surely by its cursor poll (`pollCommands`).
 */
export async function reportStatus(request: BotStatusRequest): Promise<{ upcoming: Track[] }> {
  return withPlayer(
    request.guildId,
    async (op) => {
      const changes: Partial<PlayerRow> = {
        guild_name: request.guildName,
        voice_channel_id: request.voiceChannel?.id ?? null,
        voice_channel_name: request.voiceChannel?.name ?? null,
        voice_channels: JSON.stringify(request.voiceChannels),
        last_seen_at: op.now.toISOString(),
      };
      const believed = op.row.state;
      const aboutCurrentPlay = request.playId === op.row.play_id && believed !== "idle";
      if (aboutCurrentPlay) {
        changes.state = request.state;
        changes.position_ms = request.positionMs;
        changes.position_at = op.now.toISOString();
      }
      await patch(op, changes);
      // Lost voice, or the bot stopped the current play on its own: idle never keeps a Track.
      const lostVoice = aboutCurrentPlay && request.voiceChannel === null;
      if (lostVoice || (op.row.state === "idle" && op.row.current_book_id !== null)) await goIdle(op);
      return { upcoming: await computeUpcoming(op) };
    },
    {
      create: (trx, now) =>
        insertPlayerRow(trx, {
          guild_id: request.guildId,
          guild_name: request.guildName,
          updated_at: now.toISOString(),
        }),
    },
  );
}

/**
 * The bot finished a Track (`ended`) or could not play it (`error`). A stale
 * `playId` means something else already moved the Player on, so nothing
 * changes: this is how a skip racing a natural end avoids advancing twice. A
 * Player already idle was stopped meanwhile, so it stays stopped. The play is
 * returned, not written as a command.
 */
export async function advance(guildId: string, request: BotAdvanceRequest): Promise<BotAdvanceResponse> {
  return withPlayer(guildId, async (op) => {
    if (request.playId !== op.row.play_id) return { play: null, stale: true };
    await patch(op, { last_seen_at: op.now.toISOString() });
    // Stopped (Stop, Leave, a restart) while the Track was ending: there is
    // nothing to advance, and starting the next Track would undo the stop.
    if (op.row.state === "idle") return { play: null };
    // `repeat: one` replays only a Track that ended on its own; an error moves on.
    const replayed = request.reason === "ended" && op.row.repeat === "one" && (await replayCurrent(op));
    if (!replayed) {
      const pick = await takeNext(op);
      if (!pick) {
        await goIdle(op);
        return { play: null };
      }
      await startTrack(op, pick, { retire: true });
    }
    const track = op.playlist.byId.get(op.row.current_book_id!)!;
    return { play: { playId: op.row.play_id, track, upcoming: await computeUpcoming(op) } };
  });
}

function toCommand(row: CommandRow): BotCommand {
  return { ...(JSON.parse(row.body) as object), id: row.id, guildId: row.guild_id } as BotCommand;
}

/**
 * A bot that takes a fresh cursor has just started (just-a-bot brief 26 does it
 * once, at ready), and a started bot plays nothing and sits in no voice
 * channel. Every Player it left playing or paused goes idle and keeps its
 * Queue, before any status report arrives.
 */
async function idleAfterRestart(): Promise<void> {
  const now = new Date();
  await knex.transaction(async (trx) => {
    const rows = (await listPlayerRows(trx)).filter((row) => row.state !== "idle" || row.current_book_id !== null);
    if (rows.length === 0) return;
    const playlist = await loadPlaylist(trx);
    for (const row of rows) {
      await goIdle({ trx, row, playlist, now, commands: [] }, { voice_channel_id: null, voice_channel_name: null });
    }
  });
}

/**
 * The bot's long-poll. Without `after` it answers at once with the current
 * cursor, so commands written while the bot was away are dropped, and it
 * marks the restart (`idleAfterRestart`). With
 * `after`, it answers as soon as a newer command exists, or with none once
 * `waitSeconds` runs out. No database handle is held while it waits: the pool
 * has one connection.
 */
export async function pollCommands(
  after: number | undefined,
  waitSeconds: number,
  onClose: (listener: () => void) => void,
): Promise<BotCommandsResponse> {
  await touchAllPlayers(knex, new Date().toISOString());
  const sequence = await commandSequence(knex);
  // A cursor from the future (a fresh database) restarts at the present.
  if (after === undefined) {
    await idleAfterRestart();
    return { cursor: sequence, commands: [] };
  }
  if (after > sequence) return { cursor: sequence, commands: [] };

  let rows = await listCommandRowsAfter(knex, after);
  if (rows.length === 0 && waitSeconds > 0) {
    let gone = false;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        commandEvents.off("command", done);
        resolve();
      };
      const timer = setTimeout(done, waitSeconds * 1000);
      commandEvents.on("command", done);
      onClose(() => {
        gone = true;
        done();
      });
    });
    // A bot that hung up is not seen: stamping now would keep it online for
    // another 30 seconds after it stopped.
    if (gone) return { cursor: after, commands: [] };
    rows = await listCommandRowsAfter(knex, after);
  }
  await touchAllPlayers(knex, new Date().toISOString());
  return {
    cursor: rows.length > 0 ? rows[rows.length - 1].id : after,
    commands: rows.map(toCommand),
  };
}
