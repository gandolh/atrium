/**
 * A device copy of LaTeX source that has not reached the server (brief 85).
 *
 * The editor's buffer lives only in React state, and a 401 takes the editor
 * down: the API client's handler resets the session store and `AuthGate`
 * renders the login page in place, unmounting the editor with whatever the
 * last autosave did not carry. So every unsaved edit is also written here, and
 * a save that reaches the server removes it. When the same account and profile
 * open the same file again, the editor offers the copy back.
 *
 * One localStorage entry per file, keyed by account id, profile id, project id
 * and path. The account is the security boundary (D35): the next person to
 * sign in on this device may be somebody else, and `signedOut()` clears the
 * per-profile caches for exactly that reason. So the key carries the account,
 * and `lib/auth.ts` runs `discardOtherAccounts` whenever an account is signed
 * in, which drops every entry that belongs to anyone else.
 *
 * Best-effort throughout: storage can be full, disabled or private, and losing
 * the copy must never break the editor.
 */

const PREFIX = "atrium.latex-unsaved:";

/** Who a copy belongs to. */
export interface StashOwner {
  accountId: string;
  profileId: string;
  projectId: string;
}

/** A recovered copy of one file. */
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

/**
 * Remove every copy that does not belong to `accountId`. Run as soon as the
 * account is known, so another account's text is gone from this device before
 * anything could show it.
 */
export function discardOtherAccounts(accountId: string): void {
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
