import { randomUUID } from "node:crypto";
import { PROFILE_COLORS } from "@ebook-reader/shared";
import { createProfile, getDefaultProfile, getUserByName, upsertUser } from "../src/db.js";
import { hashPassword } from "../src/password.js";

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

for (const { username, password } of SEED_USERS) {
  const existing = getUserByName(username);
  const userId = existing?.id ?? randomUUID();
  upsertUser({
    id: userId,
    username,
    password_hash: hashPassword(password),
    created_at: existing?.created_at ?? new Date().toISOString(),
  });
  console.log(`${existing ? "updated" : "created"} user: ${username}`);

  // Every account needs a default profile (brief 35) — the auth guard's
  // fallback, the login response, and "can't delete the last profile" all
  // assume one exists. `ensureDefaultProfiles()` in db.ts backstops this on
  // every boot, but seeding it here means a freshly seeded account is correct
  // immediately rather than after the next API restart. Guarded by
  // `getDefaultProfile` (not a re-run of `createProfile`) so re-running this
  // script never trips the unique `(user_id, name)` index.
  if (!getDefaultProfile(userId)) {
    createProfile({
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
