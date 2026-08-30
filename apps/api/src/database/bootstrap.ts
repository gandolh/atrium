import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { knex } from "./knex.js";
import { migrationSource } from "./migrations/index.js";

/**
 * Everything the database needs before the API serves its first request:
 * migrations, then the boot-time data tasks that are NOT schema.
 *
 * The split matters. A **migration** changes the shape of the database once and
 * is then recorded in `knex_migrations` and never run again. A **boot task**
 * below runs on *every* start, because what it repairs is created fresh by
 * ordinary use — an account seeded after the migration with no profile, a job
 * row left `running` by a process that was killed. Putting either kind in the
 * other's place is the mistake this file exists to prevent.
 *
 * Under the old `better-sqlite3` layer all of this happened as a side effect of
 * importing `db.ts`, synchronously, before anything could ask whether it had
 * worked. It is now an awaited step in `index.ts` that runs before
 * `app.listen()`, so a failure here stops the server from coming up at all
 * instead of being discovered by the first request that reads a missing column.
 */

/**
 * What a row reaped by `reapInterruptedConversions` says. Exported so the job
 * runner and the status button can recognise this specific failure rather than
 * string-matching a sentence that may be reworded.
 */
export const CONVERT_INTERRUPTED_ERROR =
  "The conversion stopped when the server restarted. Nothing was lost — start it again when you're ready.";

/** Run every pending migration. Throws — a half-migrated database must not serve. */
export async function runMigrations(): Promise<void> {
  await knex.migrate.latest({
    migrationSource,
    tableName: "knex_migrations",
    // The baseline migration toggles `PRAGMA foreign_keys`, which SQLite
    // refuses inside a transaction, and opens its own transaction around the
    // part that must be atomic. Knex's per-migration wrapper would make that
    // impossible, so migrations manage their own transactions here. A migration
    // added later that wants one should call `knex.transaction()` itself.
    disableTransactions: true,
  });
}

/**
 * Give every account that has no profile at all a `Default` one (brief 35
 * decision 2).
 *
 * A boot task, not a migration, and the distinction is load-bearing: it is the
 * safety net that keeps "every account has at least one profile" true for
 * accounts seeded *after* the migration ran, which the auth guard's
 * default-profile fallback and the login response both rely on. A no-op once
 * each account has one.
 *
 * Takes a `Knex` so the baseline migration can call it **inside** the
 * profile-scope rebuild's transaction, where rows are rehomed by joining
 * through the profiles this creates. That shared call is deliberate: two copies
 * of this rule would be free to drift, and the migration's row-count assertion
 * would then roll back on the difference.
 */
export async function ensureDefaultProfiles(db: Knex = knex): Promise<void> {
  const orphans = (await db("users as u")
    .select("u.id as id")
    .whereNotExists(db("profiles as p").select(db.raw("1")).whereRaw("p.user_id = u.id"))) as {
    id: string;
  }[];
  if (orphans.length === 0) return;

  const now = new Date().toISOString();
  await db("profiles").insert(
    orphans.map((user) => ({
      id: randomUUID(),
      user_id: user.id,
      name: "Default",
      color: "cream",
      is_default: 1,
      preferences: null,
      created_at: now,
    })),
  );
}

/**
 * Flip every row left in `convert_status = 'running'` to `failed` (D34 decision
 * 7). A job cannot survive the process: its `ebook-convert` child died with the
 * old process and the in-memory job map went with it, so a row left `running`
 * would poll forever with no button able to rescue it.
 *
 * Deliberately NOT an auto-resume — decision 7 rejected that because one book
 * Calibre chokes on would restart, crash, and restart again on every boot.
 * Retry lives in the button, where a person decides.
 */
export async function reapInterruptedConversions(): Promise<number> {
  return knex("books")
    .where({ convert_status: "running" })
    .update({ convert_status: "failed", convert_error: CONVERT_INTERRUPTED_ERROR });
}

/**
 * Flip every LaTeX project left in `compile_status = 'running'` to `failed`,
 * the exact counterpart of `reapInterruptedConversions` and for the exact same
 * reason (brief 34 decision 7, carried into brief 38 step 3).
 *
 * A compile cannot survive the process. The engine is in-process, so its work
 * died with the old process and the in-memory single-flight slot went with it —
 * but the row did not. A project left `running` would poll forever AND, because
 * the single-flight guard's durable half is this column, hold the one compile
 * slot closed for every project on the account. That is brief 34's Critical
 * verbatim: a claimed slot nobody can release wedges compilation app-wide.
 *
 * No error text to write: `latex_projects` has no error column, because the log
 * and the structured diagnostics are artifacts on disk, not row data.
 */
export async function reapInterruptedLatexCompiles(): Promise<number> {
  return knex("latex_projects").where({ compile_status: "running" }).update({ compile_status: "failed" });
}

/**
 * The full boot sequence, in the one order that is correct: schema first, then
 * the profile safety net (nothing profile-scoped can be repaired before the
 * profiles exist), then the two job reapers.
 */
export async function initDatabase(): Promise<void> {
  await runMigrations();
  await ensureDefaultProfiles();
  await reapInterruptedConversions();
  await reapInterruptedLatexCompiles();
}
