import type { Knex } from "knex";
import type { CommandRow, HistoryRow, PlayerRow, QueueEntryRow, TrackSourceRow } from "./jukebox.types.js";

/**
 * SQL for the Jukebox (brief 81). Every function takes the handle to run on,
 * because the pool has one connection (D47): a call on the global `knex` from
 * inside a transaction would wait forever for the connection the transaction
 * holds.
 */

/** Play history kept per Player. Shuffle looks back at most 50 of these. */
const HISTORY_KEEP = 100;

/** Commands older than this are deleted whenever a new one is written. */
const COMMAND_TTL_MS = 5 * 60_000;

/**
 * Every Track (D56): each `audio` item, unsorted. Not-converted, like every
 * other listing (`library.model.ts`'s `NOT_CONVERTED`), though audio is never
 * converted today.
 */
export async function selectTrackRows(db: Knex): Promise<TrackSourceRow[]> {
  return (await db("books")
    .select("id", "title", "author", "series", "series_index", "duration_seconds")
    .where("kind", "audio")
    .whereNull("converted_from")) as TrackSourceRow[];
}

export async function getPlayerRow(db: Knex, guildId: string): Promise<PlayerRow | undefined> {
  return (await db("jukebox_players").where("guild_id", guildId).first()) as PlayerRow | undefined;
}

export async function listPlayerRows(db: Knex): Promise<PlayerRow[]> {
  return (await db("jukebox_players").orderBy("guild_name").orderBy("guild_id")) as PlayerRow[];
}

export async function insertPlayerRow(
  db: Knex,
  row: Pick<PlayerRow, "guild_id" | "guild_name" | "updated_at">,
): Promise<void> {
  await db("jukebox_players").insert(row);
}

export async function updatePlayerRow(db: Knex, guildId: string, patch: Partial<PlayerRow>): Promise<void> {
  await db("jukebox_players").where("guild_id", guildId).update(patch);
}

/** Stamp every Player as seen: the bot is one process serving every guild. */
export async function touchAllPlayers(db: Knex, now: string): Promise<void> {
  await db("jukebox_players").update({ last_seen_at: now });
}

/** A Player's Queue, head first. */
export async function listQueueRows(db: Knex, guildId: string): Promise<QueueEntryRow[]> {
  return (await db("jukebox_queue_entries")
    .where("guild_id", guildId)
    .orderBy("sort_key")
    .orderBy("id")) as QueueEntryRow[];
}

export async function insertQueueRow(db: Knex, row: Omit<QueueEntryRow, "id">): Promise<void> {
  await db("jukebox_queue_entries").insert(row);
}

export async function deleteQueueRow(db: Knex, guildId: string, entryId: number): Promise<number> {
  return db("jukebox_queue_entries").where({ guild_id: guildId, id: entryId }).del();
}

export async function clearQueueRows(db: Knex, guildId: string): Promise<void> {
  await db("jukebox_queue_entries").where("guild_id", guildId).del();
}

export async function setQueueSortKey(db: Knex, entryId: number, sortKey: number): Promise<void> {
  await db("jukebox_queue_entries").where("id", entryId).update({ sort_key: sortKey });
}

/** Newest first. */
export async function listHistoryRows(db: Knex, guildId: string, limit: number): Promise<HistoryRow[]> {
  return (await db("jukebox_history")
    .where("guild_id", guildId)
    .orderBy("id", "desc")
    .limit(limit)) as HistoryRow[];
}

/** Record a Track that stopped being current, and keep the newest 100. */
export async function pushHistoryRow(db: Knex, row: Omit<HistoryRow, "id">): Promise<void> {
  await db("jukebox_history").insert(row);
  await db("jukebox_history")
    .where("guild_id", row.guild_id)
    .whereNotIn(
      "id",
      db("jukebox_history").select("id").where("guild_id", row.guild_id).orderBy("id", "desc").limit(HISTORY_KEEP),
    )
    .del();
}

export async function deleteHistoryRow(db: Knex, id: number): Promise<void> {
  await db("jukebox_history").where("id", id).del();
}

/** Write one command, and drop every command past its five minutes. */
export async function insertCommandRow(db: Knex, guildId: string, body: string, now: Date): Promise<void> {
  await db("jukebox_commands").insert({ guild_id: guildId, body, created_at: now.toISOString() });
  await db("jukebox_commands")
    .where("created_at", "<", new Date(now.getTime() - COMMAND_TTL_MS).toISOString())
    .del();
}

export async function listCommandRowsAfter(db: Knex, after: number): Promise<CommandRow[]> {
  return (await db("jukebox_commands").where("id", ">", after).orderBy("id")) as CommandRow[];
}

/**
 * The newest command id ever issued, deleted or not. AUTOINCREMENT keeps it in
 * `sqlite_sequence`, so the cursor never goes back when old rows are pruned.
 */
export async function commandSequence(db: Knex): Promise<number> {
  const row = (await db("sqlite_sequence").where("name", "jukebox_commands").first("seq")) as
    | { seq: number }
    | undefined;
  return row ? Number(row.seq) : 0;
}
