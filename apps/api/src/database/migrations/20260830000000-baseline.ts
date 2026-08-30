import type { Knex } from "knex";
import type { FileType } from "@ebook-reader/shared";
import { coverOwnerId, coverPathFor, filePathFor } from "../../common/paths.js";
import { ensureDefaultProfiles } from "../bootstrap.js";

/**
 * THE BASELINE MIGRATION — the whole schema as it stood on 2026-08-30, plus
 * every legacy upgrade path needed to get an older database here.
 *
 * WHY IT IS ONE IDEMPOTENT MIGRATION RATHER THAN A REPLAYED HISTORY, because
 * this is the question anyone adding the second migration will ask:
 *
 * Before Knex the schema was maintained by `db.ts` running a `CREATE TABLE IF
 * NOT EXISTS` block plus a chain of hand-guarded `ensure*` functions at module
 * import, on **every boot**. There was never a numbered migration history to
 * replay, and no `knex_migrations` table anywhere. So a live database arriving
 * at this migration is already fully migrated but has no record saying so, and
 * a fresh one is empty — this file has to be correct on both, which is exactly
 * what every guard below is for.
 *
 * **Migrations added after this one are ordinary forward migrations.** They may
 * assume the schema below exists and must NOT be written idempotently — the
 * `knex_migrations` table records them from here on, which is the entire point
 * of adopting a migration runner. This file is the last one that has to
 * apologise for the past.
 *
 * IT RUNS OUTSIDE A TRANSACTION (`disableTransactions` in the migrator config —
 * see `../migrate.ts`). Not an oversight: step 3 must toggle
 * `PRAGMA foreign_keys`, which SQLite refuses to do inside a transaction, and
 * it opens its own transaction around the part that has to be atomic.
 */

/** Column adds for `books` (briefs 21, 22, 23, 34). */
const BOOK_COLUMNS: Record<string, string> = {
  series: "TEXT",
  series_index: "REAL",
  subjects: "TEXT",
  // `NOT NULL DEFAULT` is legal in SQLite's ADD COLUMN because it supplies a
  // value for every existing row, so uploads keep source='upload' with no
  // backfill.
  source: "TEXT NOT NULL DEFAULT 'upload'",
  source_id: "TEXT",
  kind: "TEXT NOT NULL DEFAULT 'book'",
  duration_seconds: "REAL",
  // SQLite accepts a REFERENCES clause on ADD COLUMN only when the new column
  // defaults to NULL, which this one does — verified empirically against the
  // bundled SQLite (3.53.2) on the live schema. So the cascade is real and not
  // quietly downgraded to a bare TEXT column. Raw SQL rather than the schema
  // builder precisely because that verification was done against this string.
  converted_from: "TEXT REFERENCES books(id) ON DELETE CASCADE",
  convert_status: "TEXT NOT NULL DEFAULT 'none'",
  convert_error: "TEXT",
  convert_started_at: "TEXT",
};

export async function up(knex: Knex): Promise<void> {
  await createCoreTables(knex);
  await addBookColumns(knex);
  await addSessionProfileColumn(knex);
  // MUST precede the two column adds below: on a pre-brief-35 database this
  // drops and recreates `reading_progress` and `notes` from a DDL that has
  // never heard of `version_id` or `folder_id`, so adding them first would
  // silently lose them.
  await migrateToProfileScope(knex);
  await dropLegacyPathColumns(knex);
  await addProgressVersionColumn(knex);
  await addNoteFolderColumn(knex);
  await createLateIndexes(knex);
}

/**
 * The baseline is the floor. Rolling it back would drop every table in the
 * database, which for a personal library means destroying the only copy of
 * someone's notes and drafts — so it refuses rather than offering a
 * one-keystroke path to that.
 */
export async function down(): Promise<void> {
  throw new Error(
    "The baseline migration cannot be rolled back — it would drop every table, " +
      "including authored notes and LaTeX drafts. Restore from a copy of library.db instead.",
  );
}

// --- Step 1: the tables ------------------------------------------------------

async function createCoreTables(knex: Knex): Promise<void> {
  // No path columns on `books`, on purpose: where a book's file and thumbnail
  // live is derived from the row by `paths.ts`, never stored (D39, brief 41). A
  // pre-existing database still has the old file_path/cover_path columns at
  // this point; `dropLegacyPathColumns` removes them in step 4.
  if (!(await knex.schema.hasTable("books"))) {
    await knex.schema.createTable("books", (table) => {
      table.text("id").primary();
      table.text("title").notNullable();
      table.text("author");
      table.text("format").notNullable();
      table.integer("size_bytes").notNullable();
      table.specificType("progress", "REAL").notNullable().defaultTo(0);
      table.text("created_at").notNullable();
      table.text("last_opened_at");
    });
  }

  if (!(await knex.schema.hasTable("users"))) {
    await knex.schema.createTable("users", (table) => {
      table.text("id").primary();
      table.text("username").notNullable().unique();
      table.text("password_hash").notNullable();
      table.text("created_at").notNullable();
    });
  }

  // Opaque login sessions: a random token maps to a user. Rows cascade away
  // with the user.
  if (!(await knex.schema.hasTable("sessions"))) {
    await knex.schema.createTable("sessions", (table) => {
      table.text("token").primary();
      table.text("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
      table.text("created_at").notNullable();
    });
  }

  // Profiles (brief 35, D35): the people inside one household account. Free to
  // switch between, so an identity boundary and not a security one. Names are
  // unique per account; colours deliberately are not — colour is a glance cue,
  // not a key.
  if (!(await knex.schema.hasTable("profiles"))) {
    await knex.schema.createTable("profiles", (table) => {
      table.text("id").primary();
      table.text("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
      table.text("name").notNullable();
      table.text("color").notNullable();
      table.integer("is_default").notNullable().defaultTo(0);
      // Preferences JSON (brief 35 step 8); NULL until the profile first writes.
      table.text("preferences");
      table.text("created_at").notNullable();
      table.unique(["user_id", "name"], { indexName: "profiles_user_name" });
    });
  }

  // Per-profile reading state (progress + exact resume position). One row per
  // (profile, book); the book itself is shared. Pre-brief-35 databases have
  // this keyed on user_id instead and are rebuilt by `migrateToProfileScope`
  // below — SQLite cannot ALTER a composite primary key.
  if (!(await knex.schema.hasTable("reading_progress"))) {
    await knex.schema.createTable("reading_progress", (table) => {
      table.text("profile_id").notNullable().references("id").inTable("profiles").onDelete("CASCADE");
      table.text("book_id").notNullable().references("id").inTable("books").onDelete("CASCADE");
      table.specificType("progress", "REAL").notNullable().defaultTo(0);
      table.text("locator");
      table.text("updated_at").notNullable();
      table.primary(["profile_id", "book_id"]);
    });
  }

  // Per-profile notes (brief 26; rescoped from the user by brief 35): a paged
  // notebook with vector ink + text boxes, stored as JSON in `data`.
  //
  // ON DELETE RESTRICT, unlike every other relation here, is deliberate. Brief
  // 35 decision 3: notes are *authored*, so deleting a profile must move them
  // to the account's default (`reassignNotes`) rather than destroy them, and
  // the delete route requires that explicitly. A cascade here would be a silent
  // second path to the exact loss that decision forbids; RESTRICT makes
  // forgetting it a loud constraint error instead.
  if (!(await knex.schema.hasTable("notes"))) {
    await knex.schema.createTable("notes", (table) => {
      table.text("id").notNullable().primary();
      table.text("profile_id").notNullable().references("id").inTable("profiles").onDelete("RESTRICT");
      table.text("title").notNullable();
      table.text("data").notNullable();
      table.text("created_at").notNullable();
      table.text("updated_at").notNullable();
    });
  }

  // Note folders (brief 50). A folder is a ROW with a `parent_id`, never a path
  // string: a path cannot be renamed atomically and goes wrong the first time a
  // name contains the separator. The **root is `parent_id IS NULL`** — there is
  // no root row, so an untouched profile simply has no folders.
  //
  // The two foreign keys differ on purpose:
  //
  //   note_folders.profile_id -> profiles(id)     ON DELETE RESTRICT
  //   note_folders.parent_id  -> note_folders(id) (NO ACTION — see below)
  //
  // `profile_id` matches `notes.profile_id` exactly, and for the same reason:
  // deleting a profile must go through `reassignNotes`, which moves the folders
  // along with the notes filed in them (a note handed to another profile while
  // its folder stayed behind would point across a profile boundary).
  //
  // `parent_id` deliberately carries NO `ON DELETE` clause. NO ACTION in SQLite
  // is checked at the END of the statement, not per row, which is what makes
  // the one legitimate bulk delete — every folder of one profile, in
  // `deleteProfile` — succeed regardless of the order rows come off the table,
  // while a delete of a SINGLE folder that still has children is refused. That
  // refusal is the point: `deleteNoteFolder` must lift the children to the
  // deleted folder's parent first (brief 50 rule 5). A CASCADE here would take
  // whole subtrees.
  if (!(await knex.schema.hasTable("note_folders"))) {
    await knex.schema.createTable("note_folders", (table) => {
      table.text("id").notNullable().primary();
      table.text("profile_id").notNullable().references("id").inTable("profiles").onDelete("RESTRICT");
      table.text("parent_id").references("id").inTable("note_folders");
      table.text("name").notNullable();
      table.text("created_at").notNullable();
      // The listing is "every folder of one profile"; the child lookup and the
      // ancestry walk both filter on (profile_id, parent_id).
      table.index(["profile_id", "parent_id"], "note_folders_profile_parent");
    });
  }

  // LaTeX drafts and published versions (brief 38). The three foreign-key
  // behaviours below differ ON PURPOSE — brief 38 decision 11, not a default
  // anyone reached for:
  //
  //   latex_projects.profile_id        -> profiles(id) ON DELETE CASCADE
  //   latex_projects.published_book_id -> books(id)    ON DELETE SET NULL
  //   document_versions.book_id        -> books(id)    ON DELETE CASCADE
  //
  // A **draft** and a **published document** are different things in different
  // places. The draft lives only in `/latex`; publishing copies work OUT of it
  // into one `books` row that then stands on its own. So the link between them
  // must break cleanly from either end: deleting the library entry clears
  // `published_book_id` and leaves the draft editable (SET NULL), and deleting
  // the draft does nothing at all to the `books` row, because the reference
  // only points one way. A CASCADE on `published_book_id` would make "tidy up
  // the library" silently delete the manuscript.
  //
  // `document_versions` is the opposite case and so is the opposite clause: a
  // version is not independent of its entry, it IS its entry's history.
  //
  // As everywhere else, the cascade removes ROWS, never FILES. Whoever deletes
  // a book must unlink each version's PDF and project zip first — after the
  // cascade nothing is left pointing at them. Those locations are derived from
  // the version id by `paths.ts` and are deliberately NOT stored (D39).
  if (!(await knex.schema.hasTable("latex_projects"))) {
    await knex.schema.createTable("latex_projects", (table) => {
      table.text("id").primary();
      table.text("profile_id").notNullable().references("id").inTable("profiles").onDelete("CASCADE");
      table.text("title").notNullable();
      // A default rather than a nullable column: every project has an
      // entrypoint, and a new one is seeded from a hello-world called main.tex
      // (brief 38 decision 4).
      table.text("entrypoint").notNullable().defaultTo("main.tex");
      table.text("compile_status").notNullable().defaultTo("none");
      // NULL until the first publish; see the note above on SET NULL.
      table.text("published_book_id").references("id").inTable("books").onDelete("SET NULL");
      table.text("created_at").notNullable();
      table.text("updated_at").notNullable();
      // The project list is per-profile, most-recently-edited first — this
      // index is exactly that query, the same shape as notes_profile_updated.
      table.index(["profile_id", "updated_at"], "latex_projects_profile_updated");
    });
  }

  if (!(await knex.schema.hasTable("document_versions"))) {
    await knex.schema.createTable("document_versions", (table) => {
      table.text("id").primary();
      table.text("book_id").notNullable().references("id").inTable("books").onDelete("CASCADE");
      table.integer("version_no").notNullable();
      table.text("published_at").notNullable();
      // Enforced, not assumed: `appendDocumentVersion` allocates the next
      // number with a MAX()+1 subquery, so two publishes racing for v4 must not
      // both win. Doubles as the index the per-book version listing and the ON
      // DELETE CASCADE lookup both want.
      table.unique(["book_id", "version_no"], { indexName: "document_versions_book_no" });
    });
  }
}

// --- Step 2: idempotent column adds -----------------------------------------

/**
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so every add is guarded. New
 * columns default to NULL on existing rows; the startup backfill fills them
 * (`subjects IS NULL` is the sentinel — see `listBooksNeedingMetadata`).
 */
async function addBookColumns(knex: Knex): Promise<void> {
  for (const [name, type] of Object.entries(BOOK_COLUMNS)) {
    if (!(await knex.schema.hasColumn("books", name))) {
      await knex.raw(`ALTER TABLE books ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * The session carries the active profile (brief 35 decision 1), so every
 * request resolves it alongside the user with no change to how anything
 * authenticates.
 *
 * `ON DELETE SET NULL`, deliberately not CASCADE — deleting a profile must not
 * log the device out; the guard falls back to the account's default.
 */
async function addSessionProfileColumn(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn("sessions", "active_profile_id"))) {
    await knex.raw(
      `ALTER TABLE sessions ADD COLUMN active_profile_id TEXT
         REFERENCES profiles(id) ON DELETE SET NULL`,
    );
  }
}

// --- Step 3: the profile-scope rebuild --------------------------------------

async function countRows(knex: Knex, table: string): Promise<number> {
  const [row] = await knex(table).count({ n: "*" });
  return Number(row?.n ?? 0);
}

/**
 * Move `reading_progress` and `notes` from user scope to profile scope
 * (brief 35 step 2; D35 revising D31). Both were keyed on `user_id`, and
 * `reading_progress`'s composite primary key means SQLite cannot ALTER it, so
 * both need the documented create-copy-drop-rename rebuild.
 *
 * The whole thing is one transaction that asserts its own row counts and rolls
 * back on any mismatch: **this is the one migration in the repo that can
 * destroy authored work**, so a warning-and-continue would be worse than a
 * crash.
 *
 * `foreign_keys` is off across the rebuild per SQLite's documented ALTER TABLE
 * procedure (otherwise the DROP would cascade rows away). It cannot be toggled
 * inside a transaction, hence the pragma/try/finally wrapping rather than the
 * reverse — and `foreign_key_check` runs *inside* the transaction, where a
 * violation can still roll back.
 *
 * Idempotent (the `profile_id` guards) and silent on an empty database, which
 * is the common case for a fresh install.
 */
async function migrateToProfileScope(knex: Knex): Promise<void> {
  const progressNeedsMigration = !(await knex.schema.hasColumn("reading_progress", "profile_id"));
  const notesNeedMigration = !(await knex.schema.hasColumn("notes", "profile_id"));
  if (!progressNeedsMigration && !notesNeedMigration) return;

  const beforeProgress = await countRows(knex, "reading_progress");
  const beforeNotes = await countRows(knex, "notes");

  await knex.raw("PRAGMA foreign_keys = OFF");
  try {
    await knex.transaction(async (trx) => {
      // Rows are rehomed by joining through these, so they must exist first.
      await ensureDefaultProfiles(trx);

      if (progressNeedsMigration) {
        await trx.raw(`
          CREATE TABLE reading_progress_new (
            profile_id    TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            book_id       TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            progress      REAL    NOT NULL DEFAULT 0,
            locator       TEXT,
            updated_at    TEXT    NOT NULL,
            PRIMARY KEY (profile_id, book_id)
          )
        `);
        await trx.raw(`
          INSERT INTO reading_progress_new
                 (profile_id, book_id, progress, locator, updated_at)
          SELECT p.id, rp.book_id, rp.progress, rp.locator, rp.updated_at
            FROM reading_progress rp
            JOIN profiles p ON p.user_id = rp.user_id AND p.is_default = 1
        `);
        await trx.raw("DROP TABLE reading_progress");
        await trx.raw("ALTER TABLE reading_progress_new RENAME TO reading_progress");
      }

      if (notesNeedMigration) {
        await trx.raw(`
          CREATE TABLE notes_new (
            id         TEXT NOT NULL PRIMARY KEY,
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
            title      TEXT NOT NULL,
            data       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);
        await trx.raw(`
          INSERT INTO notes_new (id, profile_id, title, data, created_at, updated_at)
          SELECT n.id, p.id, n.title, n.data, n.created_at, n.updated_at
            FROM notes n
            JOIN profiles p ON p.user_id = n.user_id AND p.is_default = 1
        `);
        await trx.raw("DROP TABLE notes");
        await trx.raw("ALTER TABLE notes_new RENAME TO notes");
      }

      // The join above drops any row whose account has no default profile, so a
      // count mismatch means rows were silently lost. Throw: the transaction
      // rolls back and the DB is left exactly as it was found.
      const afterProgress = await countRows(trx, "reading_progress");
      const afterNotes = await countRows(trx, "notes");
      if (afterProgress !== beforeProgress || afterNotes !== beforeNotes) {
        throw new Error(
          `Profile migration would lose rows (progress ${beforeProgress}→${afterProgress}, ` +
            `notes ${beforeNotes}→${afterNotes}); rolled back.`,
        );
      }

      const violations = (await trx.raw("PRAGMA foreign_key_check")) as unknown[];
      if (Array.isArray(violations) && violations.length > 0) {
        throw new Error(
          `Profile migration left ${violations.length} foreign-key violation(s); rolled back: ` +
            JSON.stringify(violations),
        );
      }
    });
  } finally {
    await knex.raw("PRAGMA foreign_keys = ON");
  }
}

// --- Step 4: drop the legacy path columns -----------------------------------

/**
 * Drop the legacy `books.file_path` / `books.cover_path` columns.
 *
 * WHY IT IS SAFE TO DROP A `NOT NULL` COLUMN — the question a future reader
 * will ask, so here is the answer up front: neither column ever held
 * information. Both are **pure functions of columns that are still here**, and
 * `paths.ts` is now the only definition of them:
 *
 *     file_path  === filePathFor(id, format)                  // library/<id>.<ext>
 *     cover_path === coverPathFor(converted_from ?? id)       // thumbnails/<id>.jpg
 *
 * Every writer in the codebase — upload, catalog import, conversion — has
 * always named its output that way and then stored the same string it had just
 * computed. So these columns were a stale cache of a pure function, and the
 * only value they could ever add was disagreement with the disk. Dropping them
 * makes the drift impossible instead of merely correctable.
 *
 * `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35+; the bundled better-sqlite3
 * is 3.53.2, and the drop was checked against this exact schema shape: the
 * `books_converted_from` unique index and the `reading_progress` / `notes` /
 * self-referential foreign keys all survive it, because SQLite rewrites the
 * table definition in place and neither column is named by any of them. That is
 * why this is a plain DROP and not the create-copy-drop-rename rebuild step 3
 * needs — no constraint here has to change shape.
 */
async function dropLegacyPathColumns(knex: Knex): Promise<void> {
  const hadFilePath = await knex.schema.hasColumn("books", "file_path");
  const hadCoverPath = await knex.schema.hasColumn("books", "cover_path");
  if (!hadFilePath && !hadCoverPath) return;

  // READ BEFORE DESTROYING. The claim above — that these columns never held
  // information — is true of every row a writer in *this* checkout created. It
  // is NOT guaranteed of a row carried in from somewhere else: a database moved
  // between machines holds an absolute path into a directory that is no longer
  // `LIBRARY_FILES_DIR`, and for such a row the stored path is the only
  // surviving record of where those bytes actually are. Dropping it unread
  // would discard that pointer permanently and silently, on a library with no
  // version history.
  //
  // So: compare every row against its derivation first and say so loudly if
  // they disagree. `console.warn` because migrations run before Fastify's
  // logger exists — the same reason `config.ts` reports startup failures on the
  // console directly.
  const legacy = (await knex("books").select(
    "id",
    "format",
    "converted_from",
    knex.raw(hadFilePath ? "file_path" : "NULL AS file_path"),
    knex.raw(hadCoverPath ? "cover_path" : "NULL AS cover_path"),
  )) as {
    id: string;
    format: FileType;
    converted_from: string | null;
    file_path: string | null;
    cover_path: string | null;
  }[];

  const drifted: string[] = [];
  for (const row of legacy) {
    if (row.file_path && row.file_path !== filePathFor(row.id, row.format)) {
      drifted.push(`  book ${row.id}: file_path was ${row.file_path}`);
    }
    if (row.cover_path && row.cover_path !== coverPathFor(coverOwnerId(row))) {
      drifted.push(`  book ${row.id}: cover_path was ${row.cover_path}`);
    }
  }
  if (drifted.length > 0) {
    console.warn(
      `\n[migration] ${drifted.length} stored path(s) disagreed with the derived location\n` +
        "and are about to be dropped. If a file below is missing from the current\n" +
        "library directory, the path names where it used to live — copy it across\n" +
        "before this message stops appearing:\n" +
        drifted.join("\n") +
        "\n",
    );
  }

  if (hadFilePath) await knex.raw("ALTER TABLE books DROP COLUMN file_path");
  if (hadCoverPath) await knex.raw("ALTER TABLE books DROP COLUMN cover_path");
}

// --- Step 5: column adds that must follow the rebuild -----------------------

/**
 * Which published **version** the saved locator was taken in (brief 38 step 2).
 *
 * A plain ADD COLUMN, deliberately NOT the create-copy-drop-rename rebuild step
 * 3 needs. That rebuild exists because that migration had to change a composite
 * PRIMARY KEY, which SQLite cannot ALTER. Nothing of the sort happens here: the
 * key stays `(profile_id, book_id)` and this is an ordinary nullable column
 * beside it. Reaching for a rebuild anyway would take the one migration in the
 * repo that can destroy authored work and run it for a column add.
 *
 * `ON DELETE SET NULL` rather than CASCADE: deleting a version must not delete
 * the reader's progress ROW for the book, only its pointer at that version. The
 * next open finds `version_id IS NULL`, which is a mismatch, which starts at
 * page 0 — decision 10 arriving by itself with no special case.
 */
async function addProgressVersionColumn(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn("reading_progress", "version_id"))) {
    await knex.raw(
      `ALTER TABLE reading_progress ADD COLUMN version_id TEXT
         REFERENCES document_versions(id) ON DELETE SET NULL`,
    );
  }
}

/**
 * Which folder a note is filed in (brief 50 rule 2). **NULLABLE, and that is
 * the whole safety argument.** NULL means the root, so every note that exists
 * when this first runs stays exactly where its owner last saw it, with no
 * backfill, no rewrite of `data`, and nothing to get wrong. Notes are the one
 * subsystem where the content was *authored* rather than uploaded, so the
 * migration that touches them has to be the boring one.
 *
 * `ON DELETE SET NULL`, deliberately not CASCADE and not RESTRICT. **Deleting a
 * folder must never delete a notebook** (brief 50 rule 5): a CASCADE here would
 * be a second, silent path to exactly the loss that rule forbids, and it would
 * be reached by a mis-click. SET NULL means the worst a stray folder delete can
 * do is lift a note back to the root, where it is still there and still
 * openable. (The route does better than the constraint — it lifts notes to the
 * deleted folder's PARENT — but the constraint is the floor, and the floor must
 * not be lossy.)
 */
async function addNoteFolderColumn(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn("notes", "folder_id"))) {
    await knex.raw(
      `ALTER TABLE notes ADD COLUMN folder_id TEXT
         REFERENCES note_folders(id) ON DELETE SET NULL`,
    );
  }
}

// --- Step 6: indexes that depend on the migrated shape ----------------------

async function createLateIndexes(knex: Knex): Promise<void> {
  // A source book has at most one converted book (brief 34). Enforced rather
  // than assumed, because two rows pointing at the same source would make
  // `converted_to` ambiguous and put a second, invisible card's file on disk
  // with no way to reach it. SQLite treats NULLs as distinct in a unique index,
  // so every ordinary (non-derived) book is unaffected. Doubles as the index
  // the ON DELETE CASCADE lookup wants.
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS books_converted_from ON books(converted_from)",
  );

  // Created after the profile rebuild, never with the table: on a pre-brief-35
  // database `notes.profile_id` does not exist until step 3 has run. The old
  // `notes_user_updated` index dies with the table that rebuild drops.
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS notes_profile_updated ON notes(profile_id, updated_at DESC)",
  );
}
