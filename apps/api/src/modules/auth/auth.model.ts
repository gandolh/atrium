import { knex } from "../../database/knex.js";

/**
 * Data access for `users` and `sessions` — the account half of identity (D30).
 * The profile half lives in the profiles module; the two meet only on
 * `sessions.active_profile_id`, which this file writes and that one reads.
 */

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

// --- Users -------------------------------------------------------------------

export async function getUserByName(username: string): Promise<UserRow | undefined> {
  return (await knex("users").where({ username }).first()) as UserRow | undefined;
}

/**
 * Insert a user, or update the password of an existing one (matched by
 * username). Used by the operator seed script; re-running it is idempotent.
 */
export async function upsertUser(row: UserRow): Promise<void> {
  await knex("users").insert(row).onConflict("username").merge(["password_hash"]);
}

// --- Sessions ----------------------------------------------------------------

/**
 * Open a session. `activeProfileId` is the profile login resolved as active
 * (the account's default) — it defaults to null, in which case the guard falls
 * back to the default on the first request rather than 401-ing.
 */
export async function createSession(
  token: string,
  userId: string,
  now: string,
  activeProfileId: string | null = null,
): Promise<void> {
  await knex("sessions").insert({
    token,
    user_id: userId,
    created_at: now,
    active_profile_id: activeProfileId,
  });
}

/**
 * Resolve a session token to its identity — the account plus the session's
 * active profile id — or undefined if the token is unknown.
 *
 * The active profile rides along on the identity lookup so the guard resolves
 * account + profile in one hit on every request (brief 35 decision 1). The
 * alias is camelCase because `SessionUser` is a request-facing shape, not a raw
 * row like `BookRow`.
 */
export async function getSessionUser(token: string): Promise<SessionUser | undefined> {
  return (await knex({ s: "sessions" })
    .join({ u: "users" }, "u.id", "s.user_id")
    .select("u.id as id", "u.username as username", "s.active_profile_id as activeProfileId")
    .where("s.token", token)
    .first()) as SessionUser | undefined;
}

/**
 * Point a session at a different profile (`POST /profiles/:id/activate`).
 * Switching is free by design (D35), so this is the whole of a switch on the
 * server: no new token, no re-auth, and other tabs on the same token follow.
 */
export async function setSessionActiveProfile(
  token: string,
  profileId: string | null,
): Promise<void> {
  await knex("sessions").where({ token }).update({ active_profile_id: profileId });
}

export async function deleteSession(token: string): Promise<void> {
  await knex("sessions").where({ token }).delete();
}
