import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  BookSource,
  CompileStatus,
  ConvertStatus,
  FileType,
  LibraryBook,
  LibrarySort,
  MediaKind,
  ProfileColor,
} from "@ebook-reader/shared";
import { kindForFormat } from "@ebook-reader/shared";
import { DATA_DIR, DB_PATH } from "./config.js";
import { coverOwnerId, coverPathFor, filePathFor } from "./paths.js";

/**
 * SQLite-backed library store (decisions.md D24). Synchronous
 * `better-sqlite3` — simplest for a single-user local API; no connection pool,
 * no async ceremony. One `books` table; image/file bytes live on disk (D25),
 * this table stores only metadata. Where a file *is* is not stored at all — it
 * is derived from the row by `paths.ts`.
 */

/**
 * The convert half of a book row (brief 34, D34). Split out from `BookRow` so
 * the upload/import paths can build a row without them — they all take their
 * SQL defaults, and a book nobody has converted is the overwhelming case.
 *
 * `converted_from` is the whole architecture: a **converted book** is its own
 * `books` row pointing back at its **source book**, not an alternate file on
 * the source's row. The status columns describe the *conversion*, so they live
 * on the source — that is the row the reader is looking at when it asks for one.
 */
export interface BookConvertFields {
  /**
   * The **source book** this row was converted from, or null when this row is
   * itself a source. Non-null = a converted book, which the three list
   * statements hide (see `BOOK_COLUMNS`).
   *
   * `REFERENCES books(id) ON DELETE CASCADE`: deleting a source removes its
   * converted book's ROW for free. Its FILE is `DELETE /library/:id`'s job —
   * the cascade happens inside SQLite where no unlink can run, so a route that
   * deletes only the row it was given orphans the converted file on disk.
   */
  converted_from: string | null;
  /** Where this book sits in the convert machine (`CONVERT_STATUSES`). */
  convert_status: ConvertStatus;
  /** Why the last conversion failed, in words a reader can act on, or null. */
  convert_error: string | null;
  /**
   * ISO timestamp the running job started, or null. Kept after the job ends —
   * it is what a 24h ceiling (D34) and any "converting since…" copy measure
   * against, and `markConvertRunning` overwrites it on the next run anyway.
   */
  convert_started_at: string | null;
  /**
   * The **converted book** made from this row, or null when none exists.
   *
   * NOT a column — it is the reverse of `converted_from`, resolved by the same
   * SELECT (see `BOOK_COLUMNS`). The wire contract needs both link directions
   * on every row so the reader can offer the format switch from either side,
   * and looking it up per row inside `toLibraryBook` would turn one library
   * listing into N+1 queries.
   */
  converted_to: string | null;
}

/** The raw DB row (server-side; includes on-disk paths that never hit the wire). */
export interface BookRow extends BookConvertFields {
  id: string;
  title: string;
  author: string | null;
  format: FileType;
  size_bytes: number;
  progress: number;
  created_at: string;
  last_opened_at: string | null;
  /** Series name, or null when the file carries none (brief 21). */
  series: string | null;
  /** Position within `series`, or null when unknown (brief 21). */
  series_index: number | null;
  /**
   * JSON-encoded `string[]` of subject/genre tags (brief 21), or null for a row
   * that predates the column and hasn't been backfilled yet — the backfill uses
   * `subjects IS NULL` as its "needs re-scan" sentinel, so a scanned-but-empty
   * book stores `'[]'`, never null.
   */
  subjects: string | null;
  /**
   * Provenance (brief 22): "upload" for user uploads, "gutenberg" for catalog
   * imports. Column has `DEFAULT 'upload'` so existing rows and the upload path
   * are correct without a backfill.
   */
  source: BookSource;
  /** Upstream id within `source` (the Gutenberg id for imports), else null. */
  source_id: string | null;
  /**
   * Media kind (brief 23), derived from `format` at upload: "book" for pdf/epub,
   * "audio" for mp3, "video" for mp4/webm. Column has `DEFAULT 'book'` so
   * pre-media rows migrate to books with no backfill.
   */
  kind: MediaKind;
  /** Playback length in seconds for audio/video, or null (books / unknown). */
  duration_seconds: number | null;
}

/**
 * A row as the upload/import paths build it: everything except the convert
 * fields, which the column defaults supply (`convert_status` = 'none', the rest
 * NULL). A **converted book** is never inserted this way — it goes through
 * `insertConvertedBook`, which is the only place `converted_from` is written.
 */
export type NewBookRow = Omit<BookRow, keyof BookConvertFields>;

/**
 * A user account. Accounts are operator-seeded (no self-registration); the
 * library is shared across all of them, so there is no per-book ownership.
 */
export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

/**
 * One profile on an account (brief 35, D35) — a person in the household. Owns
 * reading progress, notes and preferences; the library stays shared, across
 * profiles as it is across accounts. Cascades away with its user.
 *
 * A profile is an identity boundary, never a security one: switching is free,
 * so anything keyed here is readable by anyone holding a live session on the
 * account. The *account* remains the security boundary (D30).
 */
export interface ProfileRow {
  id: string;
  /** The owning account. */
  user_id: string;
  /** 1–24 chars; unique per account via the `profiles_user_name` index. */
  name: string;
  /** A Reading Room kind-tint token name (`PROFILE_COLORS`), never a hex. */
  color: ProfileColor;
  /** SQLite has no boolean: 1 for the account's fallback profile, else 0. */
  is_default: number;
  /**
   * The preferences JSON blob (theme / font settings / page mode / TOC
   * sidebar — brief 35 step 8), or null until the profile first writes one.
   * Stored and returned verbatim so an unknown key from a newer client can't
   * be stripped in transit; only the client parses it.
   */
  preferences: string | null;
  created_at: string;
}

/**
 * The identity attached to an authenticated request: the account, plus the
 * profile the session last activated.
 *
 * The profile rides along because the guard needs both from one lookup on every
 * request. `activeProfileId` is null for a session that predates brief 35 or
 * whose profile was deleted (the FK is `ON DELETE SET NULL` — losing a profile
 * must not log the device out); callers fall back to the account's default via
 * `getDefaultProfile`, because a missing profile is never an auth failure.
 */
export interface SessionUser {
  id: string;
  username: string;
  activeProfileId: string | null;
}

/** A raw notes row (brief 26); `data` is JSON-encoded `NotePage[]`. */
export interface NoteRow {
  id: string;
  /** Profile-scoped since brief 35 — a notebook belongs to a person, not a household. */
  profile_id: string;
  title: string;
  data: string;
  created_at: string;
  updated_at: string;
}

/**
 * A **LaTeX project** — the *draft* half of brief 38 (decisions 1, 2, 8, 11).
 *
 * A draft lives only in `/latex` and is NEVER a `books` row, so it never
 * reaches the media gallery, search, chips or counts — those are all derived
 * client-side from `GET /library`, which reads `books` and nothing else.
 * Publishing is what produces a library entry, and it produces exactly ONE no
 * matter how many times it is pressed: `published_book_id` is set on the first
 * publish and every later publish appends a `document_versions` row to that
 * same book.
 *
 * The project's *files* are not here: multi-file including binaries, so they
 * live on disk with a row pointing at them — the same split D25 chose for the
 * library. Where they live is derived from `id`, never stored (D39).
 */
export interface LatexProjectRow {
  id: string;
  /**
   * The owning profile. `ON DELETE CASCADE`, like `reading_progress` and unlike
   * `notes`: a draft's *published* work survives its author (see
   * `published_book_id`), so deleting a profile does not destroy authored output
   * the way it would for a notebook, and there is nothing to reassign.
   */
  profile_id: string;
  title: string;
  /** Project-relative path compiled as the document root; defaults to `main.tex`. */
  entrypoint: string;
  /**
   * Where this project sits in the compile machine (`COMPILE_STATUSES`). Mirrors
   * `convert_status` deliberately — the compile job IS brief 34's job runner
   * with a much shorter ceiling, so it has the same outcomes.
   */
  compile_status: CompileStatus;
  /**
   * The ONE library entry this project publishes into, or null until its first
   * publish.
   *
   * `REFERENCES books(id) ON DELETE SET NULL` — decision 11, and the difference
   * between it and the CASCADE two fields up is a product decision, not a
   * default. Publishing is the act of making something independent, so the two
   * sides are severable in *both* directions:
   *  - delete the **library entry** → this column goes NULL and the draft is
   *    still here, still editable, ready to be published afresh. A CASCADE here
   *    would silently destroy the source of the thing that was deleted.
   *  - delete the **draft** → nothing at all happens to the `books` row, because
   *    the reference points the other way. The published document keeps its
   *    versions and keeps opening.
   * A version's own lifetime is the third case and *is* a cascade — see
   * `DocumentVersionRow`.
   */
  published_book_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One published **version** of a document (brief 38 decisions 8 and 11).
 *
 * Pressing publish ten times gives ten of these rows on ONE `books` card, never
 * ten cards. `version_no` is 1-based and dense per book (`appendDocumentVersion`
 * allocates it), and `(book_id, version_no)` is unique so two concurrent
 * publishes cannot both claim v4.
 *
 * NO PATH COLUMNS, deliberately (D39, correction of 2026-08-27): the version's
 * PDF and its project zip are derived from `id` by `paths.ts`, exactly as a
 * book's file is derived from its own id. Brief 41 dropped `books.file_path` /
 * `books.cover_path` for being a stale cache of a pure function; storing
 * `pdf_path` / `source_zip_path` here would reintroduce that on its first day.
 *
 * `ON DELETE CASCADE` on `book_id`: deleting the library entry removes every
 * version (decision 11). As always in this file the cascade takes the ROW, not
 * the FILE — whoever deletes a book must unlink each version's artifacts first,
 * because after the cascade nothing is left pointing at them.
 */
export interface DocumentVersionRow {
  id: string;
  book_id: string;
  /** 1-based, dense per book, allocated by `appendDocumentVersion`. */
  version_no: number;
  published_at: string;
}

/**
 * One profile's reading state for one book. Progress + resume position are
 * per-profile since brief 35 (D35, revising D31's per-user scope): the library
 * is shared, the place you're at is not.
 */
export interface ProfileProgressRow {
  book_id: string;
  /** 0..1, drives the cover progress bar. */
  progress: number;
  /** Opaque resume position: PDF page number (string) or EPUB CFI; null if unset. */
  locator: string | null;
  /**
   * ISO timestamp of the last write to this row (brief 34 step 7,
   * pre-authorised addition of `lastReadAt` to the wire): what "which of a
   * linked pair did this reader use last" compares. Every stored row has one
   * (`NOT NULL`); a book this profile has never opened simply has no row at
   * all, which callers represent as `null` rather than by faking a value here.
   */
  updated_at: string;
  /**
   * Which published **version** `locator` belongs to (brief 38 decision 10), or
   * null for an ordinary book — one that was uploaded or imported rather than
   * published from a LaTeX project, which is every book that has no
   * `document_versions` rows at all.
   *
   * Nullable and NOT part of the primary key, on purpose. The key stays
   * `(profile_id, book_id)`, so a reader has exactly ONE saved position per
   * book, and this column says which version that position was taken in.
   * Opening a version whose id differs starts at page 0 — decision 10, the
   * owner's rule: *"when you are on page 40 on v3 and publish v4, you will
   * resume from page 0 of v4."* An older version therefore does NOT keep its
   * own position; making it part of the key is exactly the third progress
   * mechanism that simplification exists to avoid.
   *
   * `REFERENCES document_versions(id) ON DELETE SET NULL`, so deleting a version
   * leaves the row intact with its pointer cleared rather than a dangling id.
   * The reader's behaviour is the same either way (a mismatch starts at 0); what
   * the constraint buys is that `PRAGMA foreign_key_check` stays meaningful.
   */
  version_id: string | null;
}

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  -- No path columns here on purpose: where a book's file and thumbnail live is
  -- derived from the row by paths.ts, never stored. A pre-existing database
  -- still has the old file_path/cover_path columns at this point;
  -- dropLegacyPathColumns below removes them.
  CREATE TABLE IF NOT EXISTS books (
    id            TEXT    PRIMARY KEY,
    title         TEXT    NOT NULL,
    author        TEXT,
    format        TEXT    NOT NULL,
    size_bytes    INTEGER NOT NULL,
    progress      REAL    NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL,
    last_opened_at TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT    PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
  );

  -- Opaque login sessions: a random token maps to a user. Rows are removed
  -- (ON DELETE CASCADE) if the user is ever deleted.
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT    PRIMARY KEY,
    user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL
  );

  -- Profiles (brief 35, D35): the people inside one household account. Free to
  -- switch between, so an identity boundary and not a security one. Cascades
  -- away with the account. Names are unique per account (index below); colours
  -- deliberately are not — colour is a glance cue, not a key.
  CREATE TABLE IF NOT EXISTS profiles (
    id          TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    -- Preferences JSON (brief 35 step 8); NULL until the profile first writes.
    preferences TEXT,
    created_at  TEXT    NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_name ON profiles(user_id, name);

  -- Per-profile reading state (progress + exact resume position). One row per
  -- (profile, book); the book itself is shared. Cascades away with the profile
  -- or the book. Pre-brief-35 databases have this keyed on user_id instead and
  -- are rebuilt by migrateToProfileScope below — SQLite cannot ALTER a
  -- composite primary key.
  CREATE TABLE IF NOT EXISTS reading_progress (
    profile_id    TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id       TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    progress      REAL    NOT NULL DEFAULT 0,
    locator       TEXT,
    updated_at    TEXT    NOT NULL,
    PRIMARY KEY (profile_id, book_id)
  );
`);
// Per-profile notes (brief 26; rescoped from the user by brief 35): a paged
// notebook with vector ink + text boxes, stored as JSON in `data`. Kept in its
// own statement so the books schema block stays focused.
//
// ON DELETE RESTRICT, unlike every other relation here, is deliberate. Brief 35
// decision 3: notes are *authored*, so deleting a profile must move them to the
// account's default (`reassignNotes`) rather than destroy them, and the delete
// route requires that explicitly. A cascade here would be a silent second path
// to the exact loss that decision forbids; RESTRICT makes forgetting it a loud
// constraint error instead. See `deleteProfile`.
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id         TEXT NOT NULL PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    title      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// LaTeX drafts and published versions (brief 38). Kept in their own statement,
// like `notes` above, so the books schema block stays focused.
//
// The two foreign-key behaviours below differ ON PURPOSE, and the difference is
// brief 38 decision 11 rather than a default anyone reached for:
//
//   latex_projects.profile_id       -> profiles(id)  ON DELETE CASCADE
//   latex_projects.published_book_id-> books(id)     ON DELETE SET NULL
//   document_versions.book_id       -> books(id)     ON DELETE CASCADE
//
// A **draft** and a **published document** are different things in different
// places. The draft lives only in `/latex`; publishing copies work OUT of it
// into one `books` row that then stands on its own. So the link between them
// must break cleanly from either end: deleting the library entry clears
// `published_book_id` and leaves the draft editable (SET NULL), and deleting the
// draft does nothing at all to the `books` row, because the reference only
// points one way. A CASCADE on `published_book_id` would make "tidy up the
// library" silently delete the manuscript.
//
// `document_versions` is the opposite case and so is the opposite clause: a
// version is not independent of its entry, it IS its entry's history, and an
// entry with no versions has nothing to show. Deleting the book takes every
// version row with it.
//
// As everywhere else in this file the cascade removes ROWS, never FILES.
// Whoever deletes a book must unlink each version's PDF and project zip first —
// after the cascade nothing is left pointing at them. Those locations are
// derived from the version id by `paths.ts` and are deliberately NOT stored
// here (D39; see `DocumentVersionRow`).
db.exec(`
  CREATE TABLE IF NOT EXISTS latex_projects (
    id                TEXT PRIMARY KEY,
    profile_id        TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    -- Project-relative path of the document root. A default rather than a
    -- nullable column: every project has an entrypoint, and a new one is seeded
    -- from a hello-world called main.tex (brief 38 decision 4).
    entrypoint        TEXT NOT NULL DEFAULT 'main.tex',
    compile_status    TEXT NOT NULL DEFAULT 'none',
    -- NULL until the first publish; see the note above on SET NULL.
    published_book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  -- The project list is per-profile, most-recently-edited first — this index is
  -- exactly that query, the same shape as notes_profile_updated.
  CREATE INDEX IF NOT EXISTS latex_projects_profile_updated
    ON latex_projects(profile_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS document_versions (
    id           TEXT    PRIMARY KEY,
    book_id      TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    version_no   INTEGER NOT NULL,
    published_at TEXT    NOT NULL
  );
  -- Enforced, not assumed: appendDocumentVersion allocates the next number with
  -- a MAX()+1 subquery, so two publishes racing for v4 must not both win.
  -- Doubles as the index the per-book version listing and the ON DELETE CASCADE
  -- lookup both want.
  CREATE UNIQUE INDEX IF NOT EXISTS document_versions_book_no
    ON document_versions(book_id, version_no);
`);

// Enforce the sessions→users foreign key (off by default in SQLite).
db.pragma("foreign_keys = ON");

/**
 * Idempotent column adds for the `books` table (brief 21). SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so guard each with `pragma table_info`. New
 * columns default to NULL on existing rows; the startup backfill fills them
 * (`subjects IS NULL` is the sentinel — see `listBooksNeedingMetadata`).
 */
function ensureBookColumns(): void {
  const existing = new Set(
    (db.pragma("table_info(books)") as { name: string }[]).map((c) => c.name),
  );
  const additions: Record<string, string> = {
    series: "TEXT",
    series_index: "REAL",
    subjects: "TEXT",
    // Provenance (brief 22). NOT NULL DEFAULT is legal in SQLite's ADD COLUMN
    // because it supplies a value for every existing row, so uploads keep
    // source='upload' with no backfill.
    source: "TEXT NOT NULL DEFAULT 'upload'",
    source_id: "TEXT",
    // Media (brief 23). NOT NULL DEFAULT 'book' migrates existing rows to books
    // with no backfill; duration is null for books and unknown-duration media.
    kind: "TEXT NOT NULL DEFAULT 'book'",
    duration_seconds: "REAL",
    // Convert (brief 34, D34). SQLite accepts a REFERENCES clause on ADD COLUMN
    // only when the new column defaults to NULL, which this one does — verified
    // empirically against the bundled SQLite on the live schema, same as
    // `sessions.active_profile_id` (brief 35). So the cascade is real and not
    // quietly downgraded to a bare TEXT column.
    //
    // ON DELETE CASCADE is what makes deleting a source book take its converted
    // book's row with it. The FILE is not SQLite's to delete: `DELETE
    // /library/:id` must unlink both rows' files itself, or the cascaded row's
    // file is orphaned on disk with nothing left pointing at it.
    converted_from: "TEXT REFERENCES books(id) ON DELETE CASCADE",
    // NOT NULL DEFAULT supplies a value for every existing row, so no backfill.
    convert_status: "TEXT NOT NULL DEFAULT 'none'",
    convert_error: "TEXT",
    convert_started_at: "TEXT",
  };
  for (const [name, type] of Object.entries(additions)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE books ADD COLUMN ${name} ${type}`);
    }
  }
}
ensureBookColumns();

/** Column names of `table`, for the idempotent-migration guards. */
function columnsOf(table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name));
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * Idempotent column add for `sessions` (brief 35 decision 1): the session
 * carries the active profile, so every request resolves it alongside the user
 * with no change to how anything authenticates.
 *
 * `ON DELETE SET NULL`, deliberately not CASCADE — deleting a profile must not
 * log the device out; the guard falls back to the account's default. SQLite
 * accepts a REFERENCES clause on ADD COLUMN only when the new column defaults
 * to NULL, which this one does (verified against the bundled SQLite 3.53.2), so
 * the constraint is real and not quietly dropped.
 */
function ensureSessionColumns(): void {
  if (!columnsOf("sessions").has("active_profile_id")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN active_profile_id TEXT
         REFERENCES profiles(id) ON DELETE SET NULL`,
    );
  }
}

/**
 * Give every account that has no profile at all a `Default` one (brief 35
 * decision 2). Runs on every boot, not just at migration: it is the safety net
 * that keeps "every account has at least one profile" true for accounts seeded
 * *after* the migration, which the guard's default-profile fallback and the
 * login response both rely on. A no-op once each account has one.
 */
function ensureDefaultProfiles(): void {
  const orphans = db
    .prepare(
      `SELECT u.id AS id FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id)`,
    )
    .all() as { id: string }[];
  if (orphans.length === 0) return;

  const insert = db.prepare<[string, string, string]>(
    `INSERT INTO profiles (id, user_id, name, color, is_default, preferences, created_at)
     VALUES (?, ?, 'Default', 'cream', 1, NULL, ?)`,
  );
  const now = new Date().toISOString();
  for (const user of orphans) insert.run(randomUUID(), user.id, now);
}

/**
 * Move `reading_progress` and `notes` from user scope to profile scope
 * (brief 35 step 2; D35 revising D31). Both are keyed on `user_id`, and
 * `reading_progress`'s composite primary key means SQLite cannot ALTER it, so
 * both need the documented create-copy-drop-rename rebuild.
 *
 * The whole thing is one transaction that asserts its own row counts and
 * rolls back on any mismatch: this is the one migration in the repo that can
 * destroy authored work, so a warning-and-continue would be worse than a crash.
 *
 * `foreign_keys` is off across the rebuild per SQLite's ALTER-TABLE procedure
 * (otherwise the DROP would cascade rows away). It cannot be toggled inside a
 * transaction, hence the pragma/try/finally wrapping rather than the reverse —
 * and `foreign_key_check` runs *inside* the transaction, where a violation can
 * still roll back.
 *
 * Idempotent (the `profile_id` guards, same shape as `ensureBookColumns`) and
 * silent on an empty database, which is the common case for a fresh install.
 */
function migrateToProfileScope(): void {
  const progressNeedsMigration = !columnsOf("reading_progress").has("profile_id");
  const notesNeedMigration = !columnsOf("notes").has("profile_id");
  if (!progressNeedsMigration && !notesNeedMigration) return;

  const beforeProgress = countRows("reading_progress");
  const beforeNotes = countRows("notes");

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      // Rows are rehomed by joining through these, so they must exist first.
      ensureDefaultProfiles();

      if (progressNeedsMigration) {
        db.exec(`
          CREATE TABLE reading_progress_new (
            profile_id    TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            book_id       TEXT    NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            progress      REAL    NOT NULL DEFAULT 0,
            locator       TEXT,
            updated_at    TEXT    NOT NULL,
            PRIMARY KEY (profile_id, book_id)
          );
          INSERT INTO reading_progress_new
                 (profile_id, book_id, progress, locator, updated_at)
          SELECT p.id, rp.book_id, rp.progress, rp.locator, rp.updated_at
            FROM reading_progress rp
            JOIN profiles p ON p.user_id = rp.user_id AND p.is_default = 1;
          DROP TABLE reading_progress;
          ALTER TABLE reading_progress_new RENAME TO reading_progress;
        `);
      }

      if (notesNeedMigration) {
        db.exec(`
          CREATE TABLE notes_new (
            id         TEXT NOT NULL PRIMARY KEY,
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
            title      TEXT NOT NULL,
            data       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO notes_new (id, profile_id, title, data, created_at, updated_at)
          SELECT n.id, p.id, n.title, n.data, n.created_at, n.updated_at
            FROM notes n
            JOIN profiles p ON p.user_id = n.user_id AND p.is_default = 1;
          DROP TABLE notes;
          ALTER TABLE notes_new RENAME TO notes;
        `);
      }

      // The join above drops any row whose account has no default profile, so a
      // count mismatch means rows were silently lost. Throw: the transaction
      // rolls back and the DB is left exactly as it was found.
      const afterProgress = countRows("reading_progress");
      const afterNotes = countRows("notes");
      if (afterProgress !== beforeProgress || afterNotes !== beforeNotes) {
        throw new Error(
          `Profile migration would lose rows (progress ${beforeProgress}→${afterProgress}, ` +
            `notes ${beforeNotes}→${afterNotes}); rolled back.`,
        );
      }

      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Profile migration left ${violations.length} foreign-key violation(s); rolled back: ` +
            JSON.stringify(violations),
        );
      }
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

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
 * only value they could ever add was disagreement with the disk (an absolute
 * path carried over from another machine, a thumbnail removed out of band).
 * Nothing has read them since the derivation landed; dropping them makes the
 * drift impossible instead of merely correctable.
 *
 * `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35+; the bundled better-sqlite3
 * is 3.53.2 (same build `ensureBookColumns` verifies its REFERENCES clause
 * against), and the drop was checked against this exact schema shape: the
 * `books_converted_from` unique index and the `reading_progress` / `notes` /
 * self-referential foreign keys all survive it, because SQLite rewrites the
 * table definition in place and neither column is named by any of them. That is
 * why this is a plain DROP and not the create-copy-drop-rename rebuild
 * `migrateToProfileScope` needs — no constraint here has to change shape.
 *
 * Idempotent via `columnsOf`, so this is a no-op on a fresh database (the
 * schema block above never creates the columns) and on one already migrated.
 */
function dropLegacyPathColumns(): void {
  const columns = columnsOf("books");
  const hadFilePath = columns.has("file_path");
  const hadCoverPath = columns.has("cover_path");
  if (!hadFilePath && !hadCoverPath) return;

  // READ BEFORE DESTROYING. The claim above — that these columns never held
  // information — is true of every row a writer in *this* checkout created,
  // because every writer computed the derived name and stored that same string
  // back. It is NOT guaranteed of a row carried in from somewhere else: a
  // database moved between machines or checkouts holds an absolute path into a
  // directory that is no longer `LIBRARY_FILES_DIR`, and for such a row the
  // stored path is the only surviving record of where those bytes actually
  // are. Dropping it unread would discard that pointer permanently and
  // silently, on a library with no version history.
  //
  // So: compare every row against its derivation first and say so loudly if
  // they disagree. Written with `console.warn` because migrations run at module
  // import, before Fastify's logger exists — the same reason `config.ts`
  // reports startup failures on the console directly.
  const legacy = db
    .prepare(
      `SELECT id, format, converted_from,
              ${hadFilePath ? "file_path" : "NULL AS file_path"},
              ${hadCoverPath ? "cover_path" : "NULL AS cover_path"}
         FROM books`,
    )
    .all() as {
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

  for (const name of ["file_path", "cover_path"]) {
    if (columns.has(name)) db.exec(`ALTER TABLE books DROP COLUMN ${name}`);
  }
}

/**
 * A source book has at most one converted book (brief 34). Enforced rather than
 * assumed, because two rows pointing at the same source would make
 * `converted_to` ambiguous and put a second, invisible card's file on disk with
 * no way to reach it. SQLite treats NULLs as distinct in a unique index, so
 * every ordinary (non-derived) book is unaffected. Doubles as the index the
 * ON DELETE CASCADE lookup wants.
 */
function ensureConvertIndex(): void {
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS books_converted_from ON books(converted_from)",
  );
}

/**
 * Idempotent column add for `reading_progress` (brief 38 step 2): which
 * published **version** the saved locator was taken in.
 *
 * A plain `ALTER TABLE ADD COLUMN`, deliberately NOT the create-copy-drop-rename
 * rebuild `migrateToProfileScope` needs. That rebuild exists because that
 * migration had to change a composite PRIMARY KEY, which SQLite cannot ALTER.
 * Nothing of the sort is happening here: the key stays `(profile_id, book_id)`
 * and this is an ordinary nullable column beside it. Reaching for a rebuild
 * anyway would take the one migration in the repo that can destroy authored work
 * and run it for a column add.
 *
 * `ON DELETE SET NULL` rather than CASCADE: deleting a version must not delete
 * the reader's progress ROW for the book, only its pointer at that version. The
 * next open finds `version_id IS NULL`, which is a mismatch, which starts at
 * page 0 — decision 10 arriving by itself with no special case. SQLite accepts a
 * REFERENCES clause on ADD COLUMN only when the new column defaults to NULL,
 * which this one does (the same rule `ensureSessionColumns` and
 * `ensureBookColumns` rely on), so the constraint is real.
 *
 * MUST run after `migrateToProfileScope`: on a pre-brief-35 database that
 * function drops and recreates `reading_progress` from a DDL that has never
 * heard of this column, so adding it first would silently lose it.
 */
function ensureProgressVersionColumn(): void {
  if (!columnsOf("reading_progress").has("version_id")) {
    db.exec(
      `ALTER TABLE reading_progress ADD COLUMN version_id TEXT
         REFERENCES document_versions(id) ON DELETE SET NULL`,
    );
  }
}

/**
 * What a row reaped by `reapInterruptedConversions` says. Exported so the job
 * runner and the status button can recognise this specific failure rather than
 * string-matching a sentence that may be reworded.
 */
export const CONVERT_INTERRUPTED_ERROR =
  "The conversion stopped when the server restarted. Nothing was lost — start it again when you're ready.";

/**
 * Flip every row left in `convert_status = 'running'` to `failed` (D34 decision
 * 7). A job cannot survive the process: its `ebook-convert` child died with the
 * old process and the in-memory job map went with it, so a row left `running`
 * would poll forever with no button able to rescue it.
 *
 * Deliberately NOT an auto-resume — decision 7 rejected that because one book
 * Calibre chokes on would restart, crash, and restart again on every boot.
 * Retry lives in the button, where a person decides.
 *
 * Idempotent (the second run matches nothing) and a no-op on an empty database.
 */
function reapInterruptedConversions(): void {
  db.prepare<[string]>(
    `UPDATE books
        SET convert_status = 'failed', convert_error = ?
      WHERE convert_status = 'running'`,
  ).run(CONVERT_INTERRUPTED_ERROR);
}

/**
 * Flip every LaTeX project left in `compile_status = 'running'` to `failed`, the
 * exact counterpart of `reapInterruptedConversions` and for the exact same
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
 *
 * Idempotent (the second run matches nothing) and a no-op on a fresh database.
 */
function reapInterruptedLatexCompiles(): void {
  db.prepare("UPDATE latex_projects SET compile_status = 'failed' WHERE compile_status = 'running'").run();
}

ensureSessionColumns();
migrateToProfileScope();
dropLegacyPathColumns();
// After migrateToProfileScope, which rebuilds `reading_progress` wholesale on a
// pre-brief-35 database — see the note on the function.
ensureProgressVersionColumn();
ensureDefaultProfiles();
ensureConvertIndex();
reapInterruptedConversions();
reapInterruptedLatexCompiles();

// Created after the migration, never in the schema block above: on a
// pre-brief-35 database `notes.profile_id` does not exist yet at that point.
// The old `notes_user_updated` index dies with the table the rebuild drops.
db.exec(`
  CREATE INDEX IF NOT EXISTS notes_profile_updated
    ON notes(profile_id, updated_at DESC);
`);

/**
 * The projection every read of `books` goes through: the stored columns plus
 * `converted_to`, the reverse of `converted_from`, resolved by a correlated
 * subquery in the same statement.
 *
 * Doing it here rather than per row is the whole point — the wire contract
 * carries both link directions on every book, so a lookup inside
 * `toLibraryBook` would make one library listing N+1 queries. The unique index
 * `books_converted_from` is what lets the subquery be a scalar.
 */
const BOOK_COLUMNS = `b.*, (SELECT c.id FROM books c WHERE c.converted_from = b.id) AS converted_to`;

/**
 * The clause that delivers "one card per book" (D34): a **converted book** is a
 * real `books` row, so every statement that LISTS books for a person must
 * exclude it or the library shows the same book twice.
 *
 * READ THIS BEFORE ADDING A FOURTH LIST STATEMENT — it needs this clause too,
 * and nothing else in the codebase will tell you. It is load-bearing far beyond
 * the grid: cross-library search, kind chips, grouping and every count are
 * **client-side over the list `GET /library` returned**
 * (`apps/web/src/library/search.ts`), so they all inherit the hiding from these
 * three statements and from nowhere else. Filter here and derived rows vanish
 * everywhere at once; forget here and they reappear everywhere at once.
 *
 * It is deliberately NOT applied to `getById` (the reader opens a converted
 * book by id — that is the format switch), nor to the backfill/reconcile
 * statements below, which want every row.
 */
const NOT_CONVERTED = "b.converted_from IS NULL";

const statements = {
  insert: db.prepare<NewBookRow>(`
    INSERT INTO books (id, title, author, format,
                       size_bytes, progress, created_at, last_opened_at,
                       series, series_index, subjects, source, source_id,
                       kind, duration_seconds)
    VALUES (@id, @title, @author, @format,
            @size_bytes, @progress, @created_at, @last_opened_at,
            @series, @series_index, @subjects, @source, @source_id,
            @kind, @duration_seconds)
  `),
  // No `NOT_CONVERTED` here on purpose: a converted book is opened by id every
  // time the reader switches format.
  getById: db.prepare<[string]>(`SELECT ${BOOK_COLUMNS} FROM books b WHERE b.id = ?`),
  // "Recent" orders by the most recent activity on EITHER half of a convert
  // pair. Opening the converted twin touches only that row, which is hidden
  // from this list, so ordering on `b.last_opened_at` alone would freeze a
  // book's position the moment its reader switched format. The correlated
  // MAX covers the row itself and its conversion, and is indexed by
  // `books_converted_from`.
  listRecent: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE ${NOT_CONVERTED}
      ORDER BY COALESCE(
        (SELECT MAX(x.last_opened_at) FROM books x
          WHERE x.id = b.id OR x.converted_from = b.id),
        b.last_opened_at, b.created_at
      ) DESC`,
  ),
  listByTitle: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE ${NOT_CONVERTED}
      ORDER BY b.title COLLATE NOCASE ASC`,
  ),
  listByAuthor: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE ${NOT_CONVERTED}
      ORDER BY b.author COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
  ),
  touchOpened: db.prepare<[string, string]>(
    "UPDATE books SET last_opened_at = ? WHERE id = ?",
  ),
  remove: db.prepare<[string]>("DELETE FROM books WHERE id = ?"),

  // --- Metadata backfill (brief 21) ----------------------------------------
  // Rows added before the series/subjects columns existed have subjects=NULL.
  // Unfiltered by design: a converted book still wants correct metadata, and a
  // backfill is maintenance, not a user-facing list. (In practice one never
  // matches — `insertConvertedBook` copies the source's subjects as JSON, never
  // null — but the exemption is the deliberate one, not an accident.)
  listNeedingMetadata: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE b.subjects IS NULL`,
  ),
  // COALESCE on author lets a re-scan fill a previously-null author (PDFs) but
  // never clobber one already stored. `subjects` is set to a JSON array (never
  // null) so the row drops out of `listNeedingMetadata` and can't loop.
  updateMetadata: db.prepare<[string | null, number | null, string, string | null, string]>(`
    UPDATE books
       SET series = ?, series_index = ?, subjects = ?,
           author = COALESCE(author, ?)
     WHERE id = ?
  `),
  /**
   * Re-point a published document's card at its newest version (brief 38).
   * Unlike `updateMetadata` above, `title` is assigned outright rather than
   * COALESCEd: renaming the draft is how a person renames the published thing,
   * so the newest publish is authoritative. Without this the card keeps v1's
   * title and v1's byte size forever, which is a card describing a file it is
   * no longer serving.
   */
  updatePublishedBook: db.prepare<[string, number, string]>(`
    UPDATE books SET title = ?, size_bytes = ? WHERE id = ?
  `),

  // --- Convert (brief 34, D34) ----------------------------------------------
  insertConverted: db.prepare<NewBookRow & { converted_from: string }>(`
    INSERT INTO books (id, title, author, format,
                       size_bytes, progress, created_at, last_opened_at,
                       series, series_index, subjects, source, source_id,
                       kind, duration_seconds, converted_from)
    VALUES (@id, @title, @author, @format,
            @size_bytes, @progress, @created_at, @last_opened_at,
            @series, @series_index, @subjects, @source, @source_id,
            @kind, @duration_seconds, @converted_from)
  `),
  // The unique index guarantees at most one row here.
  getConvertedBook: db.prepare<[string]>(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE b.converted_from = ?`,
  ),
  // Clearing the error on start is what stops a retry showing the previous
  // run's reason while the new one is in flight.
  markConvertRunning: db.prepare<[string, string]>(
    `UPDATE books
        SET convert_status = 'running', convert_error = NULL, convert_started_at = ?
      WHERE id = ?`,
  ),
  setConvertStatus: db.prepare<[string, string | null, string]>(
    "UPDATE books SET convert_status = ?, convert_error = ? WHERE id = ?",
  ),
  resetConvert: db.prepare<[string]>(
    `UPDATE books
        SET convert_status = 'none', convert_error = NULL, convert_started_at = NULL
      WHERE id = ?`,
  ),
  // Oldest first so the refusal names the job that has been running longest,
  // which is the one a person is actually waiting on.
  getRunningConvert: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b
      WHERE b.convert_status = 'running'
      ORDER BY b.convert_started_at ASC LIMIT 1`,
  ),

  // --- Users ---------------------------------------------------------------
  getUserByName: db.prepare<[string]>("SELECT * FROM users WHERE username = ?"),
  upsertUser: db.prepare<UserRow>(`
    INSERT INTO users (id, username, password_hash, created_at)
    VALUES (@id, @username, @password_hash, @created_at)
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
  `),

  // --- Sessions ------------------------------------------------------------
  createSession: db.prepare<[string, string, string, string | null]>(
    "INSERT INTO sessions (token, user_id, created_at, active_profile_id) VALUES (?, ?, ?, ?)",
  ),
  // The active profile rides along on the identity lookup so the guard resolves
  // account + profile in one hit on every request (brief 35 decision 1). The
  // alias is camelCase because `SessionUser` is a request-facing shape, not a
  // raw row like `BookRow`.
  sessionUser: db.prepare<[string]>(
    `SELECT u.id AS id, u.username AS username,
            s.active_profile_id AS activeProfileId
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
  ),
  setSessionActiveProfile: db.prepare<[string | null, string]>(
    "UPDATE sessions SET active_profile_id = ? WHERE token = ?",
  ),
  deleteSession: db.prepare<[string]>("DELETE FROM sessions WHERE token = ?"),

  // --- Profiles (brief 35) --------------------------------------------------
  // Default first, then oldest first, so the picker's order is stable across
  // renames and the account's default always leads.
  listProfiles: db.prepare<[string]>(
    "SELECT * FROM profiles WHERE user_id = ? ORDER BY is_default DESC, created_at ASC",
  ),
  getProfile: db.prepare<[string]>("SELECT * FROM profiles WHERE id = ?"),
  getDefaultProfile: db.prepare<[string]>(
    "SELECT * FROM profiles WHERE user_id = ? AND is_default = 1",
  ),
  countProfiles: db.prepare<[string]>(
    "SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?",
  ),
  insertProfile: db.prepare<ProfileRow>(`
    INSERT INTO profiles (id, user_id, name, color, is_default, preferences, created_at)
    VALUES (@id, @user_id, @name, @color, @is_default, @preferences, @created_at)
  `),
  // COALESCE lets a name-only or colour-only PATCH leave the other intact.
  updateProfile: db.prepare<[string | null, string | null, string]>(`
    UPDATE profiles
       SET name = COALESCE(?, name),
           color = COALESCE(?, color)
     WHERE id = ?
  `),
  deleteProfile: db.prepare<[string]>("DELETE FROM profiles WHERE id = ?"),
  getProfilePreferences: db.prepare<[string]>(
    "SELECT preferences FROM profiles WHERE id = ?",
  ),
  setProfilePreferences: db.prepare<[string | null, string]>(
    "UPDATE profiles SET preferences = ? WHERE id = ?",
  ),

  // --- Per-profile reading progress ----------------------------------------
  listProfileProgress: db.prepare<[string]>(
    "SELECT book_id, progress, locator, updated_at, version_id FROM reading_progress WHERE profile_id = ?",
  ),
  getProfileProgress: db.prepare<[string, string]>(
    "SELECT book_id, progress, locator, updated_at, version_id FROM reading_progress WHERE profile_id = ? AND book_id = ?",
  ),
  // COALESCE keeps a previously-saved locator when a progress-only update sends
  // null, so a bar refresh can't wipe the resume position.
  //
  // `version_id` is COALESCEd for the same reason and as a matched pair with the
  // locator: the two are one fact — *this position, in this version* — so a
  // progress-only write that carries neither must leave both alone rather than
  // orphan a locator from the version it was taken in. The rule that follows for
  // callers: a write that supplies a `locator` for a published version MUST
  // supply that version's id alongside it.
  upsertProfileProgress: db.prepare<
    [string, string, number, string | null, string, string | null]
  >(`
    INSERT INTO reading_progress (profile_id, book_id, progress, locator, updated_at, version_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, book_id) DO UPDATE SET
      progress = excluded.progress,
      locator = COALESCE(excluded.locator, reading_progress.locator),
      updated_at = excluded.updated_at,
      version_id = COALESCE(excluded.version_id, reading_progress.version_id)
  `),
};

/**
 * Map a DB row to the wire shape (strips on-disk paths; D25). Progress + the
 * resume locator are per-profile, so they're passed in (from the caller's
 * `reading_progress` lookup); absent = this profile hasn't opened the book yet.
 */
export function toLibraryBook(
  row: NewBookRow & Partial<BookConvertFields>,
  progress: Pick<ProfileProgressRow, "progress" | "locator"> & { updated_at?: string | null } = {
    progress: 0,
    locator: null,
  },
): LibraryBook {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format,
    series: row.series,
    seriesIndex: row.series_index,
    subjects: parseSubjects(row.subjects),
    // The DERIVED cover file, stat'd on the spot — not a stored `cover_path`.
    // A row that claimed a cover whose file was gone (a library DB carried
    // between machines, a thumbnail removed out of band) used to make the
    // client fire a request that could only 404, which a cross-origin <img>
    // surfaces as the noisy ERR_BLOCKED_BY_ORB; a startup reconcile existed
    // solely to null those paths back out. Asking the disk instead makes the
    // drift impossible rather than correctable, which is why that machinery is
    // gone. One `existsSync` per book per listing, knowingly paid: it is a
    // stat on a path we just computed, and correctness here is worth more than
    // a cache that would reintroduce exactly the staleness we removed.
    // `converted_from` is optional on this parameter type (a freshly-built
    // upload row has not got one), so it is normalised explicitly rather than
    // by widening `coverOwnerId` — see the note on that function for why the
    // key is required there.
    hasCover: existsSync(
      coverPathFor(coverOwnerId({ id: row.id, converted_from: row.converted_from ?? null })),
    ),
    sizeBytes: row.size_bytes,
    progress: progress.progress,
    locator: progress.locator,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    durationSeconds: row.duration_seconds,
    // Both link directions come off the row the caller already has: the read
    // statements resolve `converted_to` in the same SELECT (`BOOK_COLUMNS`), so
    // rendering a library of N books is still one query, not N+1.
    //
    // The fallbacks are for the upload/import paths, which hand a row they just
    // built rather than one read back: a book being inserted is never a
    // conversion and has never been converted, which is exactly what the SQL
    // defaults say too.
    convertedFrom: row.converted_from ?? null,
    convertedTo: row.converted_to ?? null,
    convertStatus: row.convert_status ?? "none",
    convertError: row.convert_error ?? null,
    // The active profile's `reading_progress.updated_at` for this row, or null
    // when they've never opened it (brief 34 step 7's pre-authorised addition
    // — the wire previously exposed no progress timestamp at all). Lets the
    // client compare a linked pair's two rows and reopen whichever this reader
    // used last, without a second per-book request.
    lastReadAt: progress.updated_at ?? null,
  };
}

/** Decode the JSON `subjects` column to a `string[]` (empty on null/garbage). */
function parseSubjects(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function insertBook(row: NewBookRow): void {
  statements.insert.run(row);
}

export function getBook(id: string): BookRow | undefined {
  return statements.getById.get(id) as BookRow | undefined;
}

export function listBooks(sort: LibrarySort): BookRow[] {
  const stmt =
    sort === "title"
      ? statements.listByTitle
      : sort === "author"
        ? statements.listByAuthor
        : statements.listRecent;
  return stmt.all() as BookRow[];
}

export function touchOpened(id: string, now: string): void {
  statements.touchOpened.run(now, id);
}

export function deleteBook(id: string): void {
  statements.remove.run(id);
}

/**
 * Books whose metadata predates the series/subjects columns (subjects IS NULL),
 * for the one-time startup backfill (brief 21).
 */
export function listBooksNeedingMetadata(): BookRow[] {
  return statements.listNeedingMetadata.all() as BookRow[];
}

/**
 * Persist re-scanned series/subject metadata for one book (backfill or a future
 * re-index). `subjects` is a `string[]` stored as JSON; `author` fills a
 * previously-null author without overwriting an existing one (COALESCE).
 */
/**
 * Point a published document's `books` row at what its newest version actually
 * is. Called on every publish, including re-publishes — see the statement's
 * comment for why `title` is overwritten rather than preserved.
 */
export function updatePublishedBook(id: string, title: string, sizeBytes: number): void {
  statements.updatePublishedBook.run(title, sizeBytes, id);
}

export function updateBookMetadata(
  id: string,
  meta: { series: string | null; seriesIndex: number | null; subjects: string[]; author: string | null },
): void {
  statements.updateMetadata.run(
    meta.series,
    meta.seriesIndex,
    JSON.stringify(meta.subjects),
    meta.author,
    id,
  );
}

// --- Convert: linked source/converted books (brief 34, D34) ------------------

/**
 * The **converted book** made from `sourceBookId`, or undefined when none
 * exists. The reverse of `getBook(row.converted_from)`.
 *
 * `DELETE /library/:id` must call this BEFORE deleting a source: the row
 * cascades away inside SQLite, but its file on disk does not, and afterwards
 * there is nothing left to say the file was ever there.
 */
export function getConvertedBook(sourceBookId: string): BookRow | undefined {
  return statements.getConvertedBook.get(sourceBookId) as BookRow | undefined;
}

/**
 * The other half of a converted pair, from either side: given a source book its
 * converted book, given a converted book its source. Undefined when the row
 * stands alone.
 *
 * One call because `GET /library/:id` has to offer the format switch from
 * whichever row the reader happens to have open, and which side that is isn't
 * knowable before the lookup.
 */
export function getLinkedBook(row: BookRow): BookRow | undefined {
  if (row.converted_from !== null) return getBook(row.converted_from);
  return row.converted_to !== null ? getBook(row.converted_to) : undefined;
}

/**
 * Insert the **converted book** for `sourceBookId` and return the stored row.
 *
 * Title, author, series and subjects are copied from the source so the pair
 * reads as one book, and `kind` is derived from the target format like any
 * upload. The source's cover is **reused, not re-extracted** — brief 34 keeps
 * `extract.ts` out of this path entirely.
 *
 * That sharing is no longer recorded by copying a path: `coverPathFor` in
 * `paths.ts` derives it from `converted_from ?? id`, so the conversion resolves
 * to the source's thumbnail without this row storing anything. See that
 * function for what the shared file means for the delete paths.
 *
 * Throws if the source id is unknown, or (via `books_converted_from`) if that
 * source already has a conversion — the caller is supposed to have handled the
 * "already exists" case, so a second insert is a bug worth hearing about.
 */
export function insertConvertedBook(args: {
  /**
   * Pre-generated: the caller needs it to name the output file before
   * converting. It is also the whole of what this function needs to know about
   * where that file went — `filePathFor(id, format)` is the path, so there is
   * no path argument to pass and nothing to keep in sync.
   */
  id: string;
  sourceBookId: string;
  /** The target format — `convertTargetForFormat(source.format)`. */
  format: FileType;
  sizeBytes: number;
  /** ISO timestamp for `created_at`. */
  now: string;
}): BookRow {
  const source = getBook(args.sourceBookId);
  if (!source) throw new Error(`Cannot convert unknown book ${args.sourceBookId}`);

  statements.insertConverted.run({
    id: args.id,
    title: source.title,
    author: source.author,
    format: args.format,
    size_bytes: args.sizeBytes,
    progress: 0,
    created_at: args.now,
    last_opened_at: null,
    series: source.series,
    series_index: source.series_index,
    // Never null, so the metadata backfill can't mistake a fresh conversion for
    // a pre-column row and re-scan it (see `listNeedingMetadata`).
    subjects: source.subjects ?? "[]",
    // Provenance is where the *book* came from, which a conversion doesn't
    // change; `converted_from` is what records that this row was derived.
    source: source.source,
    source_id: source.source_id,
    kind: kindForFormat(args.format),
    duration_seconds: null,
    converted_from: args.sourceBookId,
  });

  return getBook(args.id) as BookRow;
}

/**
 * Start the clock on a conversion: `running`, no error, started now. Set on the
 * **source book** — the status describes the conversion, and the converted book
 * may not exist yet.
 */
export function markConvertRunning(id: string, now: string): void {
  statements.markConvertRunning.run(now, id);
}

/**
 * Record the outcome of a conversion — `ready`, `poor` (produced but probably
 * unusable, a scanned PDF; it still opens and the UI only warns) or `failed`
 * with a reason the reader can act on.
 *
 * `convert_started_at` is left alone: the run it timed did happen, and the next
 * `markConvertRunning` overwrites it.
 */
export function setConvertStatus(
  id: string,
  status: ConvertStatus,
  error: string | null = null,
): void {
  statements.setConvertStatus.run(status, error, id);
}

/**
 * Return a source book to "never converted" — used when a finished conversion
 * is deleted or a running one is cancelled, so the button offers Convert again
 * rather than a switch to a row that is gone.
 */
export function resetConvert(id: string): void {
  statements.resetConvert.run(id);
}

/**
 * The conversion currently in flight, or undefined. Backs the single-flight
 * guard (D34 decision 6: one at a time, a refusal rather than a queue) and the
 * 409 the route returns — the returned row is the book to name in the message.
 *
 * Store-wide, not per account, because the library is shared across accounts by
 * design (there is no per-book ownership), so "one per account" and "one at a
 * time" are the same query here.
 *
 * This is the durable half of the guard: `convert_jobs`'s in-process map knows
 * about children this process spawned, the DB knows about the row.
 */
export function getRunningConvert(): BookRow | undefined {
  return statements.getRunningConvert.get() as BookRow | undefined;
}

// --- Users & sessions --------------------------------------------------------

export function getUserByName(username: string): UserRow | undefined {
  return statements.getUserByName.get(username) as UserRow | undefined;
}

/**
 * Insert a user, or update the password of an existing one (matched by
 * username). Used by the operator seed script; re-running it is idempotent.
 */
export function upsertUser(row: UserRow): void {
  statements.upsertUser.run(row);
}

/**
 * Open a session. `activeProfileId` is the profile login resolved as active
 * (the account's default) — it defaults to null, in which case the guard falls
 * back to the default on the first request rather than 401-ing.
 */
export function createSession(
  token: string,
  userId: string,
  now: string,
  activeProfileId: string | null = null,
): void {
  statements.createSession.run(token, userId, now, activeProfileId);
}

/**
 * Resolve a session token to its identity — the account plus the session's
 * active profile id — or undefined if the token is unknown.
 */
export function getSessionUser(token: string): SessionUser | undefined {
  return statements.sessionUser.get(token) as SessionUser | undefined;
}

/**
 * Point a session at a different profile (`POST /profiles/:id/activate`).
 * Switching is free by design (D35), so this is the whole of a switch on the
 * server: no new token, no re-auth, and other tabs on the same token follow.
 */
export function setSessionActiveProfile(token: string, profileId: string | null): void {
  statements.setSessionActiveProfile.run(profileId, token);
}

export function deleteSession(token: string): void {
  statements.deleteSession.run(token);
}

// --- Profiles (brief 35) -----------------------------------------------------

/** An account's profiles, default first then oldest first. */
export function listProfiles(userId: string): ProfileRow[] {
  return statements.listProfiles.all(userId) as ProfileRow[];
}

/**
 * One profile by id, or undefined. The id is client-supplied at every route
 * that takes one, so callers MUST compare `row.user_id` against the caller's
 * account before acting on it — profiles are not a security boundary, but
 * *accounts* are, and an unchecked id here is a cross-account read.
 */
export function getProfile(id: string): ProfileRow | undefined {
  return statements.getProfile.get(id) as ProfileRow | undefined;
}

/**
 * The account's fallback profile. Every account has one (`ensureDefaultProfiles`
 * runs at startup), so a caller resolving a null or dangling
 * `activeProfileId` can rely on this rather than failing the request.
 */
export function getDefaultProfile(userId: string): ProfileRow | undefined {
  return statements.getDefaultProfile.get(userId) as ProfileRow | undefined;
}

/** How many profiles an account holds, for the `MAX_PROFILES_PER_ACCOUNT` check. */
export function countProfiles(userId: string): number {
  return (statements.countProfiles.get(userId) as { n: number }).n;
}

/**
 * Insert a profile. Throws `SQLITE_CONSTRAINT_UNIQUE` on a duplicate name
 * within the account (`profiles_user_name`) — the route turns that into a 409,
 * since a uniqueness check followed by an insert is a race.
 */
export function createProfile(row: ProfileRow): void {
  statements.insertProfile.run(row);
}

/**
 * Rename and/or recolour a profile (both optional; undefined leaves the column
 * unchanged). Returns whether a row changed, so an unknown id can 404.
 */
export function updateProfile(
  id: string,
  fields: { name?: string; color?: ProfileColor },
): boolean {
  return statements.updateProfile.run(fields.name ?? null, fields.color ?? null, id).changes > 0;
}

/**
 * Delete a profile; returns whether a row was removed. Its reading progress
 * cascades away, but its **notes do not** — `notes.profile_id` is
 * `ON DELETE RESTRICT` (brief 35 decision 3), so this throws
 * `SQLITE_CONSTRAINT_FOREIGNKEY` while the profile still owns any. Call
 * `reassignNotes` first; the constraint is there so that forgetting is a loud
 * error rather than silently destroyed authored work.
 */
export function deleteProfile(id: string): boolean {
  return statements.deleteProfile.run(id).changes > 0;
}

/**
 * A profile's raw preferences JSON, or null when it has never written any (and
 * undefined for an unknown id). Returned unparsed on purpose: the server never
 * interprets the blob, which is how a key it doesn't know about survives the
 * round trip (brief 35 step 8).
 */
export function getProfilePreferences(id: string): string | null | undefined {
  const row = statements.getProfilePreferences.get(id) as { preferences: string | null } | undefined;
  return row === undefined ? undefined : row.preferences;
}

/** Replace a profile's preferences blob wholesale. Returns whether a row changed. */
export function setProfilePreferences(id: string, json: string | null): boolean {
  return statements.setProfilePreferences.run(json, id).changes > 0;
}

// --- Per-profile reading progress --------------------------------------------

/** All of a profile's reading-progress rows (for merging into the library list). */
export function listProfileProgress(profileId: string): ProfileProgressRow[] {
  return statements.listProfileProgress.all(profileId) as ProfileProgressRow[];
}

/** One profile's progress for one book, or undefined if it hasn't opened it. */
export function getProfileProgress(
  profileId: string,
  bookId: string,
): ProfileProgressRow | undefined {
  return statements.getProfileProgress.get(profileId, bookId) as ProfileProgressRow | undefined;
}

/**
 * Save a profile's progress + resume position for a book. A null `locator`
 * leaves any previously-saved position intact (see the COALESCE in the
 * statement).
 *
 * `versionId` says which published **version** the locator was taken in (brief
 * 38 decision 10). It is optional and defaults to null so that every caller
 * predating brief 38 — and every ordinary book, which has no versions at all —
 * keeps working unchanged; null means "don't change what's recorded", not
 * "recorded against no version". A reader showing a published version must pass
 * it whenever it passes a `locator`, or the saved position outlives the version
 * it describes.
 */
export function upsertProfileProgress(
  profileId: string,
  bookId: string,
  progress: number,
  locator: string | null,
  now: string,
  versionId: string | null = null,
): void {
  statements.upsertProfileProgress.run(profileId, bookId, progress, locator, now, versionId);
}

// --- Notes (brief 26; profile-scoped since brief 35) -------------------------

const noteStatements = {
  listByProfile: db.prepare<[string]>(
    "SELECT * FROM notes WHERE profile_id = ? ORDER BY updated_at DESC",
  ),
  getByProfile: db.prepare<[string, string]>(
    "SELECT * FROM notes WHERE id = ? AND profile_id = ?",
  ),
  insert: db.prepare<NoteRow>(`
    INSERT INTO notes (id, profile_id, title, data, created_at, updated_at)
    VALUES (@id, @profile_id, @title, @data, @created_at, @updated_at)
  `),
  // Only the owning profile's row is touched; COALESCE lets a title-only or
  // data-only PATCH leave the other column intact.
  update: db.prepare<[string | null, string | null, string, string, string]>(`
    UPDATE notes
       SET title = COALESCE(?, title),
           data  = COALESCE(?, data),
           updated_at = ?
     WHERE id = ? AND profile_id = ?
  `),
  remove: db.prepare<[string, string]>("DELETE FROM notes WHERE id = ? AND profile_id = ?"),
  reassign: db.prepare<[string, string]>(
    "UPDATE notes SET profile_id = ? WHERE profile_id = ?",
  ),
};

/** All of a profile's notes, most-recently-updated first. */
export function listNotes(profileId: string): NoteRow[] {
  return noteStatements.listByProfile.all(profileId) as NoteRow[];
}

/** One note, only if it belongs to `profileId` (else undefined → the route 404s). */
export function getNote(profileId: string, id: string): NoteRow | undefined {
  return noteStatements.getByProfile.get(id, profileId) as NoteRow | undefined;
}

export function insertNote(row: NoteRow): void {
  noteStatements.insert.run(row);
}

/**
 * Update a note's title and/or page data (both optional; null leaves the column
 * unchanged). Returns whether a row was actually updated (false = not the
 * owner / unknown id), so the route can 404.
 */
export function updateNote(
  profileId: string,
  id: string,
  fields: { title?: string; data?: string },
  now: string,
): boolean {
  const info = noteStatements.update.run(
    fields.title ?? null,
    fields.data ?? null,
    now,
    id,
    profileId,
  );
  return info.changes > 0;
}

/** Delete a note if it belongs to `profileId`; returns whether a row was removed. */
export function deleteNote(profileId: string, id: string): boolean {
  return noteStatements.remove.run(id, profileId).changes > 0;
}

/**
 * Move every note from one profile to another, returning how many moved.
 * Brief 35 decision 3: deleting a profile that owns notes must be able to hand
 * them to the account's default instead of destroying authored work — progress
 * can be recreated by reading on, a notebook cannot. Callers must check both
 * profiles belong to the same account first; this does not.
 */
export function reassignNotes(fromProfileId: string, toProfileId: string): number {
  return noteStatements.reassign.run(toProfileId, fromProfileId).changes;
}

// --- LaTeX projects & published versions (brief 38) --------------------------
//
// In its own statement object, like `noteStatements` above: LaTeX is a
// destination of its own, not another view of the library.
//
// Every project lookup is scoped by `profile_id` in the SQL, never checked
// afterwards. That is brief 35's rule made unavoidable — a project belonging to
// another profile simply is not found, so the route answers 404 and never 403,
// and there is no way to write a handler that forgets the check.
const latexStatements = {
  listByProfile: db.prepare<[string]>(
    "SELECT * FROM latex_projects WHERE profile_id = ? ORDER BY updated_at DESC",
  ),
  getByProfile: db.prepare<[string, string]>(
    "SELECT * FROM latex_projects WHERE id = ? AND profile_id = ?",
  ),
  insert: db.prepare<LatexProjectRow>(`
    INSERT INTO latex_projects (id, profile_id, title, entrypoint, compile_status,
                                published_book_id, created_at, updated_at)
    VALUES (@id, @profile_id, @title, @entrypoint, @compile_status,
            @published_book_id, @created_at, @updated_at)
  `),
  // COALESCE lets a title-only or entrypoint-only PATCH leave the other intact,
  // the same shape as `notes.update` and `updateProfile`.
  update: db.prepare<[string | null, string | null, string, string, string]>(`
    UPDATE latex_projects
       SET title = COALESCE(?, title),
           entrypoint = COALESCE(?, entrypoint),
           updated_at = ?
     WHERE id = ? AND profile_id = ?
  `),
  touch: db.prepare<[string, string]>(
    "UPDATE latex_projects SET updated_at = ? WHERE id = ?",
  ),
  setCompileStatus: db.prepare<[string, string]>(
    "UPDATE latex_projects SET compile_status = ? WHERE id = ?",
  ),
  // The WHERE clause is the guard `setLatexPublishedBook` documents, moved into
  // the SQL so it cannot be raced past: attaching is allowed only when the
  // column is still NULL or already names the SAME book. Detaching (a NULL
  // third/fourth parameter) is always allowed — that is the FK's
  // ON DELETE SET NULL path, not an overwrite.
  setPublishedBook: db.prepare<[string | null, string, string | null, string | null]>(`
    UPDATE latex_projects
       SET published_book_id = ?
     WHERE id = ?
       AND (published_book_id IS NULL OR published_book_id = ? OR ? IS NULL)
  `),
  remove: db.prepare<[string, string]>(
    "DELETE FROM latex_projects WHERE id = ? AND profile_id = ?",
  ),
  // Account-wide, joined through `profiles`, because the single-flight rule is
  // "one at a time per account" (brief 38 step 3) and a profile is not a
  // security or a resource boundary (D35) — one person switching profiles must
  // not be able to start a second compile. Oldest first so a refusal can name
  // the compile that has been running longest, like `getRunningConvert`.
  getRunning: db.prepare<[string]>(`
    SELECT lp.* FROM latex_projects lp
      JOIN profiles p ON p.id = lp.profile_id
     WHERE p.user_id = ? AND lp.compile_status = 'running'
     ORDER BY lp.updated_at ASC LIMIT 1
  `),

  listVersions: db.prepare<[string]>(
    "SELECT * FROM document_versions WHERE book_id = ? ORDER BY version_no DESC",
  ),
  getVersion: db.prepare<[string]>("SELECT * FROM document_versions WHERE id = ?"),
  getLatestVersion: db.prepare<[string]>(
    "SELECT * FROM document_versions WHERE book_id = ? ORDER BY version_no DESC LIMIT 1",
  ),
  countVersions: db.prepare<[string]>(
    "SELECT COUNT(*) AS n FROM document_versions WHERE book_id = ?",
  ),
  // The version number is allocated by the INSERT itself rather than read out,
  // incremented and written back. A read-then-write would let two publishes
  // seconds apart both compute v4; here the losing one violates
  // `document_versions_book_no` and throws, which the caller can retry. NOT a
  // COUNT(*)+1: deleting v2 must not make the next publish v4 a second time.
  insertVersion: db.prepare<[string, string, string, string]>(`
    INSERT INTO document_versions (id, book_id, version_no, published_at)
    SELECT ?, ?, COALESCE(MAX(version_no), 0) + 1, ?
      FROM document_versions WHERE book_id = ?
  `),
  removeVersion: db.prepare<[string]>("DELETE FROM document_versions WHERE id = ?"),
};

/** A profile's LaTeX projects, most-recently-updated first (uses the index). */
export function listLatexProjects(profileId: string): LatexProjectRow[] {
  return latexStatements.listByProfile.all(profileId) as LatexProjectRow[];
}

/**
 * One project, only if it belongs to `profileId` (else undefined → the route
 * 404s). Every route that takes a project id from the URL must come through
 * here before deriving a path from that id.
 */
export function getLatexProject(profileId: string, id: string): LatexProjectRow | undefined {
  return latexStatements.getByProfile.get(id, profileId) as LatexProjectRow | undefined;
}

export function insertLatexProject(row: LatexProjectRow): void {
  latexStatements.insert.run(row);
}

/**
 * Rename a project and/or repoint its entrypoint (both optional; undefined
 * leaves the column unchanged) and stamp `updated_at`. Returns whether a row
 * changed, so a project the profile doesn't own 404s.
 *
 * The entrypoint is a client-supplied project-relative path: the caller MUST
 * have confined it to the project directory before calling. This function
 * stores a string; it cannot tell a filename from a traversal.
 */
export function updateLatexProject(
  profileId: string,
  id: string,
  fields: { title?: string; entrypoint?: string },
  now: string,
): boolean {
  return (
    latexStatements.update.run(
      fields.title ?? null,
      fields.entrypoint ?? null,
      now,
      id,
      profileId,
    ).changes > 0
  );
}

/**
 * Stamp `updated_at` — what a file write inside the project calls, since the
 * files are on disk and nothing else would move the row the project list is
 * ordered by. Unscoped by profile on purpose: the caller has already resolved
 * the project through `getLatexProject`.
 */
export function touchLatexProject(id: string, now: string): void {
  latexStatements.touch.run(now, id);
}

/**
 * Record where a project sits in the compile machine. This column is the
 * DURABLE half of the single-flight guard — an in-process job map knows about
 * work this process started, the row is what survives a restart — so it must be
 * moved off `running` on every exit path, including cancellation and failure.
 * `reapInterruptedLatexCompiles` is the backstop for the one exit path code
 * cannot cover, a crash.
 */
export function setLatexCompileStatus(id: string, status: CompileStatus): void {
  latexStatements.setCompileStatus.run(status, id);
}

/**
 * Attach a project to the ONE library entry it publishes into, or (with null)
 * detach it.
 *
 * Called once, on the first publish. Every later publish appends a version to
 * the book already named here — that is the whole of "publish ten times, one
 * card".
 *
 * **Overwriting a non-null value with a DIFFERENT book id is refused, not
 * performed**, and the refusal is the return value. This used to be a rule
 * stated in prose ("callers must not…"), and prose lost: two publishes of one
 * project that overlap across an `await` can each read `published_book_id` as
 * NULL, each insert a book, and the second call would silently repoint the
 * column — leaving the first book with its versions, its library file and its
 * cover and nothing pointing at them. That is two gallery cards for one
 * project, which is exactly what decision 8 forbids. The guard lives in the
 * WHERE clause above so the check and the write are one statement and there is
 * no window between them; `false` means "somebody else got there first", which
 * the publish route turns into a retryable 409 rather than a 500.
 *
 * Detaching (`bookId === null`) is always allowed: that is the FK's
 * ON DELETE SET NULL path, which un-publishes a project whose entry was
 * deleted, not an overwrite.
 *
 * Returns false only for a refusal or a missing row — both cases in which the
 * caller must NOT assume the column now names its book.
 */
export function setLatexPublishedBook(id: string, bookId: string | null): boolean {
  return latexStatements.setPublishedBook.run(bookId, id, bookId, bookId).changes > 0;
}

/**
 * Delete a project if it belongs to `profileId`; returns whether a row was
 * removed. Its published entry is deliberately untouched (decision 11) — the
 * `published_book_id` reference points at `books`, not the other way, so there
 * is nothing here that could reach it. The project's working tree on disk is
 * the caller's to remove: SQLite deletes rows, never files.
 */
export function deleteLatexProject(profileId: string, id: string): boolean {
  return latexStatements.remove.run(id, profileId).changes > 0;
}

/**
 * The compile currently in flight on `userId`'s account, or undefined. Backs the
 * single-flight refusal (one at a time per account, a 409 rather than a queue)
 * and returns the project so the message can name it.
 *
 * Per account rather than per profile: switching profiles is free (D35), so a
 * per-profile limit would be no limit at all.
 */
export function getRunningLatexCompile(userId: string): LatexProjectRow | undefined {
  return latexStatements.getRunning.get(userId) as LatexProjectRow | undefined;
}

/** A published document's versions, newest first — the version picker's list. */
export function listDocumentVersions(bookId: string): DocumentVersionRow[] {
  return latexStatements.listVersions.all(bookId) as DocumentVersionRow[];
}

/**
 * One version by id, or undefined. The id arrives as `?version=` on the file
 * route, so callers MUST check `row.book_id` against the book they were asked
 * for — otherwise one book's URL streams another's bytes.
 */
export function getDocumentVersion(id: string): DocumentVersionRow | undefined {
  return latexStatements.getVersion.get(id) as DocumentVersionRow | undefined;
}

/**
 * The newest version of a book, or undefined for a book that was never
 * published from a project. What a card opens by default (decision 9).
 */
export function getLatestDocumentVersion(bookId: string): DocumentVersionRow | undefined {
  return latexStatements.getLatestVersion.get(bookId) as DocumentVersionRow | undefined;
}

/**
 * How many versions a book has: 0 for an ordinary upload, which is how the
 * reader knows to show no picker at all; 1 also shows none (decision 7 of the
 * reader chrome — a picker with one entry is noise); and it is what tells a
 * version delete that it is removing the last one, which deletes the entry too.
 */
export function countDocumentVersions(bookId: string): number {
  return (latexStatements.countVersions.get(bookId) as { n: number }).n;
}

/**
 * Append a version to `bookId` and return the stored row.
 *
 * `versionNo` is allocated inside the INSERT (`MAX + 1`), so the caller never
 * computes it — see the statement for why that matters. Throws
 * `SQLITE_CONSTRAINT_UNIQUE` if two publishes race for the same number, and
 * `SQLITE_CONSTRAINT_FOREIGNKEY` if `bookId` is unknown.
 *
 * `id` is generated here because it is the whole of what this row says about
 * where the artifacts went: `versionPdfPathFor(id)` and `versionZipPathFor(id)`
 * in `paths.ts` derive both, and no path is stored (D39). The caller therefore
 * needs the id back before it can write the bytes — insert first, then write.
 */
export function appendDocumentVersion(bookId: string, now: string): DocumentVersionRow {
  const id = randomUUID();
  latexStatements.insertVersion.run(id, bookId, now, bookId);
  return latexStatements.getVersion.get(id) as DocumentVersionRow;
}

/**
 * Delete one version; returns whether a row was removed. Its PDF and project zip
 * are the caller's to unlink — derive them from the id BEFORE calling, because
 * afterwards nothing is left pointing at them.
 *
 * Any `reading_progress` row resuming inside this version has its `version_id`
 * cleared by the FK, not its progress destroyed; the next open sees a mismatch
 * and starts at page 0, which is decision 10 with no special case.
 */
export function deleteDocumentVersion(id: string): boolean {
  return latexStatements.removeVersion.run(id).changes > 0;
}
