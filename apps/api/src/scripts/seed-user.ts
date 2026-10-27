import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { seedUsers, type Accounts } from "../../vendor/ward/ward-auth.js";
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
 * ## `--set-password`: a password for an account that exists (brief 90)
 *
 *   SEED_USERNAME=user-0a1b2c3d SEED_PASSWORD=…  npm run seed:user -- --set-password
 *
 * Sets the password of the account with that username and signs out every
 * session it holds; the role and everything the account owns stay as they
 * are, and `SEED_ROLE` is not read. An unknown username is an error, never a
 * new account. It exists for the accounts the D58 upgrade made from Ward
 * subjects: `user-<8 characters>`, no password, and the owner of all that
 * person's data. Seeding a new account for them would make an empty one, so
 * this is how such an account gets a password without signing in with Ward.
 * There is no `--rename`: the vendored library has no way to change a
 * username, and atrium does not write the library's tables itself (D58).
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

const SET_PASSWORD = "--set-password";

/** The one flag. Anything else is refused, so a typo never creates an account. */
function parseArgs(args: readonly string[]): { setPassword: boolean } {
  let setPassword = false;
  for (const arg of args) {
    if (arg === SET_PASSWORD) setPassword = true;
    else throw new Error(`Unknown option ${JSON.stringify(arg)}. The only option is ${SET_PASSWORD}.`);
  }
  return { setPassword };
}

async function ask(setPassword: boolean): Promise<{ username: string; password: string; role: string }> {
  let username = process.env.SEED_USERNAME?.trim() ?? "";
  let password = process.env.SEED_PASSWORD ?? "";
  // `--set-password` never changes a role, so it neither reads nor asks for one.
  let role = setPassword ? MEMBER_ROLE : (process.env.SEED_ROLE?.trim() ?? "");
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

/** `--set-password`: the existing account's new password, and nothing else. */
async function setPasswordOf(accounts: Accounts, username: string, password: string): Promise<void> {
  const existing = await accounts.findUserByUsername(username);
  if (!existing) {
    throw new Error(`No account is named ${JSON.stringify(username)}. Run without ${SET_PASSWORD} to create it.`);
  }
  await accounts.setPassword(existing.id, password);
  console.log(
    `Set a new password for ${existing.username}, and signed out its sessions. ` +
      `Its role (${existing.role}) and everything it owns are unchanged.`,
  );
}

async function main(): Promise<void> {
  const { setPassword } = parseArgs(process.argv.slice(2));
  const user = await ask(setPassword);
  if (!ROLES.includes(user.role)) {
    throw new Error(`SEED_ROLE must be ${ROLES.join(" or ")}, not ${JSON.stringify(user.role)}.`);
  }
  const accounts = await openMigratedAccounts();
  try {
    if (setPassword) {
      await setPasswordOf(accounts, user.username, user.password);
      return;
    }
    const result = await seedUsers(accounts, [user]);
    console.log(
      result.created.length > 0
        ? `Created ${result.created.join(", ")} (${user.role}).`
        : `${user.username} already exists; left as it is. ${SET_PASSWORD} sets a new password on it.`,
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
