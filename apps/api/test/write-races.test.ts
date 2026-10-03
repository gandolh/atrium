import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { updateFolder } from "../src/modules/notes/notes.service.js";
import { getProfile } from "../src/modules/profiles/profiles.model.js";
import { writePreferences } from "../src/modules/profiles/profiles.service.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 68: two read-then-write paths the Knex move left racy (D47's bug
// class). The races call the service functions together, as the controller
// does, because through `app.inject` the guard's own queries stagger two
// requests enough to hide the overlap; two devices give no such guarantee.

describe("check-and-write races", () => {
  let t: TestApp;
  let cookie: string;
  let profileId: string;

  const inject = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const folder = async (name: string, parentId: string | null = null) => {
    const res = await inject("POST", "/note-folders", { name, parentId });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as string;
  };
  const parents = async () =>
    Object.fromEntries(
      ((await inject("GET", "/note-folders")).json() as { id: string; parentId: string | null }[]).map((f) => [
        f.id,
        f.parentId,
      ]),
    );

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("racer", "subject-racer");
    profileId = (await inject("GET", "/profiles")).json()[0].id;
  });
  after(async () => {
    await t.close();
  });

  it("opposite folder moves: exactly one wins, the other is a cycle, and the tree has none", async () => {
    const a = await folder("A");
    const b = await folder("B");
    const started = performance.now();
    const results = await Promise.all([
      updateFolder(profileId, a, { parentId: b }),
      updateFolder(profileId, b, { parentId: a }),
    ]);
    assert.ok(performance.now() - started < 5_000, "no wait on the pool");
    assert.deepEqual(
      results.map((r) => (r.ok ? "ok" : r.reason)).sort(),
      ["CYCLE", "ok"],
    );

    const tree = await parents();
    assert.ok(tree[a] === null || tree[b] === null, `cycle: ${JSON.stringify(tree)}`);
  });

  it("two preference writes with different keys, from one snapshot, both persist", async () => {
    // The controller reads the profile, then writes; two requests can both
    // read before either writes. Both calls get that same snapshot.
    const snapshot = (await getProfile(profileId))!;
    const started = performance.now();
    await Promise.all([
      writePreferences(snapshot, { theme: "dark" }),
      writePreferences(snapshot, { pageMode: "scroll" }),
    ]);
    assert.ok(performance.now() - started < 5_000, "no wait on the pool");

    const stored = (await inject("GET", `/profiles/${profileId}/preferences`)).json();
    assert.equal(stored.theme, "dark");
    assert.equal(stored.pageMode, "scroll");
  });

  it("existing folder behaviour holds: rename, move to root, no move into a descendant", async () => {
    const top = await folder("Top");
    const child = await folder("Child", top);

    const renamed = await inject("PATCH", `/note-folders/${child}`, { name: "Renamed" });
    assert.equal(renamed.json().name, "Renamed");

    const intoDescendant = await inject("PATCH", `/note-folders/${top}`, { parentId: child });
    assert.equal(intoDescendant.statusCode, 400);
    assert.equal((await parents())[top], null, "a refused move changes nothing");

    const refusedWithRename = await inject("PATCH", `/note-folders/${top}`, { name: "Nope", parentId: child });
    assert.equal(refusedWithRename.statusCode, 400);
    const names = (await inject("GET", "/note-folders")).json() as { id: string; name: string }[];
    assert.equal(names.find((f) => f.id === top)!.name, "Top", "a refused move renames nothing either");

    const toRoot = await inject("PATCH", `/note-folders/${child}`, { parentId: null });
    assert.equal(toRoot.statusCode, 200);
    assert.equal((await parents())[child], null);

    const missing = await inject("PATCH", `/note-folders/${child}`, { parentId: "no-such-folder" });
    assert.equal(missing.statusCode, 404);
  });

  it("a preference PATCH still merges one level deep and keeps unknown keys", async () => {
    await inject("PATCH", `/profiles/${profileId}/preferences`, { futureKey: { a: 1 } });
    await inject("PATCH", `/profiles/${profileId}/preferences`, { theme: "light" });
    const stored = (await inject("GET", `/profiles/${profileId}/preferences`)).json();
    assert.equal(stored.theme, "light");
    assert.equal(stored.pageMode, "scroll");
    assert.deepEqual(stored.futureKey, { a: 1 });
  });
});
