import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { knex } from "../src/database/knex.js";
import { linkWardSubjects, MIGRATED_ROLE } from "../src/database/ward-subjects.js";
import { createWardIdentities } from "../vendor/ward/ward-auth.js";
import { buildTestApp, type TestApp } from "./harness.js";

// D58: every Ward subject atrium's profiles know becomes a local user whose id
// IS that subject, linked to it, so no profile row is rewritten. Run on every
// boot, so it must skip what exists and never touch a user made since.
describe("Ward subjects become local users", () => {
  let t: TestApp;
  const now = new Date().toISOString();
  // Two subjects sharing their first eight characters, so the placeholder
  // names collide and the second must be lengthened.
  const SUBJECTS = ["0a1b2c3d-1111-4000-8000-000000000001", "0a1b2c3d-2222-4000-8000-000000000002"];

  before(async () => {
    t = await buildTestApp();
    await knex("profiles").insert([
      { id: "p-a", subject: SUBJECTS[0], name: "Default", color: "cream", is_default: 1, created_at: now },
      { id: "p-a2", subject: SUBJECTS[0], name: "Kids", color: "rose", is_default: 0, created_at: now },
      { id: "p-b", subject: SUBJECTS[1], name: "Default", color: "cream", is_default: 1, created_at: now },
    ]);
    await knex("note_folders").insert({ id: "f-a", profile_id: "p-a", name: "Mine", created_at: now });
  });
  after(async () => {
    await t.close();
  });

  it("creates one linked user per subject, with the subject as its id", async () => {
    const created = await linkWardSubjects(t.accounts);
    assert.deepEqual([...created].sort(), [...SUBJECTS].sort());

    const identities = createWardIdentities({ accounts: t.accounts });
    for (const subject of SUBJECTS) {
      const user = await t.accounts.findUserById(subject);
      assert.ok(user, subject);
      assert.equal(user.role, MIGRATED_ROLE);
      assert.equal(user.hasPassword, false);
      assert.equal((await identities.findUserBySubject(subject))?.id, subject);
    }
    const names = await Promise.all(SUBJECTS.map(async (s) => (await t.accounts.findUserById(s))!.username));
    assert.equal(new Set(names).size, 2);
    assert.ok(names.includes("user-0a1b2c3d"), names.join(", "));
  });

  it("re-running creates nothing and leaves every profile row as it was", async () => {
    const profiles = await knex("profiles").orderBy("id");
    assert.deepEqual(await linkWardSubjects(t.accounts), []);
    assert.deepEqual(await knex("profiles").orderBy("id"), profiles);
    assert.equal((await knex("note_folders").where({ id: "f-a" }).first()).profile_id, "p-a");
  });

  it("the migrated account's session reaches its own profiles, not another's", async () => {
    const { token } = await t.accounts.startSession(SUBJECTS[0]!);
    const res = await t.app.inject({
      method: "GET",
      url: "/profiles",
      headers: { cookie: `atrium_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().map((p: { id: string }) => p.id).sort(), ["p-a", "p-a2"]);
  });

  it("an account made after the move is never mistaken for a Ward subject", async () => {
    const cookie = await t.signIn("made-later");
    await t.app.inject({ method: "GET", url: "/profiles", headers: { cookie } });
    assert.deepEqual(await linkWardSubjects(t.accounts), []);
    const identities = createWardIdentities({ accounts: t.accounts });
    assert.equal(await identities.subjectOf("made-later"), undefined);
  });
});
