import { knex } from "../../database/knex.js";

/**
 * Which profile a given **device session** last activated.
 *
 * ## Why this table exists now and did not before
 *
 * The active profile used to be a column on atrium's own `sessions` table —
 * `sessions.active_profile_id`. Ward owns sessions now, and Ward deliberately
 * knows nothing about profiles (D35: they are atrium's, and Ward's model has no
 * place to put them). So the selection needs a home of atrium's own.
 *
 * ## Keyed on `(subject, sid)`, and that pair is the whole design
 *
 * `sid` is the Ward access token's refresh-family claim — one browser, one
 * sign-in. Keying on it reproduces the old per-device behaviour exactly:
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
 * There is deliberately **no cleanup job** for sessions that have ended. Ward
 * does not tell atrium when a refresh family dies, a row is a subject and a
 * profile id and nothing sensitive, and one row per device per account is a
 * table that stays small on its own. Pruning it would mean atrium subscribing
 * to Ward's session lifecycle for no benefit.
 */

export interface ProfileSelectionRow {
  subject: string;
  /** The Ward access token's `sid` claim — the refresh family, i.e. the device. */
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
