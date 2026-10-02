import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { knex } from "../src/database/knex.js";
import { buildTestApp, type TestApp } from "./harness.js";

// atrium cannot enumerate Ward's accounts, so a newly-granted account's first
// request is what provisions its profile. Tabs arrive together.
describe("first contact", () => {
  let t: TestApp;
  before(async () => {
    t = await buildTestApp();
  });
  after(async () => {
    await t.close();
  });

  it("a first request provisions exactly one Default profile", async () => {
    const cookie = t.ward.signIn("first", "subject-first");
    const res = await t.app.inject({ method: "GET", url: "/profiles", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const rows = await knex("profiles").where({ subject: "subject-first" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Default");
  });

  it("five concurrent first requests still produce one profile, and no 500", async () => {
    const cookie = t.ward.signIn("burst", "subject-burst");
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.app.inject({ method: "GET", url: "/profiles", headers: { cookie } }),
      ),
    );
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [200, 200, 200, 200, 200],
    );
    const rows = await knex("profiles").where({ subject: "subject-burst" });
    assert.equal(rows.length, 1);
  });
});
