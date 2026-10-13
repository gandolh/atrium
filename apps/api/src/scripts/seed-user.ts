import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { seedUsers } from "../../vendor/ward/ward-auth.js";
import { openMigratedAccounts } from "../database/bootstrap.js";
import { closeDatabase } from "../database/knex.js";
import { JUKEBOX_ROLE, MEMBER_ROLE } from "../modules/auth/auth.guard.js";

/**
 * `npm run seed:user` — create one local account (D58).
 *
 * Atrium has no Register page, so its accounts come from here, or from a first
 * "Sign in with Ward" by somebody Ward holds an `atrium` grant for. The values
 * come from the environment, or from a prompt for whichever is missing, and
 * **never from a file in the repository**:
 *
 *   SEED_USERNAME=…  SEED_PASSWORD=…  SEED_ROLE=member  npm run seed:user
 *
 * `SEED_ROLE` is `member` (full access, the default) or `jukebox` (the Discord
 * bot's allowlist, D55). Safe to run again: an account that exists is left
 * exactly as it is, password and role included. In the deploy, run the built
 * copy inside the container: `node apps/api/dist/scripts/seed-user.js`.
 *
 * It migrates and opens the accounts as the API's boot does, against the same
 * storage roots, so it needs the same `.env`. It skips the boot's job reapers,
 * so running it beside a live API leaves that API's conversions and compiles
 * alone.
 */

const ROLES = [MEMBER_ROLE, JUKEBOX_ROLE];

/** Echo-free stdout for the password prompt. */
class Muted extends Writable {
  muted = false;
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    if (!this.muted) process.stdout.write(chunk);
    done();
  }
}

async function ask(): Promise<{ username: string; password: string; role: string }> {
  let username = process.env.SEED_USERNAME?.trim() ?? "";
  let password = process.env.SEED_PASSWORD ?? "";
  let role = process.env.SEED_ROLE?.trim() ?? "";
  if (username && password) return { username, password, role: role || MEMBER_ROLE };

  if (!process.stdin.isTTY) {
    throw new Error("Set SEED_USERNAME and SEED_PASSWORD (and optionally SEED_ROLE), or run this in a terminal.");
  }
  const output = new Muted();
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (!username) username = (await prompt.question("Username: ")).trim();
    if (!role) role = (await prompt.question(`Role (${ROLES.join(" or ")}) [${MEMBER_ROLE}]: `)).trim();
    if (!password) {
      process.stdout.write("Password: ");
      output.muted = true;
      password = await prompt.question("");
      output.muted = false;
      process.stdout.write("\n");
    }
  } finally {
    prompt.close();
  }
  return { username, password, role: role || MEMBER_ROLE };
}

async function main(): Promise<void> {
  const user = await ask();
  if (!ROLES.includes(user.role)) {
    throw new Error(`SEED_ROLE must be ${ROLES.join(" or ")}, not ${JSON.stringify(user.role)}.`);
  }
  const accounts = await openMigratedAccounts();
  try {
    const result = await seedUsers(accounts, [user]);
    console.log(
      result.created.length > 0
        ? `Created ${result.created.join(", ")} (${user.role}).`
        : `${user.username} already exists; left as it is.`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  void closeDatabase();
});
