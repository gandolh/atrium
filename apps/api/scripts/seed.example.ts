import { randomUUID } from "node:crypto";
import { PROFILE_COLORS } from "@ebook-reader/shared";
import { hashPassword } from "../src/common/password.js";
import { runMigrations } from "../src/database/bootstrap.js";
import { closeDatabase } from "../src/database/knex.js";
import { createProfile, getDefaultProfile } from "../src/modules/profiles/profiles.model.js";
import { getUserByName, upsertUser } from "../src/modules/auth/auth.model.js";

/**
 * Account seed TEMPLATE. Copy to `seed.ts` (gitignored) and put the real
 * usernames + passwords there, then run:
 *
 *   npm run seed -w @ebook-reader/api
 *
 * There is no self-registration; this script is the only way accounts are
 * created. It is idempotent — re-running updates the password of an existing
 * username rather than erroring, and preserves that user's id/created_at.
 *
 * An account is a household (D35): it also gets one **profile**, the person
 * reading. Profiles are created in the app after that, not here.
 */

const SEED_USERS: Array<{ username: string; password: string }> = [
  { username: "alice", password: "change-me" },
  { username: "bob", password: "change-me" },
];

// The schema used to arrive as a side effect of importing `db.ts`. It does not
// any more, so the seed brings it up itself — otherwise seeding a fresh install
// (the common case, since this is how the FIRST account is made) would fail on
// a database with no `users` table.
await runMigrations();

for (const { username, password } of SEED_USERS) {
  const existing = await getUserByName(username);
  const userId = existing?.id ?? randomUUID();
  await upsertUser({
    id: userId,
    username,
    password_hash: hashPassword(password),
    created_at: existing?.created_at ?? new Date().toISOString(),
  });
  console.log(`${existing ? "updated" : "created"} user: ${username}`);

  // Every account needs a default profile (brief 35) — the auth guard's
  // fallback, the login response, and "can't delete the last profile" all assume
  // one exists. `ensureDefaultProfiles()` backstops this on every boot, but
  // seeding it here means a freshly seeded account is correct immediately rather
  // than after the next API restart. Guarded by `getDefaultProfile` (not a
  // re-run of `createProfile`) so re-running this script never trips the unique
  // `(user_id, name)` index.
  if (!(await getDefaultProfile(userId))) {
    await createProfile({
      id: randomUUID(),
      user_id: userId,
      name: "Default",
      color: PROFILE_COLORS[0],
      is_default: 1,
      preferences: null,
      created_at: new Date().toISOString(),
    });
    console.log(`created default profile for: ${username}`);
  }
}

// The pool holds the process open otherwise — `better-sqlite3` keeps the file
// handle until Knex is destroyed, so without this the script prints its work
// and then hangs.
await closeDatabase();
