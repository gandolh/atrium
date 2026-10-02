import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { knex } from "../src/database/knex.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 54: the compile slot's durable half joined through `profiles.user_id`,
// which the Ward cutover dropped, so every compile, publish and cancel was a
// 500 on any database past that migration. This file's database has run every
// migration, cutover included. Typecheck cannot see a Knex column string; this
// can.
describe("LaTeX compile on the post-cutover schema", () => {
  let t: TestApp;
  let owner: string;
  let otherSubject: string;

  const post = async (cookie: string, url: string, payload?: object) =>
    t.app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

  const newProject = async (cookie: string, title: string): Promise<string> => {
    const res = await post(cookie, "/latex", { title });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id;
  };

  before(async () => {
    t = await buildTestApp();
    owner = t.ward.signIn("owner", "subject-owner");
    otherSubject = t.ward.signIn("other", "subject-other");
  });
  after(async () => {
    await t.close();
  });

  it("compile, publish and cancel all answer, none with a 500", async () => {
    const id = await newProject(owner, "Paper");

    const compiled = await post(owner, `/latex/${id}/compile`);
    assert.equal(compiled.statusCode, 200, compiled.body);
    assert.equal(compiled.json().status, "ready", compiled.body);

    const published = await post(owner, `/latex/${id}/publish`);
    assert.ok([200, 201].includes(published.statusCode), published.body);

    const cancelled = await post(owner, `/latex/${id}/cancel`);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().cancelled, false); // nothing was running
  });

  describe("the slot is per account, not per profile", () => {
    let held: string;

    before(async () => {
      held = await newProject(owner, "Held");
      // The durable half of the slot: a project of this account marked
      // running, as a compile in flight (or in another process) leaves it.
      await knex("latex_projects").where({ id: held }).update({ compile_status: "running" });
    });
    after(async () => {
      await knex("latex_projects").where({ id: held }).update({ compile_status: "none" });
    });

    it("another profile of the same subject gets the 409", async () => {
      const profile = await post(owner, "/profiles", { name: "Second", color: "mint" });
      assert.equal(profile.statusCode, 201, profile.body);
      const activated = await post(owner, `/profiles/${profile.json().id}/activate`);
      assert.ok(activated.statusCode < 300, activated.body);

      const project = await newProject(owner, "From the second profile");
      const res = await post(owner, `/latex/${project}/compile`);
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(res.json().error, "COMPILE_BUSY");
      assert.equal(res.json().runningProjectId, held);
    });

    it("a different subject is not blocked", async () => {
      const project = await newProject(otherSubject, "Someone else's");
      const res = await post(otherSubject, `/latex/${project}/compile`);
      assert.equal(res.statusCode, 200, res.body);
    });
  });
});
