import { mkdirSync } from "node:fs";
import knexFactory, { type Knex } from "knex";
import { DATA_DIR, DB_PATH } from "../common/config.js";

/**
 * The single Knex instance every model in the app queries through (D24, as
 * revised 2026-08-30). SQLite on disk, `better-sqlite3` still the driver —
 * Knex is the query builder and migration runner layered over it, not a
 * replacement for the engine.
 *
 * WHY THE POOL IS PINNED TO ONE CONNECTION, and why that is not a throughput
 * regression to be "fixed" later: SQLite is a file, not a server. A second
 * connection buys no parallelism on writes (they serialise on the database
 * lock and surface as SQLITE_BUSY) and it silently breaks two things this
 * codebase depends on:
 *
 *  - **Connection-scoped PRAGMAs.** `foreign_keys` is per-connection. With a
 *    pool of N, `afterCreate` has to set it on all N and the baseline
 *    migration's foreign-key dance (see `migrations/`) could toggle it on one
 *    connection while the rebuild runs on another. One connection makes the
 *    pragma a property of the database, which is how the rest of the code
 *    already reasons about it.
 *  - **Transactions.** `knex.transaction()` grabs a connection for the duration.
 *    With `max: 1` every transaction is exclusive by construction, which is
 *    exactly the guarantee `better-sqlite3`'s synchronous transactions gave for
 *    free and the one the profile migration's rollback assertion relies on.
 *
 * `acquireConnectionTimeout` is raised from Knex's 60s default because a long
 * write (a publish, a metadata backfill sweep) legitimately holds the single
 * connection while other requests queue behind it.
 */

// The driver opens the file, but it will not create the directory holding it.
// Kept here, at the point of connection, for the same reason `db.ts` had it:
// the first boot on a clean checkout has no `data/`.
mkdirSync(DATA_DIR, { recursive: true });

export const knex: Knex = knexFactory({
  client: "better-sqlite3",
  connection: { filename: DB_PATH },
  // SQLite has no native `DEFAULT` for an undefined insert value; without this
  // Knex refuses to build the statement rather than writing NULL.
  useNullAsDefault: true,
  pool: {
    min: 1,
    max: 1,
    afterCreate(
      connection: { pragma(source: string): unknown },
      done: (err: Error | null, conn: unknown) => void,
    ) {
      try {
        // WAL survives from the previous driver — it is a property of the file,
        // not the connection — but it is set here so a brand-new database gets
        // it on its first open rather than on whatever later boot happens to
        // notice.
        connection.pragma("journal_mode = WAL");
        // OFF by default in SQLite, and every `ON DELETE` clause in the schema
        // is load-bearing (see the migrations). Per-connection, which is half
        // the reason the pool above is pinned to one.
        connection.pragma("foreign_keys = ON");
        done(null, connection);
      } catch (err) {
        done(err as Error, connection);
      }
    },
  },
  acquireConnectionTimeout: 120_000,
});

/**
 * Close the pool. Called on shutdown so a SIGTERM leaves no WAL checkpoint
 * pending; safe to call twice.
 */
export async function closeDatabase(): Promise<void> {
  await knex.destroy();
}
