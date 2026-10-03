import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coverPathFor } from "../src/common/paths.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 62: the newest file's ETag was the book id, and a published document's
// newest bytes are copied OVER the same path on every publish, so a browser
// revalidating after a re-publish got a 304 and showed v1 labelled as v2. Covers
// were `public, immutable` for a year under a URL that never changed, though a
// re-publish and D40's setter both rewrite them in place.

const document = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a re-published document and a replaced cover are never served stale", () => {
  let t: TestApp;
  let cookie: string;
  let project: string;
  let book: string;
  let v1Bytes: Buffer;
  let v1Tag: string;
  let v2: string;

  const inject = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, extra: object = {}) =>
    t.app.inject({ method, url, ...extra, headers: { cookie, ...(extra as { headers?: object }).headers } });

  const writeMain = (body: string) =>
    inject("PUT", `/latex/${project}/files/main.tex`, {
      headers: { "content-type": "text/plain" },
      payload: document(body),
    });

  const publish = async () => {
    const res = await inject("POST", `/latex/${project}/publish`);
    assert.ok([200, 201].includes(res.statusCode), res.body);
    return res.json() as { book: { id: string }; version: { id: string } };
  };

  const coverVersion = async () => {
    const res = await inject("GET", `/library/${book}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().coverVersion as number | null;
  };

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("author", "subject-author");
    const created = await inject("POST", "/latex", { payload: { title: "Paper" } });
    assert.equal(created.statusCode, 201, created.body);
    project = created.json().id;
    assert.equal((await writeMain("First edition.")).statusCode, 200);
    book = (await publish()).book.id;
  });
  after(async () => {
    await t.close();
  });

  it("an unchanged book still revalidates to a 304", async () => {
    const first = await inject("GET", `/library/${book}/file`);
    assert.equal(first.statusCode, 200);
    v1Tag = String(first.headers.etag);
    v1Bytes = first.rawPayload;
    assert.match(v1Tag, /^W\/"\d+-\d+"$/);
    assert.equal(first.headers["cache-control"], "private, no-cache");

    const again = await inject("GET", `/library/${book}/file`, { headers: { "if-none-match": v1Tag } });
    assert.equal(again.statusCode, 304);
  });

  it("after a re-publish, the old validator gets v2's bytes, not a 304", async () => {
    await sleep(20); // a distinct mtime even where sizes happened to match
    assert.equal((await writeMain("Second edition, with a good deal more text on its first page.")).statusCode, 200);
    v2 = (await publish()).version.id;

    const res = await inject("GET", `/library/${book}/file`, { headers: { "if-none-match": v1Tag } });
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.headers.etag, v1Tag);
    assert.notDeepEqual(res.rawPayload, v1Bytes);

    const pinned = await inject("GET", `/library/${book}/file?version=${v2}`);
    assert.equal(pinned.headers.etag, `"${v2}"`, "a version keeps its immutable id validator");
    assert.deepEqual(res.rawPayload, pinned.rawPayload);
  });

  it("deleting the newest version serves v1's bytes again", async () => {
    const current = String((await inject("GET", `/library/${book}/file`)).headers.etag);
    await sleep(20);
    const deleted = await inject("DELETE", `/library/${book}/versions/${v2}`);
    assert.ok([200, 204].includes(deleted.statusCode), deleted.body);

    const res = await inject("GET", `/library/${book}/file`, { headers: { "if-none-match": current } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, v1Bytes);
  });

  it("covers are private, immutable only under a versioned URL, and revalidated otherwise", async () => {
    const version = await coverVersion();
    assert.ok(version !== null, "publishing writes a cover");

    const versioned = await inject("GET", `/library/${book}/cover?v=${version}`);
    assert.equal(versioned.statusCode, 200);
    assert.equal(versioned.headers["cache-control"], "private, max-age=31536000, immutable");

    const plain = await inject("GET", `/library/${book}/cover`);
    assert.equal(plain.headers["cache-control"], "private, no-cache");
    const revalidated = await inject("GET", `/library/${book}/cover`, {
      headers: { "if-none-match": String(plain.headers.etag) },
    });
    assert.equal(revalidated.statusCode, 304);
  });

  it("replacing a cover changes its version, so the grid asks for a new URL", async () => {
    const before = await coverVersion();
    await sleep(20);
    const jpeg = readFileSync(coverPathFor(book));
    const boundary = "----covertest";
    const res = await inject("POST", `/library/${book}/cover`, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="frame.jpg"\r\n` +
            `Content-Type: image/jpeg\r\n\r\n`,
        ),
        jpeg,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(res.statusCode, 200, res.body);
    const after = await coverVersion();
    assert.ok(after !== null && after !== before, `cover version did not move: ${before} -> ${after}`);
  });
});
