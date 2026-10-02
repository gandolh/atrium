import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DB_PATH } from "../src/common/config.js";
import { runMigrations } from "../src/database/bootstrap.js";
import { closeDatabase, knex } from "../src/database/knex.js";

describe("migrations", () => {
  it("a fresh database migrates, re-runs as a no-op, and has no foreign-key violations", async () => {
    await runMigrations();
    assert.equal(existsSync(DB_PATH), true); // in the scratch root setup.ts proved
    await runMigrations();
    const violations = await knex.raw("PRAGMA foreign_key_check");
    assert.deepEqual(violations, []);
    await closeDatabase();
  });
});
