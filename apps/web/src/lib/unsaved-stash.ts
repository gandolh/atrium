import { notePageSchema, type NotePage } from "@ebook-reader/shared";

/**
 * Device copies of authored work that has not reached the server: LaTeX
 * source (brief 85) and Notes (brief 88).
 *
 * Both editors keep the open work only in React state, and a 401 takes the
 * editor down: the API client's handler resets the session store and
 * `AuthGate` renders the login page in place, unmounting the editor with
 * whatever the last autosave did not carry. So unsaved work is also written
 * here, and a save that reaches the server removes it. When the same account
 * and profile open the same file or note again, the editor offers the copy
 * back.
 *
 * Two backends, because the two kinds differ in size by orders of magnitude:
 *
 * - **LaTeX source goes to localStorage**, one entry per file. A source file
 *   is text a person typed, small enough to write synchronously on every edit.
 * - **A note goes to IndexedDB**, one record per note. An autosave carries the
 *   whole notebook, every point of every stroke, and the API accepts up to
 *   16 MiB of it (`NOTE_TOO_LARGE`). localStorage holds about 5 MiB per origin,
 *   shared with the LaTeX copies and every preference, and `setItem` of a few
 *   MiB is a synchronous stall on the pen. IndexedDB stores the pages as they
 *   are (structured clone, no JSON string), off the main thread, under a quota
 *   that is a share of the disk.
 *
 * Every copy is keyed by account id and profile id as well as the item. The
 * account is the security boundary (D35): the next person to sign in on this
 * device may be somebody else, and `signedOut()` clears the per-profile caches
 * for exactly that reason. So `lib/auth.ts` runs `discardOtherAccounts`
 * whenever an account is signed in, which drops every copy, of either kind,
 * that belongs to anyone else.
 *
 * Best-effort throughout: storage can be full, disabled or private, and losing
 * the copy must never break an editor.
 */

/* ------------------------------------------------------------------ LaTeX */

const PREFIX = "atrium.latex-unsaved:";

/** Who a LaTeX copy belongs to. */
export interface StashOwner {
  accountId: string;
  profileId: string;
  projectId: string;
}

/** A recovered copy of one LaTeX file. */
export interface StashedSource {
  text: string;
  /** Epoch ms of the edit that wrote it. */
  at: number;
}

function keyFor(owner: StashOwner, path: string): string {
  return PREFIX + JSON.stringify([owner.accountId, owner.profileId, owner.projectId, path]);
}

/** Record the buffer for `path`. Called on every unsaved edit. */
export function writeStash(owner: StashOwner, path: string, text: string): void {
  try {
    localStorage.setItem(keyFor(owner, path), JSON.stringify({ text, at: Date.now() }));
  } catch {
    /* the copy is best-effort */
  }
}

/** The copy for `path`, or null. */
export function readStash(owner: StashOwner, path: string): StashedSource | null {
  try {
    const raw = localStorage.getItem(keyFor(owner, path));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StashedSource>;
    if (typeof parsed.text !== "string" || typeof parsed.at !== "number") return null;
    return { text: parsed.text, at: parsed.at };
  } catch {
    return null;
  }
}

/** Forget the copy for `path`: it reached the server, or was discarded. */
export function clearStash(owner: StashOwner, path: string): void {
  try {
    localStorage.removeItem(keyFor(owner, path));
  } catch {
    /* best-effort */
  }
}

/** Remove every LaTeX copy that does not belong to `accountId`. */
function discardOtherLatexCopies(accountId: string): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let owner: unknown;
      try {
        owner = (JSON.parse(key.slice(PREFIX.length)) as unknown[])[0];
      } catch {
        owner = undefined;
      }
      if (owner !== accountId) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------ Notes */

const DB_NAME = "atrium-unsaved";
const DB_VERSION = 1;
const NOTES_STORE = "notes";

/** Who a note copy belongs to. */
export interface NoteStashOwner {
  accountId: string;
  profileId: string;
  noteId: string;
}

/** A recovered copy of one note: what the editor held, and when. */
export interface StashedNote {
  title: string;
  pages: NotePage[];
  /** Epoch ms of the write. */
  at: number;
}

/** The record key: an array key, so the sweep can read the account off it. */
function noteKey(owner: NoteStashOwner): [string, string, string] {
  return [owner.accountId, owner.profileId, owner.noteId];
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Its own small database rather than a store in the offline library's
 * (`lib/offline-store.ts`): a new store there means a version bump through
 * that database's migrations, for data that has nothing to do with it.
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(NOTES_STORE)) {
        req.result.createObjectStore(NOTES_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A later version opened in another tab: step aside rather than block it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  // A failed open is retried on the next call instead of failing forever.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/**
 * Run one request in its own transaction on the notes store and resolve with
 * its result once the transaction has committed. Transactions on one store run
 * in the order they were created, so a write followed by a clear can never
 * land the other way round.
 */
async function inNotesStore<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, mode);
    const req = op(tx.objectStore(NOTES_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Record what the editor holds for a note that has not reached the server. */
export function writeNoteStash(
  owner: NoteStashOwner,
  draft: { title: string; pages: NotePage[] },
): Promise<void> {
  const record: StashedNote = { title: draft.title, pages: draft.pages, at: Date.now() };
  return inNotesStore("readwrite", (store) => {
    store.put(record, noteKey(owner));
  }).then(
    () => undefined,
    () => undefined, // the copy is best-effort
  );
}

/**
 * The copy for a note, or null. The pages are checked against the shared
 * contract on the way out, so a damaged record reads as no copy rather than a
 * page the editor cannot draw, and come back in the same shape the API's
 * answer has (key order, defaults), which is what lets the editor compare the
 * two as JSON.
 */
export async function readNoteStash(owner: NoteStashOwner): Promise<StashedNote | null> {
  try {
    const raw = (await inNotesStore("readonly", (store) => store.get(noteKey(owner)))) as
      | Partial<StashedNote>
      | undefined;
    if (!raw || typeof raw.title !== "string" || typeof raw.at !== "number") return null;
    const pages = notePageSchema.array().safeParse(raw.pages);
    if (!pages.success) return null;
    return { title: raw.title, pages: pages.data, at: raw.at };
  } catch {
    return null;
  }
}

/** Forget the copy for a note: it reached the server, or was discarded. */
export function clearNoteStash(owner: NoteStashOwner): Promise<void> {
  return inNotesStore("readwrite", (store) => {
    store.delete(noteKey(owner));
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** Remove every note copy that does not belong to `accountId`. */
async function discardOtherNoteCopies(accountId: string): Promise<void> {
  try {
    await inNotesStore("readwrite", (store) => {
      const cursorReq = store.openKeyCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const owner = Array.isArray(cursor.key) ? cursor.key[0] : undefined;
        if (owner !== accountId) store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------- both */

/**
 * Remove every copy, LaTeX or note, that does not belong to `accountId`. Run
 * as soon as the account is known, so another account's work is gone from
 * this device before anything could show it. The editors read only copies
 * keyed to the signed-in account, so even a sweep still in flight cannot leak
 * one.
 */
export function discardOtherAccounts(accountId: string): void {
  discardOtherLatexCopies(accountId);
  void discardOtherNoteCopies(accountId);
}
