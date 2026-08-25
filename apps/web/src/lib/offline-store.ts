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
 * This module is intentionally free of React and of the network layer: it is a
 * typed IndexedDB wrapper only. The download itself (streaming bytes via
 * `fetchBookFile`) and the reconnect PATCH are driven by the hooks that own the
 * network (`use-library.ts`, `use-progress-sync.ts`), which inject those calls.
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
// silently re-attribute one person's reading to another. v1/v2 databases are
// migrated in `onupgradeneeded` (existing progress rows backfilled with
// `profileId: null`) — see the migration block below for why `null`.
const DB_VERSION = 3;
/** Object store: `LibraryBook` snapshot + reconstruction metadata, keyed by id.
 *  Metadata ONLY — the file bytes live in FILES_STORE (see below) so listing /
 *  refreshing snapshots never deserializes a 40 MB PDF. */
const BOOKS_STORE = "books";
/** Object store: the downloaded file blob, keyed by id (`{id, blob}`). Split
 *  from BOOKS_STORE so a metadata rewrite (snapshot refresh) doesn't re-serialize
 *  the blob, and listing never loads blobs into memory. */
const FILES_STORE = "files";
/** Object store: per-book local reading progress, keyed by id. Kept separate
 *  from BOOKS_STORE so a debounced progress write doesn't rewrite the (large)
 *  file blob on every page turn. */
const PROGRESS_STORE = "progress";

/**
 * Local reading-progress record — the client-side mirror of the server's
 * per-profile progress (D31, moved from user to profile scope by brief 35).
 * `{fraction, locator, updatedAt, profileId}` is the public shape (brief item
 * 1/5, extended by brief 35 step 7); `updatedAt` is a local `Date.now()` ms
 * epoch stamped when the reading position last changed on THIS device.
 */
export interface LocalProgress {
  /** Coarse progress 0..1 (drives the cover bar), same units as `LibraryBook.progress`. */
  fraction: number;
  /** Exact resume position: page number (as string) for PDF, CFI for EPUB; null = start. */
  locator: string | null;
  /** Local ms epoch of the last position change (last-write-wins clock, this device). */
  updatedAt: number;
  /**
   * The profile active on THIS device when the write happened (brief 35 step
   * 7) — what lets a reconnect flush attribute the PATCH to the person who
   * actually read, instead of whoever happens to be active when the network
   * comes back. `null` means "unknown, attribute to whoever is active at
   * flush time": it's what a v2 record (written before profiles existed)
   * backfills to on the v2→v3 upgrade below, and it's also what a fresh write
   * uses if `useProgressSync` ever fires before the active profile is known.
   * Both cases preserve today's behaviour exactly for the single-profile case
   * — which is every existing install, since profiles ship in this same
   * brief — rather than guessing at an attribution we don't have.
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
  /** Snapshot of the `LibraryBook` row at download time, refreshed opportunistically. */
  book: LibraryBook;
  /** Ms epoch the book was first downloaded (stable; drives "downloaded on" if shown). */
  savedAt: number;
  /** Ms epoch the `book` snapshot was last written (download or refresh) — the
   *  clock the offline-resume tiebreak compares against `LocalProgress.updatedAt`. */
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
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: "id" });
      } else if (event.oldVersion >= 1 && event.oldVersion < 3 && upgradeTx) {
        // v2 → v3 migration (brief 35): PROGRESS_STORE already exists (this is
        // an upgrade, not a fresh install), so its records predate
        // `profileId`. Backfill `profileId: null` on every existing row via a
        // cursor — same shape as the v1→v2 blob relocation below: read/rewrite
        // in place inside the versionchange transaction, nothing is dropped or
        // recreated, so no pending record can be lost by this bump.
        const progress = upgradeTx.objectStore(PROGRESS_STORE);
        const cursorReq = progress.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const legacy = cursor.value as StoredProgress & { profileId?: string | null };
          if (legacy.profileId === undefined) {
            cursor.update({ ...legacy, profileId: null } satisfies StoredProgress);
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
 * download of the same id; leaves the local progress record untouched.
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
      book,
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
      return { ...meta, blob: file.blob };
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
 * Remove a downloaded book AND its local progress record, freeing the storage.
 * Idempotent: deleting an absent id is a no-op.
 */
export async function deleteOfflineBook(id: string): Promise<void> {
  await tx([BOOKS_STORE, FILES_STORE, PROGRESS_STORE], "readwrite", async (getStore) => {
    await reqDone(getStore(BOOKS_STORE).delete(id));
    await reqDone(getStore(FILES_STORE).delete(id));
    await reqDone(getStore(PROGRESS_STORE).delete(id));
  });
}

/** List downloaded books' metadata (no blobs), newest download first. */
export async function listOfflineBooks(): Promise<OfflineBookSummary[]> {
  if (!isOfflineSupported()) return [];
  try {
    // BOOKS_STORE holds metadata only (since v2), so `getAll` never pulls a
    // single blob into memory — the whole reason for the store split.
    return await tx(BOOKS_STORE, "readonly", async (getStore) => {
      const all = (await reqDone(getStore(BOOKS_STORE).getAll())) as StoredBookMeta[];
      return all.slice().sort((a, b) => b.savedAt - a.savedAt);
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
 * `snapshotAt` is the clock the offline-resume tiebreak compares against local
 * progress, so it is bumped ONLY when the server's reading position actually
 * moved (locator/progress changed). Bumping it on every library load — even when
 * the position is unchanged — would let a plain GET shadow newer local progress
 * that hasn't flushed yet, losing the reader's offline position (brief item 3).
 * Title/cover drift is still refreshed without disturbing the tiebreak clock.
 *
 * Operates over BOOKS_STORE (metadata only, since v2) with a cursor, so the
 * blobs are never read or rewritten.
 */
export async function refreshOfflineSnapshots(books: LibraryBook[]): Promise<void> {
  if (!isOfflineSupported() || books.length === 0) return;
  const byId = new Map(books.map((b) => [b.id, b]));
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
            const positionMoved =
              (fresh.locator ?? null) !== (record.book.locator ?? null) ||
              Math.abs(fresh.progress - record.book.progress) > 1e-4;
            cursor.update({
              ...record,
              book: fresh,
              snapshotAt: positionMoved ? now : record.snapshotAt,
            } satisfies StoredBookMeta);
          }
          cursor.continue();
        };
      });
    });
  } catch {
    // Snapshot refresh is best-effort; a stale title never blocks reading.
  }
}

// --- Local reading progress -----------------------------------------------

/**
 * Read the local progress record for a book, or null if none. `pending` is true
 * when the record has un-synced local changes (`updatedAt > syncedAt`) — i.e. a
 * reading position this device holds that the server hasn't confirmed yet. The
 * offline-resume tiebreak uses it so a not-yet-flushed position always wins over
 * a stale snapshot (brief item 3).
 */
export async function getLocalProgress(
  id: string,
): Promise<(LocalProgress & { pending: boolean }) | null> {
  if (!isOfflineSupported()) return null;
  try {
    return await tx(PROGRESS_STORE, "readonly", async (getStore) => {
      const store = getStore(PROGRESS_STORE);
      const record = (await reqDone(store.get(id))) as StoredProgress | undefined;
      if (!record) return null;
      return {
        fraction: record.fraction,
        locator: record.locator,
        updatedAt: record.updatedAt,
        // A record predating brief 35 has no stored field at all; treat that
        // the same as an explicit `null` (see `LocalProgress.profileId`).
        profileId: record.profileId ?? null,
        pending: record.updatedAt > record.syncedAt,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Write the local progress record (called on every debounced reading tick).
 * Preserves the existing `syncedAt` so the reconnect flush can still tell the
 * record diverged from the server since the last successful PATCH.
 */
export async function putLocalProgress(id: string, progress: LocalProgress): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    await tx(PROGRESS_STORE, "readwrite", async (getStore) => {
      const store = getStore(PROGRESS_STORE);
      const existing = (await reqDone(store.get(id))) as StoredProgress | undefined;
      const record: StoredProgress = {
        fraction: progress.fraction,
        locator: progress.locator,
        updatedAt: progress.updatedAt,
        // The profile active on THIS device right now — recorded at write
        // time so a later flush (possibly after a profile switch) still
        // knows who actually read this position (brief 35 step 7).
        profileId: progress.profileId,
        syncedAt: existing?.syncedAt ?? 0,
      };
      await reqDone(store.put({ id, ...record }));
    });
  } catch {
    // Best-effort: a failed local write just means offline progress lags a turn.
  }
}

/**
 * Mark the local progress record as synced up to `updatedAt` — called after a
 * successful PATCH so it's no longer considered pending (prevents PATCH spam).
 */
export async function markLocalProgressSynced(id: string, updatedAt: number): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    await tx(PROGRESS_STORE, "readwrite", async (getStore) => {
      const store = getStore(PROGRESS_STORE);
      const existing = (await reqDone(store.get(id))) as StoredProgress | undefined;
      if (!existing) return;
      // Only advance syncedAt; never regress it if a newer tick already landed.
      const syncedAt = Math.max(existing.syncedAt, updatedAt);
      await reqDone(store.put({ ...existing, id, syncedAt }));
    });
  } catch {
    /* best-effort */
  }
}

/**
 * List local progress records that have un-synced local changes
 * (`updatedAt > syncedAt`) — the candidates the reconnect flush pushes once.
 */
export async function listPendingProgress(): Promise<Array<LocalProgress & { id: string }>> {
  if (!isOfflineSupported()) return [];
  try {
    return await tx(PROGRESS_STORE, "readonly", async (getStore) => {
      const store = getStore(PROGRESS_STORE);
      const all = (await reqDone(store.getAll())) as Array<StoredProgress & { id: string }>;
      return all
        .filter((r) => r.updatedAt > r.syncedAt)
        .map((r) => ({
          id: r.id,
          fraction: r.fraction,
          locator: r.locator,
          updatedAt: r.updatedAt,
          // Predates brief 35 → treat as `null` (see `LocalProgress.profileId`).
          profileId: r.profileId ?? null,
        }));
    });
  } catch {
    return [];
  }
}

/**
 * Drop a book's local progress record entirely — used when the profile that
 * recorded it no longer exists (the reconnect flush's profile-scoped PATCH
 * comes back 404, brief 35 step 7). Deliberately narrower than
 * `deleteOfflineBook`: this touches ONLY PROGRESS_STORE, so a still-downloaded
 * book's blob and metadata (device-scoped, decision 7) are untouched — it's
 * the attribution that's gone, not the book. Idempotent: deleting an absent
 * id is a no-op.
 */
export async function deleteLocalProgress(id: string): Promise<void> {
  if (!isOfflineSupported()) return;
  try {
    await tx(PROGRESS_STORE, "readwrite", async (getStore) => {
      await reqDone(getStore(PROGRESS_STORE).delete(id));
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the resume locator for opening a stored book (brief item 5): prefer
 * the local progress record when it carries a position AND either it is still
 * pending (un-synced local changes the server hasn't confirmed) OR it is newer
 * than the snapshot (`updatedAt >= snapshotAt`); otherwise fall back to the
 * snapshot's server-side locator. Returns the wire locator (string) or null to
 * start fresh.
 *
 * The `pending` short-circuit is what stops a plain library GET (which refreshes
 * the snapshot before the reconnect flush lands) from shadowing a newer local
 * position — once the flush syncs it, `pending` clears and last-write-wins with
 * the server resumes (brief item 3).
 */
export function resolveOfflineResume(
  record: OfflineBookRecord,
  local: (LocalProgress & { pending?: boolean }) | null,
): string | null {
  if (local && local.locator != null && (local.pending || local.updatedAt >= record.snapshotAt)) {
    return local.locator;
  }
  return record.book.locator;
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
