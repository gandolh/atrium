import { knex } from "../../database/knex.js";

/**
 * Which profile a given **device session** last activated.
 *
 * ## Why this table exists now and did not before
 *
 * The active profile used to be a column on atrium's own `sessions` table —
 * `sessions.active_profile_id`. D53 handed sessions to Ward, which knows
 * nothing about profiles (D35), so the selection got a home of atrium's own.
 * D58 brought sessions back, but they are the library's table, and the
 * selection stayed here.
 *
 * ## Keyed on `(subject, sid)`, and that pair is the whole design
 *
 * `sid` is the session's id (`auth_sessions.id_hash`, D58) — one browser, one
 * sign-in. Under D53 it was the Ward token's refresh family, and the D58
 * migration dropped those rows. Keying on it reproduces the old per-device
 * behaviour exactly:
 * switching to "Kids" on the laptop does not switch the phone, which is the
 * property D35 wanted and which a per-account column would silently lose.
 *
 * `subject` is in the key as well as `sid`, and not merely for display. It
 * makes the row self-describing for the cascade below, and it means a lookup
 * can never return another account's selection even if a `sid` were somehow
 * reused — which it is not, but the alternative is trusting that at every read.
 *
 * ## Rows here are disposable, and nothing depends on one existing
 *
 * A missing row means "no profile activated on this device yet", which resolves
 * to the account's default. That is the same rule the old nullable column had,
 * and it is why losing this table would be an inconvenience rather than a
 * failure: every read falls back, and the guard treats a missing or stale
 * selection as never being an auth failure.
 *
 * There is deliberately **no cleanup job** for sessions that have ended. A row
 * is an account, a session hash and a profile id and nothing sensitive, and
 * one row per sign-in per account is a table that stays small on its own.
 */

export interface ProfileSelectionRow {
  subject: string;
  /** The session's id hash: one sign-in on one device. */
  sid: string;
  profile_id: string;
  updated_at: string;
}

/** The profile this device last activated, or undefined for "never chosen". */
export async function getSelectedProfileId(
  subject: string,
  sid: string,
): Promise<string | undefined> {
  const row = (await knex("profile_selections").where({ subject, sid }).first()) as
    | ProfileSelectionRow
    | undefined;
  return row?.profile_id;
}

/**
 * Record this device's choice. Upsert, because activating is idempotent and a
 * person switching back and forth must not accumulate rows.
 */
export async function setSelectedProfile(
  subject: string,
  sid: string,
  profileId: string,
): Promise<void> {
  await knex("profile_selections")
    .insert({
      subject,
      sid,
      profile_id: profileId,
      updated_at: new Date().toISOString(),
    })
    .onConflict(["subject", "sid"])
    .merge(["profile_id", "updated_at"]);
}
