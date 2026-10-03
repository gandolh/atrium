import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NOTE_MAX_BYTES } from "../src/common/config.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 56: every autosave carries the whole notebook, and the notes routes ran
// on Fastify's 1 MiB default, so a well-used notebook would start failing every
// save. A note past 1 MiB must save; one past the cap must be refused with a
// code the editor can name.
describe("note body size", () => {
  let t: TestApp;
  let owner: string;
  let id: string;

  /** A page of `strokes` strokes of `perStroke` full-precision points each. */
  const page = (strokes: number, perStroke: number) => ({
    template: "blank",
    texts: [],
    strokes: Array.from({ length: strokes }, (_, s) => ({
      tool: "pen",
      color: "#1f2937",
      size: 0.004,
      points: Array.from({ length: perStroke }, (_, p) => [
        (s * perStroke + p) / (strokes * perStroke) + Math.random() * 1e-6,
        Math.random(),
        Math.random(),
      ]),
    })),
  });

  const patch = (payload: string) =>
    t.app.inject({
      method: "PATCH",
      url: `/notes/${id}`,
      headers: { cookie: owner, "content-type": "application/json" },
      payload,
    });

  before(async () => {
    t = await buildTestApp();
    owner = t.ward.signIn("owner", "subject-owner");
    const res = await t.app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie: owner },
      payload: { title: "Big" },
    });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().id;
  });
  after(async () => {
    await t.close();
  });

  it("a note past Fastify's 1 MiB default saves, and reads back whole", async () => {
    const body = JSON.stringify({ pages: [page(1000, 30)] }); // 30,000 points
    assert.ok(body.length > 1024 * 1024, `fixture is only ${body.length} bytes`);

    const res = await patch(body);
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));

    const read = await t.app.inject({ method: "GET", url: `/notes/${id}`, headers: { cookie: owner } });
    assert.equal(read.statusCode, 200);
    const points = read.json().pages[0].strokes.reduce((n: number, s: { points: unknown[] }) => n + s.points.length, 0);
    assert.equal(points, 30_000);
  });

  it("past the cap answers 413 NOTE_TOO_LARGE", async () => {
    const pad = "x".repeat(NOTE_MAX_BYTES + 1);
    const res = await patch(JSON.stringify({ title: pad }));
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { error: "NOTE_TOO_LARGE" });
  });

  it("POST /notes has the same cap", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie: owner, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x".repeat(NOTE_MAX_BYTES + 1) }),
    });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { error: "NOTE_TOO_LARGE" });
  });
});
