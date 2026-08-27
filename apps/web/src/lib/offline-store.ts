import type { FileType, LibraryBook } from "@ebook-reader/shared";

/**
 * Offline store (brief 20) — the data layer that makes an explicitly downloaded
 * book readable with zero connectivity.
 *
 * Design decisions locked by the brief (do not relitigate):
 * - Explicit per-book download, keyed by book id. We persist the original file
 *   BLOB, a snapshot of its `LibraryBook` metadata row, and a small local
 *   reading-progress record. No auto-caching (PDFs are large).
 * - Last-write-wins progress sync with a single PATCH on reconnect — no queue of
 *   intermediate positions.
 * - Storage lives in IndexedDB accessed from app code at the hydrate seam; the
 *   service worker (brief 19) is NOT involved in serving book bytes.
 *
 * Profiles (brief 35, decision 7) draw the line through this store: the blob and
 * the shared metadata are DEVICE-scoped (one download serves every profile on
 * the device), while the reading position is PROFILE-scoped. So progress rows
 * are keyed per (profile, book), and the `LibraryBook` snapshot is stored with
 * its two profile-owned fields (`progress`, `locator`) neutralised — see
 * `neutralizeSnapshot`.
 *
 * This module is intentionally free of React and of the network layer: it is a
 * typed IndexedDB wrapper only. The download itself (streaming bytes via
 * `fetchBookFile`) and the reconnect PATCH are driven by the hooks that own the
 * network (`use-library.ts`, `use-progress-sync.ts`), which inject those calls.
 * The active profile id is likewise passed IN by those hooks rather than read
 * from the auth store here, so this stays a plain, dependency-free module.
 *
 * We hand-roll a minimal promisified wrapper rather than pull in `idb`: the
 * surface we need is tiny and adding a runtime dependency isn't warranted.
 */

const DB_NAME = "ebook-reader:offline";
// v2: the file blob moved out of BOOKS_STORE into its own FILES_STORE so that
// metadata-only operations (list, snapshot refresh) never touch the (large)
// blobs. v1 databases are migrated in `onupgradeneeded` (blobs relocated, then
// stripped from the metadata record) — existing downloads survive the bump.
// v3 (brief 35): PROGRESS_STORE records gained `profileId` so a pending write
// remembers who recorded it — otherwise a flush after a profile switch would
// silently re-attribute one person's reading to another.
// v4 (brief 35 fix): `profileId` as a FIELD wasn't enough. The store was keyed
// on the book id alone, so two profiles shared one row: whoever wrote last
// overwrote — and destroyed — the other's un-synced position, and whoever read
// got someone else's page. Progress moved to PROFILE_PROGRESS_STORE, keyed by
// (profile, book), with an index on the book id so removing a download still
// clears every profile's row. v1/v2/v3 rows are copied across in
// `onupgradeneeded` (see the migration block below).
// v5: the persisted progress field `fraction` was renamed to `progress`. It is
// the same 0..1 quantity the wire `LibraryBook.progress` carries and the
// glossary names `progress`; two names for one number meant every read and
// write across this seam had to translate, and a translation you can forget is
// a bug waiting to happen. v4 rows are rewritten in place in `onupgradeneeded`
// (see the v4 → v5 block below) — no record is dropped, only re-keyed.
const DB_VERSION = 5;
/** Object store: `LibraryBook` snapshot + reconstruction metadata, keyed by id.
 *  Metadata ONLY — the file bytes live in FILES_STORE (see below) so listing /
 *  refreshing snapshots never deserializes a 40 MB PDF. */
const BOOKS_STORE = "books";
/** Object store: the downloaded file blob, keyed by id (`{id, blob}`). Split
 *  from BOOKS_STORE so a metadata rewrite (snapshot refresh) doesn't re-serialize
 *  the blob, and listing never loads blobs into memory. */
const FILES_STORE = "files";
/**
 * Pre-v4 object store: per-BOOK local reading progress, keyed by book id.
 * Superseded by PROFILE_PROGRESS_STORE. Referenced ONLY inside
 * `onupgradeneeded`, as the source of the v→v4 copy; no runtime path opens it,
 * and it is never created on a fresh v4 install. It is deliberately left in
 * place on upgraded databases (dropping a store while a cursor is reading it is
 * exactly how a migration loses records); a later version bump can delete it
 * once every install has been through v4.
 */
const LEGACY_PROGRESS_STORE = "progress";
/**
 * Object store (v4): per-(profile, book) local reading progress, keyed by the
 * composite `key` (see `progressKey`). Kept separate from BOOKS_STORE so a
 * debounced progress write doesn't rewrite the (large) file blob on every page
 * turn, and separate PER PROFILE so two readers on one device can never
 * overwrite or read each other's position.
 */
const PROFILE_PROGRESS_STORE = "profile-progress";
/**
 * Index on PROFILE_PROGRESS_STORE mapping book id → every profile's row for that
 * book. Load-bearing for `deleteOfflineBook`: removing a download must clear the
 * progress of EVERY profile, and the primary key no longer starts with the book
 * id, so there is no key range that finds them.
 */
const PROGRESS_BOOK_INDEX = "id";

/**
 * Separator in the composite progress key. Both halves are `randomUUID()`
 * values server-side (hex + `-` only), so `:` cannot occur inside either and the
 * key can never be ambiguous.
 */
const PROGRESS_KEY_SEP = ":";
/**
 * Stand-in for the profile half of the key when a record has no profile
 * (`profileId: null` — a row written before profiles existed, or before the
 * active profile was known). `~` cannot appear in a UUID either, so this can
 * never collide with a real profile id. Semantics: "unknown — belongs to
 * whoever is active", which is what `getLocalProgress` falls back to and what
 * the reconnect flush attributes to the current profile.
 */
const DEVICE_PROFILE_KEY = "~device";

/** Composite primary key for a progress row: profile (or the device stand-in) + book. */
function progressKey(bookId: string, profileId: string | null): string {
  return `${profileId ?? DEVICE_PROFILE_KEY}${PROGRESS_KEY_SEP}${bookId}`;
}

/**
 * Local reading-progress record — the client-side mirror of the server's
 * per-profile progress (D31, moved from user to profile scope by brief 35).
 * `{progress, locator, updatedAt, profileId}` is the public shape (brief item
 * 1/5, extended by brief 35 step 7, `fraction` renamed to `progress` at v5);
 * `updatedAt` is a local `Date.now()` ms
 * epoch stamped when the reading position last changed on THIS device.
 */
export interface LocalProgress {
  /** Coarse progress 0..1 (drives the cover bar), same units and NAME as `LibraryBook.progress`. */
  progress: number;
  /** Exact resume position: page number (as string) for PDF, CFI for EPUB; null = start. */
  locator: string | null;
  /** Local ms epoch of the last position change (last-write-wins clock, this device). */
  updatedAt: number;
  /**
   * The profile active on THIS device when the write happened (brief 35 step
   * 7) — what lets a reconnect flush attribute the PATCH to the person who
   * actually read, instead of whoever happens to be active when the network
   * comes back. Since v4 it is also half of the record's KEY, so two profiles
   * hold two rows rather than fighting over one.
   *
   * `null` means "unknown, attribute to whoever is active": it's what a v1/v2
   * record (written before profiles existed) migrates as, and it's also what a
   * fresh write uses if `useProgressSync` ever fires before the active profile
   * is known. Both cases preserve today's behaviour exactly for the
   * single-profile case — which is every existing install, since profiles ship
   * in this same brief — rather than guessing at an attribution we don't have.
   */
  profileId: string | null;
}

/**
 * Stored progress row. `syncedAt` is internal bookkeeping: the `updatedAt` value
 * we last confirmed on the server via a successful PATCH (0 = never synced).
 *
 * The frozen API contract exposes NO per-user progress timestamp on the wire
 * `LibraryBook` (the server stores `reading_progress.updated_at` but never
 * returns it). So "the local record is newer than the server's" (brief item 5)
 * can't compare timestamps directly; instead a record is treated as pending
 * (needs pushing) while `updatedAt > syncedAt`, and the reconnect flush pushes
 * it once unless the freshly-fetched row already carries the same value.
 */
interface StoredProgress extends LocalProgress {
  /** Primary key: `progressKey(id, profileId)` (v4). */
  key: string;
  /** Book id — indexed (`PROGRESS_BOOK_INDEX`) so one book's rows can be swept. */
  id: string;
  syncedAt: number;
}

/**
 * A downloaded book: the file bytes plus enough to reconstruct the exact `File`
 * the readers consume, plus the metadata snapshot the offline library renders.
 */
export interface OfflineBookRecord {
  id: string;
  /** Original file bytes. */
  blob: Blob;
  /** Reconstructs `File.name` (readers key some behavior off the extension). */
  fileName: string;
  /** Reconstructs `File.type` (application/pdf | application/epub+zip). */
  mime: string;
  // Widened Format → FileType (brief 23) so `book.format` (now the full
  // pdf/epub/mp3/mp4/webm enum) assigns here without a cast and web compiles.
  // Type-only: media is books-only-excluded from offline v1, so in practice a
  // stored record's format is always pdf/epub — no blob/store logic changes.
  format: FileType;
  /**
   * Snapshot of the `LibraryBook` row at download time, refreshed
   * opportunistically. Device-scoped (decision 7) and therefore served to EVERY
   * profile, so its two profile-owned fields are neutralised on the way in and
   * on the way out (`neutralizeSnapshot`): `progress` is always 0 and `locator`
   * always null here. The active profile's real position is composed from
   * PROFILE_PROGRESS_STORE by `listOfflineBooks`.
   */
  book: LibraryBook;
  /** Ms epoch the book was first downloaded (stable; drives "downloaded on" if shown). */
  savedAt: number;
  /** Ms epoch the `book` snapshot was last written (download or refresh). */
  snapshotAt: number;
}

/** Metadata view of a downloaded book — everything except the heavy `blob`, for listing. */
export type OfflineBookSummary = Omit<OfflineBookRecord, "blob">;

/**
 * What actually lives in BOOKS_STORE (v2): the summary, blob-free. The blob is
 * stored alongside in FILES_STORE under the same key. `OfflineBookRecord` is the
 * reconstructed shape callers consume (summary + blob rejoined in `getOfflineBook`).
 */
type StoredBookMeta = OfflineBookSummary;
/** What lives in FILES_STORE: just the bytes, keyed by book id. */
interface StoredFile {
  id: string;
  blob: Blob;
}

/**
 * Strip the two PROFILE-owned fields off a `LibraryBook` before it is stored (or
 * handed out) as a device-scoped snapshot. Everything else on the row — title,
 * author, cover, format, size, kind, `lastOpenedAt` (a column on `books`, not on
 * `reading_progress`) — is shared library metadata and stays.
 *
 * Without this, `refreshOfflineSnapshots` writes whichever profile's library
 * list happened to load and `listOfflineBooks` then serves that person's
 * progress bar and resume position to everyone on the device. Applied on write
 * AND on read, so a snapshot stored by an older build can't leak either.
 */
function neutralizeSnapshot(book: LibraryBook): LibraryBook {
  return { ...book, progress: 0, locator: null };
}

/** Storage usage as reported by `navigator.storage.estimate()`, or null if unavailable. */
export interface StorageEstimate {
  /** Bytes used by this origin (all storage, not just our books — the platform total). */
  usage: number;
  /** Bytes the origin is allowed to use. */
  quota: number;
}

/** Whether IndexedDB is available (SSR / locked-down browsers may lack it). */
export function isOfflineSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

// --- Low-level IndexedDB plumbing -----------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!isOfflineSupported()) {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // The versionchange transaction, so the migration below can read/rewrite
      // existing records in the same upgrade step.
      const upgradeTx = req.transaction;
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PROFILE_PROGRESS_STORE)) {
        // Created synchronously here, so the copy below can write into it inside
        // this same versionchange transaction. It never exists before v4, so
        // this branch runs exactly once per database.
        const profileProgress = db.createObjectStore(PROFILE_PROGRESS_STORE, { keyPath: "key" });
        profileProgress.createIndex(PROGRESS_BOOK_INDEX, "id", { unique: false });
        // v1/v2/v3 → v4 migration (brief 35 fix): copy every row of the old
        // book-keyed store into the profile-keyed one, re-keyed by (profile,
        // book). A pre-v3 row has no `profileId` at all and a v3 row may carry
        // `null`; both map to the `~device` half of the key, meaning "unknown —
        // belongs to whoever is active", which is exactly how the reader and
        // the flush already treat `profileId: null`.
        //
        // Copy, never move: this is a cursor READ over the old store plus a put
        // into the new one, so nothing is deleted, cleared or dropped while the
        // cursor is iterating. The old store is left behind on purpose (see
        // LEGACY_PROGRESS_STORE) — if this upgrade were to fail mid-way the
        // transaction aborts and the ORIGINAL rows are still there, untouched.
        if (
          event.oldVersion >= 1 &&
          upgradeTx &&
          db.objectStoreNames.contains(LEGACY_PROGRESS_STORE)
        ) {
          const legacy = upgradeTx.objectStore(LEGACY_PROGRESS_STORE);
          const cursorReq = legacy.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            // A legacy row predates v5, so its 0..1 value is under the old
            // `fraction` name; it is written out under the current `progress`
            // name, which is why a v1/v2/v3 database can jump straight to v5
            // without also going through the rename cursor further down.
            const row = cursor.value as Partial<StoredProgress> & {
              id: string;
              fraction?: number;
            };
            const profileId = row.profileId ?? null;
            profileProgress.put({
              key: progressKey(row.id, profileId),
              id: row.id,
              profileId,
              progress: row.fraction ?? 0,
              locator: row.locator ?? null,
              updatedAt: row.updatedAt ?? 0,
              syncedAt: row.syncedAt ?? 0,
            } satisfies StoredProgress);
            cursor.continue();
          };
        }
      }
      // v4 → v5 migration: rename the persisted 0..1 field `fraction` to
      // `progress`, so the store agrees with the wire (`LibraryBook.progress`)
      // and the glossary instead of forcing a translation at every read and
      // write. Same value, same units, new name.
      //
      // Rewrite in place with a cursor: `cursor.update()` replaces the record
      // under its own key, so the primary key, the book-id index entry and
      // every other field (`locator`, `updatedAt`, `syncedAt`, `profileId`, and
      // anything a future version adds) ride along untouched via the spread.
      // Nothing is deleted, cleared or dropped while the cursor iterates — the
      // same discipline as the v→v4 copy above, and for the same reason: drop a
      // store out from under a live cursor and the migration loses records. If
      // this step throws, the versionchange transaction aborts and the database
      // stays at v4 with its rows intact.
      //
      // Guarded on `oldVersion >= 4`, which is also what keeps this from
      // colliding with the copy above: below v4 the store did not exist, so the
      // branch above creates and fills it with rows ALREADY carrying `progress`,
      // and this cursor is skipped. The two never run over the store at once.
      //
      // Idempotent by construction: a row that already has `progress` and no
      // `fraction` is left exactly as it is, so re-entering this step (or
      // meeting a row written by a v5 build) is a no-op rather than a rewrite.
      if (
        event.oldVersion >= 4 &&
        upgradeTx &&
        db.objectStoreNames.contains(PROFILE_PROGRESS_STORE)
      ) {
        const progressStore = upgradeTx.objectStore(PROFILE_PROGRESS_STORE);
        const cursorReq = progressStore.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const row = cursor.value as StoredProgress & { fraction?: number };
          if ("fraction" in row) {
            const { fraction: legacyFraction, ...rest } = row;
            cursor.update({
              ...rest,
              // `rest.progress` is normally absent on a v4 row; preferring it
              // when present means a half-migrated row (both names) keeps the
              // new value rather than being clobbered by the old one.
              progress: rest.progress ?? legacyFraction ?? 0,
            } satisfies StoredProgress);
          }
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        const files = db.createObjectStore(FILES_STORE, { keyPath: "id" });
        // v1 → v2 migration: v1 stored the blob INLINE in each BOOKS_STORE
        // record. Relocate every blob into the new FILES_STORE and strip it from
        // the metadata record, in-place via a cursor (no getAll — the blobs are
        // large). Runs only when upgrading from an existing v1 DB.
        if (event.oldVersion >= 1 && upgradeTx) {
          const books = upgradeTx.objectStore(BOOKS_STORE);
          const cursorReq = books.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const legacy = cursor.value as StoredBookMeta & { blob?: Blob };
            if (legacy.blob) {
              files.put({ id: legacy.id, blob: legacy.blob } satisfies StoredFile);
              const { blob: _blob, ...meta } = legacy;
              cursor.update(meta);
            }
            cursor.continue();
          };
        }
      }
      // Note: the v4 snapshot neutralisation is deliberately NOT done here. A
      // second cursor over BOOKS_STORE inside this same transaction would race
      // the v1→v2 blob relocation above (two cursors, same store, interleaved
      // `update()`s — the loser silently writes back a stale record). Snapshots
      // are neutralised on write (`putOfflineBook`, `refreshOfflineSnapshots`)
      // and again on read (`getOfflineBook`, `listOfflineBooks`) instead, which
      // covers rows stored by any earlier version without touching them here.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open offline DB"));
  });
  // If opening fails, don't cache the rejection forever — allow a later retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Run `fn` inside a transaction on `stores` and resolve when the tx completes. */
async function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (getStore: (name: string) => IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result: T;
    let settled = false;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline tx failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline tx aborted"));
    Promise.resolve(fn((name) => transaction.objectStore(name)))
      .then((value) => {
        result = value;
        settled = true;
      })
      .catch((err) => {
        if (!settled) transaction.abort();
        reject(err);
      });
  });
}

/** Promisify a single `IDBRequest`. */
function reqDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline request failed"));
  });
}

// --- Book blob + snapshot -------------------------------------------------

/**
 * Persist a downloaded book: its file bytes and a snapshot of its metadata row.
 * The `file` is the exact `File` produced by `fetchBookFile` (name + mime
 * preserved so the reader reconstructs it byte-for-byte). Overwrites any prior
 * download of the same id; leaves the local progress records untouched.
 */
export async function putOfflineBook(book: LibraryBook, file: File): Promise<void> {
  const now = Date.now();
  // Metadata and blob are written atomically across both stores in ONE
  // transaction: a book is either fully downloaded (meta + bytes) or not at all.
  await tx([BOOKS_STORE, FILES_STORE], "readwrite", async (getStore) => {
    const books = getStore(BOOKS_STORE);
    const files = getStore(FILES_STORE);
    const existing = (await reqDone(books.get(book.id))) as StoredBookMeta | undefined;
    const meta: StoredBookMeta = {
      id: book.id,
      fileName: file.name,
      mime: file.type,
      format: book.format,
      // Device-scoped snapshot: the downloader's own progress/locator must not
      // ride along into a record every profile reads (decision 7).
      book: neutralizeSnapshot(book),
      savedAt: existing?.savedAt ?? now,
      snapshotAt: now,
    };
    await reqDone(books.put(meta));
    await reqDone(files.put({ id: book.id, blob: file } satisfies StoredFile));
  });
}

/** Fetch a downloaded book (blob + snapshot), or null if not downloaded. */
export async function getOfflineBook(id: string): Promise<OfflineBookRecord | null> {
  if (!isOfflineSupported()) return null;
  try {
    // Rejoin metadata + blob (kept in separate stores since v2) into the
    // `OfflineBookRecord` the readers consume, reading both in one transaction.
    return await tx([BOOKS_STORE, FILES_STORE], "readonly", async (getStore) => {
      const meta = (await reqDone(getStore(BOOKS_STORE).get(id))) as StoredBookMeta | undefined;
      if (!meta) return null;
      const file = (await reqDone(getStore(FILES_STORE).get(id))) as StoredFile | undefined;
      if (!file) return null;
      // Neutralise on the way out too: a snapshot written by a pre-v4 build
      // still holds whichever profile last refreshed it (see neutralizeSnapshot).
      return { ...meta, book: neutralizeSnapshot(meta.book), blob: file.blob };
    });
  } catch {
    return null;
  }
}

/** Reconstruct the exact `File` the readers consume from a stored record. */
export function offlineRecordToFile(record: OfflineBookRecord): File {
  return new File([record.blob], record.fileName, { type: record.mime });
}

/** Whether a book is downloaded (cheap existence check; reads the metadata only). */
export async function hasOfflineBook(id: string): Promise<boolean> {
  if (!isOfflineSupported()) return false;
  try {
    return await tx(BOOKS_STORE, "readonly", async (getStore) => {
      const store = getStore(BOOKS_STORE);
      const key = await reqDone(store.getKey(id));
      return key !== undefined;
    });
  } catch {
    return false;
  }
}

/**
 * Delete every profile's progress row for one book, via the book-id index.
 * Issues the cursor synchronously so the caller can start it before its own
 * awaits (an IndexedDB transaction stays alive only while requests keep coming).
 */
function deleteAllProgressForBook(store: IDBObjectStore, id: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cursorReq = store.index(PROGRESS_BOOK_INDEX).openCursor(IDBKeyRange.only(id));
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

/**
 * Remove a downloaded book AND EVERY profile's local progress record for it,
 * freeing the storage. The blob is device-scoped, so removing it removes the
 * book for everyone on the device — leaving one profile's orphaned progress row
 * behind would resurrect a position for a book that no longer exists locally.
 * Idempotent: deleting an absent id is a no-op.
 */
export async function deleteOfflineBook(id: string): Promise<void> {
  await tx([BOOKS_STORE, FILES_STORE, PROFILE_PROGRESS_STORE], "readwrite", async (getStore) => {
    // All three requests are issued synchronously (the cursor first, so it is
    // in flight before we await anything).
    const progressDone = deleteAllProgressForBook(getStore(PROFILE_PROGRESS_STORE), id);
    const books = getStore(BOOKS_STORE).delete(id);
    const files = getStore(FILES_STORE).delete(id);
    await reqDone(books);
    await reqDone(files);
    await progressDone;
  });
}

/**
 * List downloaded books' metadata (no blobs), newest download first, with each
 * row's `progress`/`locator` composed from `profileId`'s OWN progress record.
 *
 * The stored snapshot carries no position at all (decision 7 makes the download
 * device-scoped, so its snapshot is shared by every profile) — the position
 * comes from PROFILE_PROGRESS_STORE, which is per (profile, book). That is what
 * stops the offline grid from showing one housemate's progress bar to another.
 */
export async function listOfflineBooks(profileId: string | null): Promise<OfflineBookSummary[]> {
  if (!isOfflineSupported()) return [];
  try {
    // BOOKS_STORE holds metadata only (since v2), so `getAll` never pulls a
    // single blob into memory — the whole reason for the store split. The
    // progress store is tiny (books × profiles, no payloads), so one `getAll`
    // there beats a per-book lookup.
    return await tx([BOOKS_STORE, PROFILE_PROGRESS_STORE], "readonly", async (getStore) => {
      const all = (await reqDone(getStore(BOOKS_STORE).getAll())) as StoredBookMeta[];
      const rows = (await reqDone(
        getStore(PROFILE_PROGRESS_STORE).getAll(),
      )) as StoredProgress[];
      const byKey = new Map(rows.map((r) => [r.key, r]));
      return all
        .slice()
        .sort((a, b) => b.savedAt - a.savedAt)
        .map((meta) => {
          // Same fallback as `getLocalProgress`: a row with no profile is a
          // pre-profiles position, shown to whoever is active.
          const own = byKey.get(progressKey(meta.id, profileId));
          const local = own ?? (profileId ? byKey.get(progressKey(meta.id, null)) : undefined);
          return {
            ...meta,
            book: {
              ...neutralizeSnapshot(meta.book),
              progress: local?.progress ?? 0,
              locator: local?.locator ?? null,
            },
          };
        });
    });
  } catch {
    return [];
  }
}

/**
 * Opportunistically refresh the stored `LibraryBook` snapshots from the live
 * library list (brief item 6 — title/progress/cover drift). Only updates rows
 * that are ALREADY downloaded; never creates a record (that would be a blobless
 * download).
 *
 * Two things happen, and the split is the point:
 * - The shared metadata (title/author/cover/…) is written into the snapshot,
 *   with `progress`/`locator` neutralised — the snapshot is device-scoped and
 *   read by every profile, so it must not carry anyone's position.
 * - The position that came down in those rows belongs to `profileId` (the
 *   profile the list was fetched as), so it is seeded into that profile's OWN
 *   progress record. This is what keeps cross-device resume working: a position
 *   set on another device arrives in the library list and lands here, scoped to
 *   the right person, instead of in a snapshot shared with everyone.
 *
 * A record with un-synced local changes (`pending`) is never overwritten by the
 * seed — an offline position this device holds always outranks a server row that
 * predates it (brief item 3).
 *
 * Operates over BOOKS_STORE (metadata only, since v2) with a cursor, so the
 * blobs are never read or rewritten.
 */
export async function refreshOfflineSnapshots(
  books: LibraryBook[],
  profileId: string | null,
): Promise<void> {
  if (!isOfflineSupported() || books.length === 0) return;
  const byId = new Map(books.map((b) => [b.id, b]));
  /** Ids that are downloaded AND present in the fetched list — the seed set. */
  const downloaded: string[] = [];
  try {
    await tx(BOOKS_STORE, "readwrite", async (getStore) => {
      const store = getStore(BOOKS_STORE);
      const now = Date.now();
      await new Promise<void>((resolve, reject) => {
        const cursorReq = store.openCursor();
        cursorReq.onerror = () => reject(cursorReq.error);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as StoredBookMeta;
          const fresh = byId.get(record.id);
          if (fresh) {
            downloaded.push(record.id);
            cursor.update({
              ...record,
              book: neutralizeSnapshot(fresh),
              snapshotAt: now,
            } satisfies StoredBookMeta);
          }
          cursor.continue();
        };
      });
    });
  } catch {
    // Snapshot refresh is best-effort; a stale title never blocks reading.
  }
  if (downloaded.length === 0) return;
  try {
    // Separate transaction on purpose: the seeding below is a chain of
    // get/put awaits, and starting it after the cursor above had drained would
    // risk the transaction having auto-committed underneath it.
    await tx(PROFILE_PROGRESS_STORE, "readwrite", async (getStore) => {
      const store = getStore(PROFILE_PROGRESS_STORE);
      const now = Date.now();
      for (const id of downloaded) {
        const fresh = byId.get(id);
        if (!fresh) continue;
        const key = progressKey(id, profileId);
        const existing = (await reqDone(store.get(key))) as StoredProgress | undefined;
        // Un-synced local position wins over anything the server sent.
        if (existing && existing.updatedAt > existing.syncedAt) continue;
        const locator = fresh.locator ?? null;
        // Nothing to record: the server has no position for this profile and we
        // hold no row — don't create an empty one.
        if (!existing && locator === null && fresh.progress <= 0) continue;
        // Already identical — skip the write so a steady state does no I/O.
        if (
          existing &&
          existing.locator === locator &&
          Math.abs(existing.progress - fresh.progress) < 1e-4
        ) {
          continue;
        }
        await reqDone(
          store.put({
            key,
            id,
            profileId,
            progress: fresh.progress,
            locator,
            // Synced by definition: this value just came FROM the server, so it
            // must not look pending (that would PATCH it straight back).
            updatedAt: now,
            syncedAt: now,
          } satisfies StoredProgress),
        );
      }
    });
  } catch {
    // Best-effort as above.
  }
}

// --- Local reading progress -----------------------------------------------

/**
 * Read a profile's local progress record for a book, or null if none. `pending`
 * is true when the record has un-synced local changes (`updatedAt > syncedAt`) —
 * i.e. a reading position this device holds that the server hasn't confirmed
 * yet. The offline-resume tiebreak uses it so a not-yet-flushed position always
 * wins (brief item 3).
 *
 * Scoped to `profileId` (v4): before that, one row per book was shared by
 * everyone on the device, so B opening a book A had read offline resumed at A's
 * page. On a miss we fall back to the record with NO profile (`~device`) — a
 * position recorded before profiles existed, which still resumes for whoever is
 * active, exactly as it did pre-brief-35.
 */
export async function getLocalProgress(
  id: string,
  profileId: string | null,
): Promise<(LocalProgress & { pending: boolean }) | null> {
  if (!isOfflineSupported()) return null;
  try {
    return await tx(PROFILE_PROGRESS_STORE, "readonly", async (getStore) => {
      const store = getStore(PROFILE_PROGRESS_STORE);
      let record = (await reqDone(store.get(progressKey(id, profileId)))) as
        | StoredProgress
        | undefined;
      if (!record && profileId) {
        record = (await reqDone(store.get(progressKey(id, null)))) as StoredProgress | undefined;
      }
      if (!record) return null;
      return {
        progress: record.progress,
        locator: record.locator,
        updatedAt: record.updatedAt,
        profileId: record.profileId ?? null,
        pending: record.updatedAt > record.syncedAt,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Write the local progress record for `record.profileId` (called on every
 * debounced reading tick). Preserves that profile's existing `syncedAt` so the
 * reconnect flush can still tell the record diverged from the server since the
 * last successful PATCH.
 *
 * The (profile, book) key is what makes this safe: pre-v4 this put overwrote
 * whatever row existed for the book, so the first tick after a profile switch
 * destroyed the previous reader's un-synced offline position outright.
 */
export async function putLocalProgress(id: string, record: LocalProgress): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    await tx(PROFILE_PROGRESS_STORE, "readwrite", async (getStore) => {
      const store = getStore(PROFILE_PROGRESS_STORE);
      const key = progressKey(id, record.profileId);
      const existing = (await reqDone(store.get(key))) as StoredProgress | undefined;
      await reqDone(
        store.put({
          key,
          id,
          progress: record.progress,
          locator: record.locator,
          updatedAt: record.updatedAt,
          // The profile active on THIS device right now — recorded at write
          // time so a later flush (possibly after a profile switch) still
          // knows who actually read this position (brief 35 step 7).
          profileId: record.profileId,
          syncedAt: existing?.syncedAt ?? 0,
        } satisfies StoredProgress),
      );
    });
  } catch {
    // Best-effort: a failed local write just means offline progress lags a turn.
  }
}

/**
 * Mark one profile's local progress record as synced up to `updatedAt` — called
 * after a successful PATCH so it's no longer considered pending (prevents PATCH
 * spam). `profileId` is the profile the record was WRITTEN by (for a flushed
 * record, `LocalProgress.profileId`, not whoever is active now).
 */
export async function markLocalProgressSynced(
  id: string,
  profileId: string | null,
  updatedAt: number,
): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    await tx(PROFILE_PROGRESS_STORE, "readwrite", async (getStore) => {
      const store = getStore(PROFILE_PROGRESS_STORE);
      const key = progressKey(id, profileId);
      const existing = (await reqDone(store.get(key))) as StoredProgress | undefined;
      if (!existing) return;
      // Only advance syncedAt; never regress it if a newer tick already landed.
      const syncedAt = Math.max(existing.syncedAt, updatedAt);
      await reqDone(store.put({ ...existing, key, id, syncedAt } satisfies StoredProgress));
    });
  } catch {
    /* best-effort */
  }
}

/**
 * List local progress records that have un-synced local changes
 * (`updatedAt > syncedAt`) — the candidates the reconnect flush pushes once.
 * Every profile's records, not just the active one: that is the whole point of
 * the queue carrying `profileId` (the flush PATCHes each as its own profile).
 */
export async function listPendingProgress(): Promise<Array<LocalProgress & { id: string }>> {
  if (!isOfflineSupported()) return [];
  try {
    return await tx(PROFILE_PROGRESS_STORE, "readonly", async (getStore) => {
      const store = getStore(PROFILE_PROGRESS_STORE);
      const all = (await reqDone(store.getAll())) as StoredProgress[];
      return all
        .filter((r) => r.updatedAt > r.syncedAt)
        .map((r) => ({
          id: r.id,
          progress: r.progress,
          locator: r.locator,
          updatedAt: r.updatedAt,
          profileId: r.profileId ?? null,
        }));
    });
  } catch {
    return [];
  }
}

/**
 * Drop ONE profile's local progress record for a book — used when the profile
 * that recorded it no longer exists (the reconnect flush's profile-scoped PATCH
 * comes back 404, brief 35 step 7). Deliberately narrower than
 * `deleteOfflineBook` in two directions: it touches ONLY the progress store, so
 * a still-downloaded book's blob and metadata (device-scoped, decision 7) are
 * untouched — it's the attribution that's gone, not the book — and only the
 * named profile's row, so a housemate's position for the same book survives.
 * Idempotent: deleting an absent record is a no-op.
 */
export async function deleteLocalProgress(id: string, profileId: string | null): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    await tx(PROFILE_PROGRESS_STORE, "readwrite", async (getStore) => {
      await reqDone(getStore(PROFILE_PROGRESS_STORE).delete(progressKey(id, profileId)));
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the resume locator for opening a stored book (brief item 5): the
 * active profile's own local progress record, or null to start fresh.
 *
 * Pre-v4 this fell back to the snapshot's locator when the local record looked
 * stale (`updatedAt < snapshotAt`). That fallback is gone, and must stay gone:
 * the snapshot is device-scoped and shared by every profile, so the position it
 * carried was whoever's library list refreshed it last — opening B's book at A's
 * page. The server position that used to arrive through the snapshot now arrives
 * through `refreshOfflineSnapshots`, seeded into the right profile's record, so
 * the local record is the single source for this and the tiebreak has nothing
 * left to break: a record that exists is either this profile's own reading or
 * this profile's own server position.
 */
export function resolveOfflineResume(local: (LocalProgress & { pending?: boolean }) | null): string | null {
  return local?.locator ?? null;
}

// --- Storage estimate -----------------------------------------------------

/**
 * Storage usage via `navigator.storage.estimate()` (brief item 1) — the
 * platform total for this origin, surfaced unobtrusively on the library page.
 * Null when the API is unavailable.
 */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}
