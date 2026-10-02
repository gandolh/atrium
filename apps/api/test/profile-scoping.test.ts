import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./harness.js";

// Another account's ids answer 404, never 403: a 403 would confirm the id
// exists (api-layering.md).
describe("profile scoping", () => {
  let t: TestApp;
  let owner: string;
  let stranger: string;
  const ids = { note: "", folder: "", latex: "" };

  before(async () => {
    t = await buildTestApp();
    owner = t.ward.signIn("owner", "subject-owner");
    stranger = t.ward.signIn("stranger", "subject-stranger");

    const post = async (url: string, payload: object) => {
      const res = await t.app.inject({ method: "POST", url, headers: { cookie: owner }, payload });
      assert.equal(res.statusCode, 201, `${url}: ${res.body}`);
      return res.json().id as string;
    };
    ids.note = await post("/notes", { title: "Private" });
    ids.folder = await post("/note-folders", { name: "Private folder" });
    ids.latex = await post("/latex", { title: "Private paper" });
  });
  after(async () => {
    await t.close();
  });

  it("the owner can read their own note and project", async () => {
    for (const url of [`/notes/${ids.note}`, `/latex/${ids.latex}`]) {
      const res = await t.app.inject({ method: "GET", url, headers: { cookie: owner } });
      assert.equal(res.statusCode, 200, url);
    }
  });

  it("another subject's note is 404", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/notes/${ids.note}`,
      headers: { cookie: stranger },
    });
    assert.equal(res.statusCode, 404);
  });

  it("another subject's folder is 404", async () => {
    const res = await t.app.inject({
      method: "PATCH",
      url: `/note-folders/${ids.folder}`,
      headers: { cookie: stranger },
      payload: { name: "Renamed" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("another subject's LaTeX project is 404", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/latex/${ids.latex}`,
      headers: { cookie: stranger },
    });
    assert.equal(res.statusCode, 404);
  });
});
