import { randomBytes } from "node:crypto";
import { verifyPassword } from "../../common/password.js";
import { listProfiles, type ProfileRow } from "../profiles/profiles.model.js";
import { createSession, deleteSession, getUserByName } from "./auth.model.js";

/**
 * Login and logout (D30). Accounts are operator-seeded (no self-registration —
 * see `scripts/seed.ts`); the library is shared across all users. Login trades
 * a username + password for an opaque, server-stored session token, which
 * clients present as `Authorization: Bearer <token>` or `?token=<token>` (cover
 * `<img>` tags can't send headers). Auth is always on.
 *
 * Supersedes the single shared platform password (brief 09): the token is no
 * longer derived from a static password but is a random per-session secret, so
 * a session can be revoked and a request can be attributed to a user.
 */

/**
 * A fixed valid `saltHex:hashHex` used only to spend ~equal CPU on the
 * unknown-username path. Not a real credential.
 */
const DUMMY_HASH =
  "00000000000000000000000000000000:" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000";

export type LoginResult =
  | { ok: true; token: string; username: string; active: ProfileRow; profiles: ProfileRow[] }
  | { ok: false; reason: "UNAUTHORIZED" }
  /** The account exists but has no profile at all — see the note in `login`. */
  | { ok: false; reason: "NO_PROFILE"; userId: string };

/** Mint a fresh, high-entropy session token. */
function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Verify credentials and open a session.
 *
 * Both the active profile and the full list come back so the caller can render
 * the "Who's reading?" picker with no second round-trip (brief 35 step 1);
 * login activates the account's default, and the client may then switch with
 * `POST /profiles/:id/activate`.
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await getUserByName(username);
  // Verify against the found user, or a throwaway hash when the username is
  // unknown, so response timing doesn't reveal whether the username exists.
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : (verifyPassword(password, DUMMY_HASH), false);
  if (!user || !ok) return { ok: false, reason: "UNAUTHORIZED" };

  const profiles = await listProfiles(user.id);
  const active = profiles.find((p) => p.is_default === 1) ?? profiles[0];
  if (!active) {
    // Unreachable in practice — `ensureDefaultProfiles()` runs on every boot.
    // Reported rather than papered over: a session with no profile would make
    // every profile-scoped route silently read and write nothing.
    return { ok: false, reason: "NO_PROFILE", userId: user.id };
  }

  const token = newSessionToken();
  await createSession(token, user.id, new Date().toISOString(), active.id);
  return { ok: true, token, username: user.username, active, profiles };
}

/** Revoke one session. A no-op for a token that is already unknown. */
export async function logout(token: string): Promise<void> {
  await deleteSession(token);
}
