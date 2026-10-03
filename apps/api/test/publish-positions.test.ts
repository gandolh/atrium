import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 78 (brief 38 decisions 9 and 10): a published card opens on the latest
// version unless the reader explicitly opened an older one, and a new version
// starts at page 0. The client keeps the version a position was measured in, so
// the server releases positions on the version a publish supersedes.

const document = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe("publishing releases positions on the version it supersedes", () => {
  let t: TestApp;
  let cookie: string;
  let project: string;
  let book: string;

  const inject = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, extra: Record<string, unknown> = {}) =>
    t.app.inject({ method, url, ...extra, headers: { cookie, ...((extra.headers as object) ?? {}) } });
  const publish = async (body: string) => {
    await inject("PUT", `/latex/${project}/files/main.tex`, { headers: { "content-type": "text/plain" }, payload: document(body) });
    const res = await inject("POST", `/latex/${project}/publish`);
    assert.ok([200, 201].includes(res.statusCode), res.body);
    return res.json() as { book: { id: string }; version: { id: string } };
  };
  const readAt = (versionId: string, page: string) =>
    inject("PATCH", `/library/${book}/progress`, { payload: { progress: 0.5, locator: page, versionId } });
  const position = async () => {
    const versions = (await inject("GET", `/library/${book}/versions`)).json();
    const row = (await inject("GET", `/library/${book}`)).json();
    return { versionId: versions.currentVersionId as string | null, locator: row.locator as string | null };
  };

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("author", "subject-author");
    project = (await inject("POST", "/latex", { payload: { title: "Paper" } })).json().id;
  });
  after(async () => {
    await t.close();
  });

  it("a reader on the newest version resumes the next one at page 0", async () => {
    const first = await publish("One.");
    book = first.book.id;
    const v2 = (await publish("Two.")).version.id;
    assert.equal((await readAt(v2, "3")).statusCode, 200);
    assert.deepEqual(await position(), { versionId: v2, locator: "3" });

    await publish("Three.");
    assert.deepEqual(await position(), { versionId: null, locator: null });
  });

  it("a reader who explicitly opened an older version stays on it", async () => {
    const versions = (await inject("GET", `/library/${book}/versions`)).json().versions as { id: string }[];
    const oldest = versions[versions.length - 1].id;
    assert.equal((await readAt(oldest, "2")).statusCode, 200);

    await publish("Four.");
    assert.deepEqual(await position(), { versionId: oldest, locator: "2" });
  });
});
