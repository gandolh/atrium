import type { Knex } from "knex";

/**
 * The Jukebox's tables (brief 81; D56, D57).
 *
 * Atrium owns every Player, because the bot accepts no incoming connections
 * and keeps no Player state of its own (D57). There is no playlist table: the
 * Playlist is every `audio` item in the library (D56). What is stored per
 * Player is the Queue, the play history and the commands waiting for the bot.
 *
 * The foreign keys to `books` are load-bearing. Deleting a library Track
 * removes its Queue entries and history rows (`CASCADE`) and clears it as the
 * current Track and as the Playlist cursor (`SET NULL`), with no Jukebox code
 * on the library's delete path.
 *
 * Two columns go past the brief's list, both internal to atrium:
 * - `shuffle_picks`: the next Playlist Tracks shuffle has already decided on,
 *   as a JSON array of book ids, so `upcoming` stays the same between polls.
 * - `current_from_playlist` and `jukebox_history.from_playlist`: whether a
 *   Track was played from the Playlist or the Queue. Previous moves the cursor
 *   only for a Playlist Track, and every Track is in the Playlist (D56), so
 *   that fact has to be recorded when the Track starts.
 *
 * Runs in its own transaction: the migrator has transactions disabled for the
 * baseline's sake (`bootstrap.ts`).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.schema.createTable("jukebox_players", (table) => {
      table.text("guild_id").primary();
      table.text("guild_name").notNullable();
      table.text("voice_channel_id");
      table.text("voice_channel_name");
      table.text("voice_channels").notNullable().defaultTo("[]");
      table.text("state").notNullable().defaultTo("idle").checkIn(["idle", "playing", "paused"]);
      table.integer("play_id").notNullable().defaultTo(0);
      table.text("current_book_id").references("id").inTable("books").onDelete("SET NULL");
      table.integer("current_from_playlist").notNullable().defaultTo(0);
      table.integer("position_ms").notNullable().defaultTo(0);
      table.text("position_at");
      table.text("playlist_cursor_book_id").references("id").inTable("books").onDelete("SET NULL");
      table.integer("shuffle").notNullable().defaultTo(0);
      table.text("shuffle_picks").notNullable().defaultTo("[]");
      table.text("repeat").notNullable().defaultTo("off").checkIn(["off", "one", "all"]);
      table.text("last_seen_at");
      table.text("updated_at").notNullable();
    });

    await trx.schema.createTable("jukebox_queue_entries", (table) => {
      table.increments("id");
      table.text("guild_id").notNullable().references("guild_id").inTable("jukebox_players").onDelete("CASCADE");
      table.text("book_id").notNullable().references("id").inTable("books").onDelete("CASCADE");
      table.integer("sort_key").notNullable();
      table.text("added_by_kind").notNullable().checkIn(["profile", "discord"]);
      table.text("added_by_name").notNullable();
      table.text("added_at").notNullable();
      table.index(["guild_id", "sort_key"], "jukebox_queue_entries_guild_order");
    });

    await trx.schema.createTable("jukebox_history", (table) => {
      table.increments("id");
      table.text("guild_id").notNullable().references("guild_id").inTable("jukebox_players").onDelete("CASCADE");
      table.text("book_id").notNullable().references("id").inTable("books").onDelete("CASCADE");
      table.integer("from_playlist").notNullable().defaultTo(0);
      table.text("played_at").notNullable();
      table.index(["guild_id", "id"], "jukebox_history_guild_newest");
    });

    await trx.schema.createTable("jukebox_commands", (table) => {
      table.increments("id");
      table.text("guild_id").notNullable().references("guild_id").inTable("jukebox_players").onDelete("CASCADE");
      table.text("body").notNullable();
      table.text("created_at").notNullable();
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.schema.dropTableIfExists("jukebox_commands");
    await trx.schema.dropTableIfExists("jukebox_history");
    await trx.schema.dropTableIfExists("jukebox_queue_entries");
    await trx.schema.dropTableIfExists("jukebox_players");
  });
}
