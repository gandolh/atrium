import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  BookSource,
  ConvertStatus,
  FileType,
  LibraryBook,
  LibrarySort,
  MediaKind,
  ProfileColor,
} from "@ebook-reader/shared";
import { kindForFormat } from "@ebook-reader/shared";
import { DATA_DIR, DB_PATH } from "./config.js";

/**
 * SQLite-backed library store (decisions.md D24). Synchronous
 * `better-sqlite3` — simplest for a single-user local API; no connection pool,
 * no async ceremony. One `books` table; image/file bytes live on disk (D25),
 * this table stores only paths + metadata.
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
  file_path: string;
  cover_path: string | null;
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
}

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id            TEXT    PRIMARY KEY,
    title         TEXT    NOT NULL,
    author        TEXT,
    format        TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,
    cover_path    TEXT,
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

ensureSessionColumns();
migrateToProfileScope();
ensureDefaultProfiles();
ensureConvertIndex();
reapInterruptedConversions();

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
    INSERT INTO books (id, title, author, format, file_path, cover_path,
                       size_bytes, progress, created_at, last_opened_at,
                       series, series_index, subjects, source, source_id,
                       kind, duration_seconds)
    VALUES (@id, @title, @author, @format, @file_path, @cover_path,
            @size_bytes, @progress, @created_at, @last_opened_at,
            @series, @series_index, @subjects, @source, @source_id,
            @kind, @duration_seconds)
  `),
  // No `NOT_CONVERTED` here on purpose: a converted book is opened by id every
  // time the reader switches format.
  getById: db.prepare<[string]>(`SELECT ${BOOK_COLUMNS} FROM books b WHERE b.id = ?`),
  listRecent: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE ${NOT_CONVERTED}
      ORDER BY COALESCE(b.last_opened_at, b.created_at) DESC`,
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
  // Rows that claim a cover, for the startup reconcile that nulls the path when
  // the thumbnail file is actually gone (stale absolute paths from another box).
  // Also unfiltered: a converted book SHARES its source's thumbnail path, so if
  // that file disappears both rows are stale and both must be corrected.
  listWithCover: db.prepare(
    `SELECT ${BOOK_COLUMNS} FROM books b WHERE b.cover_path IS NOT NULL`,
  ),
  clearCoverPath: db.prepare<[string]>("UPDATE books SET cover_path = NULL WHERE id = ?"),
  // COALESCE on author lets a re-scan fill a previously-null author (PDFs) but
  // never clobber one already stored. `subjects` is set to a JSON array (never
  // null) so the row drops out of `listNeedingMetadata` and can't loop.
  updateMetadata: db.prepare<[string | null, number | null, string, string | null, string]>(`
    UPDATE books
       SET series = ?, series_index = ?, subjects = ?,
           author = COALESCE(author, ?)
     WHERE id = ?
  `),

  // --- Convert (brief 34, D34) ----------------------------------------------
  insertConverted: db.prepare<NewBookRow & { converted_from: string }>(`
    INSERT INTO books (id, title, author, format, file_path, cover_path,
                       size_bytes, progress, created_at, last_opened_at,
                       series, series_index, subjects, source, source_id,
                       kind, duration_seconds, converted_from)
    VALUES (@id, @title, @author, @format, @file_path, @cover_path,
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
    "SELECT book_id, progress, locator, updated_at FROM reading_progress WHERE profile_id = ?",
  ),
  getProfileProgress: db.prepare<[string, string]>(
    "SELECT book_id, progress, locator, updated_at FROM reading_progress WHERE profile_id = ? AND book_id = ?",
  ),
  // COALESCE keeps a previously-saved locator when a progress-only update sends
  // null, so a bar refresh can't wipe the resume position.
  upsertProfileProgress: db.prepare<[string, string, number, string | null, string]>(`
    INSERT INTO reading_progress (profile_id, book_id, progress, locator, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, book_id) DO UPDATE SET
      progress = excluded.progress,
      locator = COALESCE(excluded.locator, reading_progress.locator),
      updated_at = excluded.updated_at
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
    hasCover: row.cover_path !== null,
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

/** Books whose row records a cover path, for the startup cover reconcile. */
export function listBooksWithCover(): BookRow[] {
  return statements.listWithCover.all() as BookRow[];
}

/**
 * Drop a book's `cover_path` (→ NULL) when its thumbnail file has gone missing,
 * so `hasCover` reports false on the wire and the client stops requesting a
 * cover that will only 404 (see `reconcileMissingCovers`).
 */
export function clearBookCover(id: string): void {
  statements.clearCoverPath.run(id);
}

/**
 * Persist re-scanned series/subject metadata for one book (backfill or a future
 * re-index). `subjects` is a `string[]` stored as JSON; `author` fills a
 * previously-null author without overwriting an existing one (COALESCE).
 */
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
 * That means both rows hold the SAME `cover_path`, one file with two rows
 * pointing at it. Deleting only the conversion must therefore delete the
 * converted FILE and leave the thumbnail alone, or the source loses its cover
 * to a delete that had nothing to do with it.
 *
 * Throws if the source id is unknown, or (via `books_converted_from`) if that
 * source already has a conversion — the caller is supposed to have handled the
 * "already exists" case, so a second insert is a bug worth hearing about.
 */
export function insertConvertedBook(args: {
  /** Pre-generated: the caller needs it to name the output file before converting. */
  id: string;
  sourceBookId: string;
  /** The target format — `convertTargetForFormat(source.format)`. */
  format: FileType;
  filePath: string;
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
    file_path: args.filePath,
    cover_path: source.cover_path,
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
 */
export function upsertProfileProgress(
  profileId: string,
  bookId: string,
  progress: number,
  locator: string | null,
  now: string,
): void {
  statements.upsertProfileProgress.run(profileId, bookId, progress, locator, now);
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
