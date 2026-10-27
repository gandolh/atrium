import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { knex } from "../src/database/knex.js";
import { initDatabase, logMigratedAccounts, type BootLog } from "../src/database/bootstrap.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 90: the first deploy of D58. The boot says which Ward subjects became
// passwordless accounts, and `seed:user --set-password` gives such an account a
// password without making a new, empty one.

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const ORIGIN = "http://localhost:5173";
const SUBJECT = "0a1b2c3d-1111-4000-8000-000000000001";
const MIGRATED = "user-0a1b2c3d";

/** The seed script as `npm run seed:user` runs it, on this process's scratch storage. */
async function seedUser(args: string[], env: Record<string, string>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  // Not a test process of its own: without this the child would report to the runner.
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", "src/scripts/seed-user.ts", ...args],
      { cwd: API_ROOT, env: childEnv },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("upgrading to local accounts", () => {
  let t: TestApp;
  const lines: { detail: object; message: string }[] = [];
  const log: BootLog = { warn: (detail, message) => lines.push({ detail, message }) };

  before(async () => {
    t = await buildTestApp();
    // A pre-D58 library: a profile keyed on a Ward subject no user has yet.
    await knex("profiles").insert({
      id: "p-owner",
      subject: SUBJECT,
      name: "Default",
      color: "cream",
      is_default: 1,
      created_at: new Date().toISOString(),
    });
  });
  after(async () => {
    await t.close();
  });

  const login = (username: string, password: string) =>
    t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { username, password },
    });

  it("the boot that migrates a Ward subject logs it, with the way in", async () => {
    const boot = await initDatabase();
    assert.deepEqual(boot.migratedAccounts, [{ subject: SUBJECT, username: MIGRATED }]);

    logMigratedAccounts(log, boot.migratedAccounts, { signInWithWard: true });
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]!.detail, { subject: SUBJECT, username: MIGRATED });
    assert.equal(
      lines[0]!.message,
      `Ward subject ${SUBJECT} is now ${MIGRATED} with no password: sign in with Ward, then set a password in Settings`,
    );

    // With Ward off the line says the account has no way in, and how to give it one.
    lines.length = 0;
    logMigratedAccounts(log, boot.migratedAccounts, { signInWithWard: false });
    assert.match(lines[0]!.message, /Sign in with Ward is off, so it has no way in/);
    assert.match(lines[0]!.message, new RegExp(`seed:user --set-password and SEED_USERNAME=${MIGRATED}`));

    // The next boot migrated nothing, so it logs nothing.
    assert.deepEqual((await initDatabase()).migratedAccounts, []);
  });

  it("seed:user --set-password gives the migrated account a password it can sign in with", async () => {
    const password = "a long enough new password";
    assert.equal((await login(MIGRATED, password)).statusCode, 401);

    const seeded = await seedUser(["--set-password"], { SEED_USERNAME: MIGRATED, SEED_PASSWORD: password });
    assert.equal(seeded.code, 0, seeded.stderr);
    assert.match(seeded.stdout, new RegExp(`Set a new password for ${MIGRATED}`));

    const res = await login(MIGRATED, password);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.id, SUBJECT);

    // Still the same account: its role and its profile are where they were.
    const user = await t.accounts.findUserByUsername(MIGRATED);
    assert.equal(user?.role, "member");
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const profiles = await t.app.inject({ method: "GET", url: "/profiles", headers: { cookie } });
    assert.deepEqual(profiles.json().map((p: { id: string }) => p.id), ["p-owner"]);
  });

  it("--set-password on a username that does not exist fails and creates nothing", async () => {
    const seeded = await seedUser(["--set-password"], {
      SEED_USERNAME: "nobody-here",
      SEED_PASSWORD: "a long enough new password",
    });
    assert.equal(seeded.code, 1);
    assert.match(seeded.stderr, /No account is named "nobody-here"/);
    assert.equal(await t.accounts.findUserByUsername("nobody-here"), undefined);
  });

  it("without the flag an existing account is left alone, as before", async () => {
    const seeded = await seedUser([], { SEED_USERNAME: MIGRATED, SEED_PASSWORD: "some other password" });
    assert.equal(seeded.code, 0, seeded.stderr);
    assert.match(seeded.stdout, /already exists; left as it is/);
    assert.equal((await login(MIGRATED, "some other password")).statusCode, 401);
  });
});
