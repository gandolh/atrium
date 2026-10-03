import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { initDatabase } from "../src/database/bootstrap.js";
import { closeDatabase, knex } from "../src/database/knex.js";
import { FakeWard } from "./fake-ward.js";

// Brief 73: Fastify's default answered a 500 with the error's message, which
// for a Knex/SQLite error is the whole SQL statement with its bound values.
const SQL_MESSAGE =
  "select `lp`.* from `latex_projects` as `lp` where `p`.`user_id` = 'subject-owner' - no such column: p.user_id";

describe("a 500 does not send the error's message", () => {
  let app: FastifyInstance;
  let cookie: string;

  before(async () => {
    await initDatabase();
    const ward = new FakeWard();
    cookie = ward.signIn("owner", "subject-owner");
    app = await buildApp({ wardClient: ward });
    app.log.level = "silent";
    app.get("/test/boom", async () => {
      throw Object.assign(new Error(SQL_MESSAGE), { code: "SQLITE_ERROR" });
    });
    await app.ready();
  });
  after(async () => {
    await app.close();
    await closeDatabase();
  });

  it("an uncaught error answers 500 INTERNAL, with no SQL in the body", async () => {
    const res = await app.inject({ method: "GET", url: "/test/boom", headers: { cookie } });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "INTERNAL" });
    assert.ok(!res.body.includes("select"), res.body);
  });

  it("a real SQLite failure behind a route-level error handler is hidden too", async () => {
    const created = await app.inject({ method: "POST", url: "/notes", headers: { cookie }, payload: { title: "N" } });
    assert.equal(created.statusCode, 201, created.body);
    await knex.raw(
      "CREATE TRIGGER fail_note_update BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'forced: update notes set data = ?'); END",
    );
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/notes/${created.json().id}`,
        headers: { cookie },
        payload: { title: "Renamed" },
      });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: "INTERNAL" });
    } finally {
      await knex.raw("DROP TRIGGER IF EXISTS fail_note_update");
    }
  });

  it("a malformed JSON body still answers 400 with Fastify's own message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie, "content-type": "application/json" },
      payload: "{not json",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "FST_ERR_CTP_INVALID_JSON_BODY");
  });

  it("a route's own 413 still answers with its code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x".repeat(17 * 1024 * 1024) }),
    });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { error: "NOTE_TOO_LARGE" });
  });
});
