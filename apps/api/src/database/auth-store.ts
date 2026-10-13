import type { Knex } from "knex";
import {
  createAccounts,
  createSqliteStore,
  type Accounts,
  type SqliteHandle,
} from "../../vendor/ward/ward-auth.js";
import { knex } from "./knex.js";

/**
 * Atrium's accounts (D58): Ward's vendored library, on atrium's own database.
 *
 * ## The same connection Knex uses, not a second one
 *
 * The library's store runs on a raw `better-sqlite3` handle, and it gets **the
 * one Knex already holds** rather than a new connection to the same file.
 * `knex.ts` pins the pool to one connection, and a second one would undo what
 * that bought. Worse, Knex holds a write transaction open across awaits (a
 * publish, a backfill), and a second connection's write during one would block
 * the event loop on the lock for its whole busy timeout, which is the very
 * loop that has to run for the transaction to finish.
 *
 * Sharing is safe because both sides are synchronous underneath. The library's
 * store answers synchronously and wraps its own multi-statement writes in
 * savepoints, so nothing of Knex's can run in the middle of one. The one
 * consequence worth knowing: an auth write made while a Knex transaction is
 * open lands inside that transaction, so a rollback there undoes it too. The
 * writes are a session's sliding expiry or a new session, and losing one means
 * a sign-in to redo, never a corrupt row.
 *
 * The pool's `min: 1, max: 1` keeps that connection for the life of the
 * process, so the handle stays valid until `closeDatabase()`.
 *
 * `createSqliteStore` applies the library's own migrations (`auth_users`,
 * `auth_sessions`, `auth_ward_links`, `auth_migrations`) before it returns.
 * They never touch atrium's tables, so the order against `runMigrations()`
 * does not matter.
 */
export async function openAccounts(db: Knex = knex): Promise<Accounts> {
  /*
   * The connection is a better-sqlite3 `Database`. It is typed as the
   * library's `SqliteHandle` because `@types/better-sqlite3`'s `Statement.run`
   * takes a bind-parameters object the library's narrower signature does not
   * accept, though every call the library makes is positional and works.
   */
  const client = db.client as {
    acquireConnection(): Promise<SqliteHandle>;
    releaseConnection(connection: SqliteHandle): Promise<void>;
  };
  const connection = await client.acquireConnection();
  try {
    return createAccounts({ store: createSqliteStore(connection) });
  } finally {
    await client.releaseConnection(connection);
  }
}
