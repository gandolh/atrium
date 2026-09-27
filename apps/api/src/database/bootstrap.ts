import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import type { Knex } from "knex";
import {
  DATA_DIR,
  DB_PATH,
  DOCUMENT_VERSIONS_DIR,
  LATEX_PROJECTS_DIR,
  LIBRARY_FILES_DIR,
  THUMBNAILS_DIR,
} from "../common/config.js";
import { knex } from "./knex.js";
import { migrationSource } from "./migrations/index.js";
import { isUniqueViolation } from "./errors.js";

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
 * Give one account its `Default` profile if it has none (brief 35 decision 2).
 *
 * ## Why this is per-subject now, and no longer a boot sweep
 *
 * It used to run over every row of `users` at startup. Atrium has no `users`
 * table any more — Ward owns accounts — and **atrium cannot enumerate them**:
 * Ward exposes who *this request* is, never a list of who exists. So the sweep
 * has become a lazy provision, called by the guard the first time a subject
 * arrives.
 *
 * That is a better fit for the model than the sweep was, because the moment a
 * person becomes able to use atrium is not a deploy or a restart — it is a
 * superuser issuing an `atrium` grant in Ward's console, which atrium is never
 * told about. The first request after that grant is the only event atrium can
 * actually observe, and it is exactly when this runs.
 *
 * Idempotent and safe to call on every request: it is one indexed count, and it
 * inserts only when that count is zero. The unique index on
 * `(subject, name)` is what makes the race harmless — two tabs arriving
 * together both see zero, both insert "Default", and one loses on the
 * constraint rather than producing two default profiles.
 */
export async function ensureDefaultProfile(subject: string, db: Knex = knex): Promise<void> {
  const existing = await db("profiles").where({ subject }).first();
  if (existing) return;

  try {
    await db("profiles").insert({
      id: randomUUID(),
      subject,
      name: "Default",
      color: "cream",
      is_default: 1,
      preferences: null,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    // The lost side of the two-tabs race above. The winner created exactly the
    // row this call wanted to exist, so there is nothing to report and nothing
    // to retry — rethrowing would turn a benign race into a 500 on somebody's
    // first ever page load.
    if (!isUniqueViolation(error)) throw error;
  }
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
 * The full boot sequence: schema first, then the two job reapers.
 *
 * The profile safety net used to run here as a third step. It does not any
 * more, and its absence is the change rather than an oversight — atrium cannot
 * enumerate Ward's accounts, so "every account has a profile" cannot be swept
 * for at boot. `ensureDefaultProfile` is now called per subject by the guard;
 * see its comment.
 */
export async function initDatabase(): Promise<void> {
  refuseFreshDatabaseBesideFiles();
  await runMigrations();
  await reapInterruptedConversions();
  await reapInterruptedLatexCompiles();
}

/**
 * Stop before migrations create a new database beside a library that already
 * has files (brief 53).
 *
 * No `library.db` while the uploads or thumbnails directory holds entries is
 * never a normal first boot. It is a storage root resolving somewhere
 * unintended, as brief 53's anchors did, or a test that redirected the database
 * but not the files, the shape of the 2026-08-25 incident. Carrying on would
 * serve an empty library over the real files and write new uploads next to
 * them. A genuinely empty first boot (no database, empty or absent
 * directories) passes. Dotfiles are ignored so a stray `.gitkeep` is not a
 * library.
 */
function refuseFreshDatabaseBesideFiles(): void {
  if (existsSync(DB_PATH)) return;

  const populated = [LIBRARY_FILES_DIR, THUMBNAILS_DIR].filter(
    (dir) => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith(".")),
  );
  if (populated.length === 0) return;

  throw new Error(
    `Refusing to create a new database at ${DB_PATH}: there are already files in ${populated.join(" and ")}, ` +
      "so a storage root is pointing somewhere unintended. Resolved roots: " +
      `data ${DATA_DIR}, library ${LIBRARY_FILES_DIR}, thumbnails ${THUMBNAILS_DIR}, ` +
      `latex ${LATEX_PROJECTS_DIR}, versions ${DOCUMENT_VERSIONS_DIR}.`,
  );
}
