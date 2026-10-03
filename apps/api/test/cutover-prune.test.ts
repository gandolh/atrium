import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { LIBRARY_FILES_DIR } from "../src/common/config.js";
import { filePathFor } from "../src/common/paths.js";
import { runMigrations } from "../src/database/bootstrap.js";
import { closeDatabase, knex } from "../src/database/knex.js";
import { migrationSource } from "../src/database/migrations/index.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 60: the Ward cutover dropped `profiles` with foreign keys off, so no
// ON DELETE fired and every profile-scoped row survived as an orphan. The prune
// migration deletes them. This file's database starts PRE-cutover, with one
// household's data in it, and is walked forward one migration at a time.

const options = { migrationSource, tableName: "knex_migrations", disableTransactions: true };
const now = new Date().toISOString();
const scoped = ["reading_progress", "notes", "note_folders", "latex_projects"];

const count = async (table: string) => Number((await knex(table).count({ n: "*" }))[0].n);

describe("the cutover's orphans are pruned", () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  let t: TestApp;

  before(async () => {
    // The baseline alone: the schema as it stood before Ward.
    await knex.migrate.up(options);

    await knex("users").insert({ id: "u1", username: "household", password_hash: "x", created_at: now });
    await knex("profiles").insert({ id: "p1", user_id: "u1", name: "Default", color: "cream", created_at: now });
    await knex("books").insert([
      { id: "b1", title: "Read", format: "pdf", size_bytes: 4, created_at: now, source: "upload" },
      // The book a pre-cutover LaTeX project published (D37).
      { id: "b2", title: "Published", format: "pdf", size_bytes: 4, created_at: now, source: "latex" },
    ]);
    await knex("document_versions").insert({ id: "v1", book_id: "b2", version_no: 1, published_at: now });
    await knex("reading_progress").insert({ profile_id: "p1", book_id: "b1", progress: 0.5, updated_at: now });
    await knex("note_folders").insert({ id: "f1", profile_id: "p1", name: "Folder", created_at: now });
    await knex("notes").insert({
      id: "n1",
      profile_id: "p1",
      folder_id: "f1",
      title: "Note",
      data: "{}",
      created_at: now,
      updated_at: now,
    });
    await knex("latex_projects").insert({
      id: "orphan-project",
      profile_id: "p1",
      title: "Draft",
      published_book_id: "b2",
      created_at: now,
      updated_at: now,
    });
    mkdirSync(LIBRARY_FILES_DIR, { recursive: true });
    writeFileSync(filePathFor("b2", "pdf"), "%PDF");
  });
  after(async () => {
    console.warn = realWarn;
    // `t.close()` also closes the database; without a `t` (an earlier failure)
    // the pool must still be closed or the process never exits.
    if (t) await t.close();
    else await closeDatabase();
  });

  it("the cutover alone leaves every child row orphaned", async () => {
    await knex.migrate.up(options); // 20260906000000-ward-cutover
    for (const table of scoped) assert.equal(await count(table), 1, table);
    const violations = (await knex.raw("PRAGMA foreign_key_check")) as unknown[];
    assert.equal(violations.length, 4, JSON.stringify(violations));
  });

  it("the prune deletes them, logs the project, and leaves the database clean", async () => {
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    await runMigrations();
    console.warn = realWarn;

    for (const table of scoped) assert.equal(await count(table), 0, table);
    assert.deepEqual(await knex.raw("PRAGMA foreign_key_check"), []);
    assert.ok(
      warnings.some((w) => w.includes("orphan-project")),
      `project id not logged: ${JSON.stringify(warnings)}`,
    );
  });

  it("the published book and its version survive, and it still opens", async () => {
    assert.equal(await count("books"), 2);
    assert.equal(await count("document_versions"), 1);

    t = await buildTestApp();
    const cookie = t.ward.signIn("after", "subject-after");
    const res = await t.app.inject({ method: "GET", url: "/library/b2/file", headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, "%PDF");
  });

  it("running again is a no-op", async () => {
    warnings.length = 0;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    await knex.migrate.up(options).catch(() => undefined); // nothing pending
    console.warn = realWarn;
    const { up } = await import("../src/database/migrations/20260925000000-prune-cutover-orphans.js");
    await up(knex);
    assert.deepEqual(warnings, []);
    assert.deepEqual(await knex.raw("PRAGMA foreign_key_check"), []);
  });
});
