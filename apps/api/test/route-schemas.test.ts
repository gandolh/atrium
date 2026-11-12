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

  describe("notes", () => {
    it("a field the store holds and the schema doesn't name is stripped from the reply", async () => {
      const id = (await inject(me, "POST", "/notes", { title: "Stray" })).json().id as string;
      await knex("notes")
        .where({ id })
        .update({ data: JSON.stringify([{ strokes: [], texts: [], template: "grid", stray: "from an old client" }]) });
      const res = await inject(me, "GET", `/notes/${id}`);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().pages, [{ strokes: [], texts: [], template: "grid" }]);
      assert.ok(!res.body.includes("stray"), res.body);
    });

    it("a page stored without a template, or with an unknown tool, reads back as the hand parse made it", async () => {
      const id = (await inject(me, "POST", "/notes", {})).json().id as string;
      const stroke = { tool: "crayon", color: "#000", size: 0.01, points: [[1, 2, 0.5]] };
      await knex("notes")
        .where({ id })
        .update({ data: JSON.stringify([{ strokes: [stroke], texts: [] }]) });
      assert.deepEqual((await inject(me, "GET", `/notes/${id}`)).json().pages, [
        { strokes: [{ ...stroke, tool: "pen" }], texts: [], template: "blank" },
      ]);
    });

    it("a malformed body, query or param answers 400 INVALID_REQUEST; another profile's note is 404", async () => {
      const id = (await inject(me, "POST", "/notes")).json().id as string;
      const badBody = await inject(me, "PATCH", `/notes/${id}`, { pages: "not pages" });
      assert.equal(badBody.statusCode, 400);
      assert.equal(badBody.body, '{"error":"INVALID_REQUEST"}');
      const badQuery = await inject(me, "DELETE", `/profiles/${id}?reassign=1&reassign=2`);
      assert.equal(badQuery.statusCode, 404, "a repeated reassign is not a 400: it reads as no");
      const badParam = await inject(me, "GET", "/jukebox/players/not-a-snowflake");
      assert.equal(badParam.statusCode, 400);
      assert.equal(badParam.body, '{"error":"INVALID_REQUEST"}');
      const foreign = await inject(stranger, "GET", `/notes/${id}`);
      assert.equal(foreign.statusCode, 404);
      assert.deepEqual(foreign.json(), { error: "NOT_FOUND" });
      const foreignBad = await inject(stranger, "PATCH", `/notes/${id}`, { title: 5 });
      assert.equal(foreignBad.statusCode, 400);
    });
  });

  describe("catalog", () => {
    it("a request that fails its schema keeps the sentence the route always sent", async () => {
      const query = await inject(me, "GET", "/catalog/gutenberg?page=0");
      assert.equal(query.statusCode, 400);
      assert.deepEqual(query.json(), { error: "Invalid catalog query." });
      const body = await inject(me, "POST", "/library/import", { gutenbergId: "eleven" });
      assert.equal(body.statusCode, 400);
      assert.deepEqual(body.json(), { error: "gutenbergId must be a positive integer." });
    });

    it("bad JSON past a route's own error handler is still Fastify's 400, whole", async () => {
      const res = await t.app.inject({
        method: "POST",
        url: "/library/import",
        headers: { cookie: me, "content-type": "application/json" },
        payload: "{nope",
      });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(Object.keys(res.json()), ["statusCode", "code", "error", "message"]);
      assert.equal(res.json().code, "FST_ERR_CTP_INVALID_JSON_BODY");
    });
  });

  describe("jukebox", () => {
    it("a stored command's stray key never reaches the bot, and the rest keeps its byte order", async () => {
      const bot = await t.signIn("subject-schemas-bot", "jukebox");
      const voice = { id: "200000000000000042", name: "General" };
      const status = { guildId: "100000000000000042", guildName: "Guild", voiceChannel: voice, voiceChannels: [voice] };
      await inject(bot, "POST", "/jukebox/bot/status", { ...status, playId: 0, state: "idle", positionMs: 0 });
      const first = (await inject(bot, "GET", "/jukebox/bot/commands")).json() as { cursor: number };
      await knex("jukebox_commands").insert({
        guild_id: "100000000000000042",
        body: JSON.stringify({ kind: "join", channelId: "200000000000000042", debug: "server-side note" }),
        created_at: new Date().toISOString(),
      });
      const res = await inject(bot, "GET", `/jukebox/bot/commands?after=${first.cursor}`);
      assert.equal(res.statusCode, 200);
      assert.equal(
        res.body,
        `{"cursor":${first.cursor + 1},"commands":[{"kind":"join","channelId":"200000000000000042","id":${first.cursor + 1},"guildId":"100000000000000042"}]}`,
      );
    });

    it("a person on a bot route is refused before the request is validated", async () => {
      const res = await inject(me, "POST", "/jukebox/bot/players/not-a-snowflake/advance", {});
      assert.equal(res.statusCode, 403);
      assert.equal(res.body, '{"error":"JUKEBOX_BOT_ONLY"}');
    });
  });
});
