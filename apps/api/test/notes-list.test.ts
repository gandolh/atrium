import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { knex } from "../src/database/knex.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 66: `GET /notes` selected every column, ink included, and JSON-parsed
// each notebook only to count its pages; the profile-delete checks reused the
// same query to count notes. The list now counts pages in SQL, and the checks
// call a count.

const page = { strokes: [], texts: [], template: "blank" };

describe("the notes list never loads the ink", () => {
  let t: TestApp;
  let cookie: string;
  let profileId: string;
  const sql: string[] = [];
  const record = (q: { sql: string }) => void sql.push(q.sql);

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("writer", "subject-writer");
    const profiles = await t.app.inject({ method: "GET", url: "/profiles", headers: { cookie } });
    profileId = profiles.json()[0].id;

    const post = async (title: string) =>
      (await t.app.inject({ method: "POST", url: "/notes", headers: { cookie }, payload: { title } })).json().id;
    const three = await post("Three pages");
    await t.app.inject({
      method: "PATCH",
      url: `/notes/${three}`,
      headers: { cookie },
      payload: { pages: [page, page, page] },
    });
    await post("One page");
    // Stored data the app would never write, which `parsePages` reads as zero pages.
    const at = "2026-01-01T00:00:00.000Z";
    await knex("notes").insert([
      { id: "malformed", profile_id: profileId, title: "Malformed", data: "{not json", created_at: at, updated_at: at },
      { id: "object", profile_id: profileId, title: "Object", data: '{"pages":[1,2]}', created_at: at, updated_at: at },
    ]);
  });
  after(async () => {
    await t.close();
  });

  it("lists every note with the same page counts, without selecting `data`", async () => {
    knex.on("query", record);
    const res = await t.app.inject({ method: "GET", url: "/notes", headers: { cookie } });
    knex.off("query", record);
    assert.equal(res.statusCode, 200);
    if (process.env.NOTES_LIST_DUMP) writeFileSync(process.env.NOTES_LIST_DUMP, res.body);

    const counts = Object.fromEntries(
      (res.json() as { title: string; pageCount: number }[]).map((n) => [n.title, n.pageCount]),
    );
    assert.deepEqual(counts, { "Three pages": 3, "One page": 1, Malformed: 0, Object: 0 });

    const list = sql.filter((q) => /from [`"]notes[`"]/i.test(q));
    assert.ok(list.length > 0, `no notes query seen: ${JSON.stringify(sql)}`);
    for (const q of list) {
      assert.ok(!/select \*|[`"]data[`"],|[`".]data[`"] from/i.test(q.replace(/json_\w+\([`"]?data[`"]?\)/gi, "")), q);
    }
  });

  it("a profile with notes refuses deletion with its note count; an empty one deletes", async () => {
    const create = async (name: string) => {
      const res = await t.app.inject({ method: "POST", url: "/profiles", headers: { cookie }, payload: { name, color: "rose" } });
      assert.equal(res.statusCode, 201, res.body);
      return res.json().id as string;
    };
    const withNotes = await create("Has notes");
    const at = "2026-01-01T00:00:00.000Z";
    await knex("notes").insert(
      [1, 2].map((n) => ({ id: `theirs-${n}`, profile_id: withNotes, title: `N${n}`, data: "[]", created_at: at, updated_at: at })),
    );
    const refused = await t.app.inject({ method: "DELETE", url: `/profiles/${withNotes}`, headers: { cookie } });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().noteCount, 2);

    const empty = await create("Empty");
    const deleted = await t.app.inject({ method: "DELETE", url: `/profiles/${empty}`, headers: { cookie } });
    assert.ok([200, 204].includes(deleted.statusCode), deleted.body);
  });
});
