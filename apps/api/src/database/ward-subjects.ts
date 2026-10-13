import type { Knex } from "knex";
import {
  UsernameTakenError,
  createWardIdentities,
  type Accounts,
} from "../../vendor/ward/ward-auth.js";
import { knex } from "./knex.js";

/**
 * The role a migrated account starts with. Atrium reads two roles (D58):
 * `jukebox`, the Discord bot's allowlist (D55), and everything else, which is
 * full access. Atrium never stored which role a subject's Ward grant named, so
 * every migrated account gets full access; see D58 for the bot's account.
 */
export const MIGRATED_ROLE = "member";

/**
 * Give every Ward subject atrium's rows know a local user of its own (D58).
 *
 * From D53 to D58 atrium's only identity was Ward's subject, and
 * `profiles.subject` holds it. Each one becomes a local user **whose id is that
 * subject**, linked to the same Ward account. The profiles, and everything
 * keyed under them, keep pointing at the right person without a row being
 * rewritten, and the person's next "Sign in with Ward" finds the linked user.
 *
 * A boot task rather than a Knex migration, for two reasons. It needs the
 * library's store, and a migration that imports a vendored library would
 * change meaning every time the library is upgraded under it. And it is
 * idempotent by construction: a subject whose user exists is skipped, so
 * running it on every boot costs one query and repairs nothing that is right.
 *
 * After D58 a profile is only ever created for a user who signed in, so a
 * `profiles.subject` with no user behind it can only be a pre-D58 Ward subject.
 * The check is by **user id** as well as by link, because a user minted after
 * D58 has a library-made id and no Ward subject to find.
 *
 * Atrium never stored Ward usernames, so a migrated user is named
 * `user-<first 8 characters of the subject>`, lengthened if two subjects share
 * a prefix. Nobody types it: a migrated user has no password and signs in with
 * Ward, and only needs the name once they set a local password in settings.
 *
 * Returns the subjects it created users for, for the boot log.
 */
export async function linkWardSubjects(accounts: Accounts, db: Knex = knex): Promise<string[]> {
  const identities = createWardIdentities({ accounts });
  const rows = (await db("profiles").distinct("subject")) as { subject: string }[];
  const created: string[] = [];

  for (const { subject } of rows) {
    if (await accounts.findUserById(subject)) continue;
    if (await identities.findUserBySubject(subject)) continue;
    await createWithPlaceholder(identities, subject);
    created.push(subject);
  }
  return created;
}

/** `createLinkedUser` with the placeholder name, lengthened until it is free. */
async function createWithPlaceholder(
  identities: ReturnType<typeof createWardIdentities>,
  subject: string,
): Promise<void> {
  for (const length of [8, 12, 16, subject.length]) {
    try {
      await identities.createLinkedUser({
        subject,
        id: subject,
        username: `user-${subject.slice(0, length)}`,
        role: MIGRATED_ROLE,
      });
      return;
    } catch (error) {
      if (!(error instanceof UsernameTakenError) || length >= subject.length) throw error;
    }
  }
}
