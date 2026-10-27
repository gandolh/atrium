import type { Knex } from "knex";

/**
 * A Player's run of failed songs, and what to say when it gives up (brief 95).
 *
 * `advance(error)` always took the next Track, and the bot asks again at once
 * after a failure, so with the media missing the two looped through the
 * library as fast as HTTP allows: shuffle and repeat-all never run out.
 * `failed_advances` counts the bot's consecutive `error` advances and resets on
 * an `ended` one; at five the Player goes idle and `failure` holds the reason
 * the Jukebox page shows, until the next play starts.
 *
 * Runs in its own transaction: the migrator has transactions disabled for the
 * baseline's sake (`bootstrap.ts`).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.schema.alterTable("jukebox_players", (table) => {
      table.integer("failed_advances").notNullable().defaultTo(0);
      table.text("failure");
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.schema.alterTable("jukebox_players", (table) => {
      table.dropColumn("failure");
      table.dropColumn("failed_advances");
    });
  });
}
