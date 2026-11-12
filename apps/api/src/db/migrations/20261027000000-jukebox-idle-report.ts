import type { Knex } from "knex";

/**
 * When the bot last reported its current play idle (brief 94).
 *
 * The bot ends a Track by setting itself idle and then asking `advance` for
 * the next one, and a status report can land in between. Taking that report
 * at its word idled the Player and dropped the Track, so the `advance` that
 * followed found nothing to advance and playback stopped between songs. Now
 * the report only stamps `idle_reported_at`, the Player keeps its Track, and
 * it goes idle if no `advance` arrives within the grace period
 * (`IDLE_REPORT_GRACE_MS` in `jukebox.service.ts`).
 *
 * A column rather than a timer in memory, so the grace survives an API
 * restart (nothing else would ever idle that Player) and a test can move it
 * by backdating the stamp. Null whenever there is no such report pending.
 *
 * Runs in its own transaction: the migrator has transactions disabled for the
 * baseline's sake (`bootstrap.ts`).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.schema.alterTable("jukebox_players", (table) => {
      table.text("idle_reported_at");
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    await trx.schema.alterTable("jukebox_players", (table) => {
      table.dropColumn("idle_reported_at");
    });
  });
}
