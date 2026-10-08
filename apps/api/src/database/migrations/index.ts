import type { Knex } from "knex";
import * as baseline from "./20260830000000-baseline.js";
import * as wardCutover from "./20260906000000-ward-cutover.js";
import * as pruneCutoverOrphans from "./20260925000000-prune-cutover-orphans.js";
import * as jukebox from "./20261008000000-jukebox.js";

/**
 * The migration list, as **static imports** rather than a directory Knex scans.
 *
 * Knex's default `directory:` migration source reads files off disk at runtime
 * and picks a loader by file extension. That does not survive this app's build:
 * in dev the migrations are `.ts` executed by tsx, in production they are `.js`
 * under `dist/`, and `tsc` does not copy `.ts` sources into the output — so a
 * directory scan finds a different set of files (or none) depending on how the
 * process was started. Listing them here means the compiler resolves them, they
 * are bundled into `dist` like any other module, and dev and production run
 * byte-identical migration code.
 *
 * **Adding a migration:** create the file beside this one, named
 * `<UTC timestamp>-<slug>.ts`, and append it to `MIGRATIONS` below. Order in
 * this array IS the run order — `getMigrations` returns it as given, so a new
 * migration goes at the END. Never reorder or renumber existing entries: Knex
 * records the name in `knex_migrations`, so a rename re-runs a migration that
 * has already been applied.
 */

interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

const MIGRATIONS: Migration[] = [
  { name: "20260830000000-baseline", up: baseline.up, down: baseline.down },
  { name: "20260906000000-ward-cutover", up: wardCutover.up, down: wardCutover.down },
  { name: "20260925000000-prune-cutover-orphans", up: pruneCutoverOrphans.up, down: pruneCutoverOrphans.down },
  { name: "20261008000000-jukebox", up: jukebox.up, down: jukebox.down },
];

/**
 * A Knex `migrationSource` backed by the array above. The three methods are the
 * whole interface Knex asks for; `getMigrations` is deliberately not sorted, so
 * the array's order is the contract.
 */
export const migrationSource: Knex.MigrationSource<Migration> = {
  async getMigrations(): Promise<Migration[]> {
    return MIGRATIONS;
  },
  getMigrationName(migration: Migration): string {
    return migration.name;
  },
  async getMigration(migration: Migration): Promise<Knex.Migration> {
    return { up: migration.up, down: migration.down };
  },
};
