import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { initDatabase } from "../src/database/bootstrap.js";
import { closeDatabase } from "../src/database/knex.js";
import { FakeWard } from "./fake-ward.js";

export interface TestApp {
  app: FastifyInstance;
  ward: FakeWard;
  /** Close the app and the database. Without it the knex pool keeps the test process alive. */
  close: () => Promise<void>;
}

/**
 * The app on this process's scratch database, migrated, with a scripted Ward.
 * Each test file is its own process (`node --test`), so each file owns its
 * database; call this once per file.
 */
export async function buildTestApp(): Promise<TestApp> {
  await initDatabase();
  const ward = new FakeWard();
  const app = await buildApp({ wardClient: ward });
  // The production logger is on; a test run does not need every request.
  app.log.level = "silent";
  await app.ready();
  return {
    app,
    ward,
    close: async () => {
      await app.close();
      await closeDatabase();
    },
  };
}
