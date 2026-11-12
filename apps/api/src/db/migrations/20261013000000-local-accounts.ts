import type { Knex } from "knex";

/**
 * Accounts are atrium's own again (D58): forget every device's profile choice.
 *
 * `profile_selections` is keyed on `(subject, sid)`, and until now `sid` was
 * the Ward token's refresh family. From here it is the local session's id
 * (`auth_sessions.id_hash`, read off `request.auth`), and no session will ever
 * carry one of the old values again. The rows are unreachable, so they go.
 *
 * Nothing is lost that a person would notice. A device with no selection falls
 * back to the account's default profile, and the web app re-activates its
 * remembered profile on boot (`lib/auth.ts`), so each device lands where it
 * was on its first request after signing in again.
 *
 * The accounts themselves are not made here. They need the library's store,
 * so `database/ward-subjects.ts` creates them as a boot task.
 */
export async function up(knex: Knex): Promise<void> {
  await knex("profile_selections").delete();
}

/** Nothing to restore: the deleted rows named Ward sessions atrium no longer reads. */
export async function down(): Promise<void> {}
