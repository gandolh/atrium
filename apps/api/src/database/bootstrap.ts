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
import { openAccounts } from "./auth-store.js";
import { linkWardSubjects } from "./ward-subjects.js";
import type { Accounts } from "../../vendor/ward/ward-auth.js";

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
 * ## Why this is lazy, and not a boot sweep
 *
 * It used to run over every row of `users` at startup. Under D53 atrium could
 * not enumerate Ward's accounts, so it became a provision the guard runs the
 * first time an account arrives. Under D58 the accounts are local again, but
 * they are still created where atrium does not look: by the seed script, or
 * by a first "Sign in with Ward", inside the library. The first request after
 * either is the one moment atrium is sure to see, so it stays here.
 *
 * `subject` is the local user's id. The column kept its D53 name: for an
 * account that existed then, the id **is** the Ward subject (D58).
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
 * The schema, then the accounts on it: what the seed script needs, and the
 * first half of the boot. Without the job reapers, so the seed can run beside
 * a live API without failing its in-flight conversions and compiles.
 */
export async function openMigratedAccounts(): Promise<Accounts> {
  refuseFreshDatabaseBesideFiles();
  await runMigrations();
  return openAccounts();
}

/** A local account this boot made for a pre-D58 Ward subject (`linkWardSubjects`). */
export interface MigratedAccount {
  subject: string;
  username: string;
}

/** What the boot answers: the accounts the guard is built from, and what it migrated. */
export interface BootDatabase {
  accounts: Accounts;
  /** Empty on every boot but the first after the D58 upgrade. */
  migratedAccounts: MigratedAccount[];
}

/**
 * The full boot sequence: schema first, then the accounts (D58), then the two
 * job reapers. Answers the accounts, which the app's guard is built from, and
 * the accounts this boot migrated, which `index.ts` logs (`logMigratedAccounts`).
 *
 * The accounts open on this same database (`auth-store.ts`) only after the
 * fresh-database check, because opening them opens the connection, and the
 * connection creates the file the check looks for. Every Ward subject's local
 * user is made after the migrations, because it reads `profiles`, and on every
 * boot, because it skips what exists.
 */
export async function initDatabase(): Promise<BootDatabase> {
  const accounts = await openMigratedAccounts();
  const subjects = await linkWardSubjects(accounts);
  const migratedAccounts: MigratedAccount[] = [];
  for (const subject of subjects) {
    const user = await accounts.findUserById(subject);
    if (user) migratedAccounts.push({ subject, username: user.username });
  }
  await reapInterruptedConversions();
  await reapInterruptedLatexCompiles();
  return { accounts, migratedAccounts };
}

/** The slice of a pino/Fastify logger the boot log needs. */
export interface BootLog {
  warn(detail: object, message: string): void;
}

/**
 * One warning per account the boot migrated (brief 90), so the first deploy of
 * D58 says who now has an account with no password and how they get in.
 *
 * A migrated account is `user-<8 characters of the subject>` with no password,
 * and owns every profile, note, LaTeX project and position its person had.
 * Seeding a fresh account for that person instead makes an empty one, and the
 * data looks lost. With "Sign in with Ward" on, the person signs in with Ward
 * and sets a password in Settings. With it off the account has no way in at
 * all until `seed:user --set-password` gives it one, so the line says that.
 */
export function logMigratedAccounts(
  log: BootLog,
  migrated: readonly MigratedAccount[],
  options: { signInWithWard: boolean },
): void {
  for (const { subject, username } of migrated) {
    const howIn = options.signInWithWard
      ? "sign in with Ward, then set a password in Settings"
      : "Sign in with Ward is off, so it has no way in: set the WARD_OIDC_* variables and sign in " +
        `with Ward, or give it a password with seed:user --set-password and SEED_USERNAME=${username}`;
    log.warn(
      { subject, username },
      `Ward subject ${subject} is now ${username} with no password: ${howIn}`,
    );
  }
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
