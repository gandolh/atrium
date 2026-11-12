import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { knex } from "../src/db/knex.js";
import { buildTestApp, type TestApp } from "./harness.js";

/**
 * Every route declares its schemas through the zod type provider: the request
 * is validated before the handler runs, and the reply is encoded with the
 * route's response schema, so a field the schema doesn't name never leaves the
 * server and a reply that doesn't match it is a 500 that says nothing.
 */
describe("route schemas", () => {
  let t: TestApp;
  let me: string;
  let stranger: string;

  before(async () => {
    t = await buildTestApp();
    me = await t.signIn("subject-schemas");
    stranger = await t.signIn("subject-schemas-stranger");
  });
  after(async () => {
    await t.close();
  });

  const inject = (cookie: string | undefined, method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as "GET",
      url,
      headers: cookie ? { cookie } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it("GET /health answers without a session", async () => {
    const res = await inject(undefined, "GET", "/health");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '{"status":"ok"}');
  });

  describe("profiles", () => {
    it("a malformed body is 400 INVALID_REQUEST, even on another account's id; a well-formed one there is 404", async () => {
      const mine = (await inject(me, "POST", "/profiles", { name: "Mine", color: "rose" })).json().id as string;
      const bad = await inject(me, "PATCH", `/profiles/${mine}`, { name: 5 });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.body, '{"error":"INVALID_REQUEST"}');
      const foreignBad = await inject(stranger, "PATCH", `/profiles/${mine}`, { name: 5 });
      assert.equal(foreignBad.statusCode, 400);
      const foreign = await inject(stranger, "PATCH", `/profiles/${mine}`, { name: "Theirs" });
      assert.equal(foreign.statusCode, 404);
      assert.deepEqual(foreign.json(), { error: "NOT_FOUND" });
    });

    it("unknown preference keys survive a PATCH and a GET, nested ones included", async () => {
      const id = (await inject(me, "GET", "/profiles")).json()[0].id as string;
      const sent = { theme: "dark", fromANewerClient: { a: [1, 2] }, fontSettings: { size: 18, kerning: "tight" } };
      const patched = await inject(me, "PATCH", `/profiles/${id}/preferences`, sent);
      assert.equal(patched.statusCode, 200, patched.body);
      assert.deepEqual(patched.json(), sent);
      assert.deepEqual((await inject(me, "GET", `/profiles/${id}/preferences`)).json(), sent);
    });

    it("a stored value the response schema refuses is a 500 INTERNAL that names nothing", async () => {
      const id = (await inject(me, "POST", "/profiles", { name: "Odd", color: "sky" })).json().id as string;
      await knex("profiles").where({ id }).update({ color: "chartreuse" });
      try {
        const res = await inject(me, "GET", "/profiles");
        assert.equal(res.statusCode, 500);
        assert.equal(res.body, '{"error":"INTERNAL"}');
      } finally {
        await knex("profiles").where({ id }).update({ color: "sky" });
      }
    });
  });
});
