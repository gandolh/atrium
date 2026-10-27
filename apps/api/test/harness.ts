import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { initDatabase } from "../src/database/bootstrap.js";
import { closeDatabase } from "../src/database/knex.js";
import { MEMBER_ROLE, SESSION_COOKIE } from "../src/modules/auth/auth.guard.js";
import type { Accounts, WardClient } from "../vendor/ward/ward-auth.js";

export interface TestApp {
  app: FastifyInstance;
  accounts: Accounts;
  /**
   * A local account `id` (created on first use, with `role`) and a fresh
   * session for it: the `cookie` header value that authenticates as it. The
   * id doubles as the username. Every call is a new session, so a new device.
   */
  signIn: (id: string, role?: string) => Promise<string>;
  /** Close the app and the database. Without it the knex pool keeps the test process alive. */
  close: () => Promise<void>;
}

/**
 * The app on this process's scratch database, migrated, with local accounts
 * and no Ward unless a test passes a client. Each test file is its own process
 * (`node --test`), so each file owns its database; call this once per file.
 */
export async function buildTestApp(options: { wardClient?: WardClient } = {}): Promise<TestApp> {
  const { accounts } = await initDatabase();
  const app = await buildApp({ accounts, wardClient: options.wardClient });
  // The production logger is on; a test run does not need every request.
  app.log.level = "silent";
  await app.ready();
  return {
    app,
    accounts,
    signIn: async (id, role = MEMBER_ROLE) => {
      if (!(await accounts.findUserById(id))) {
        await accounts.createUser({ id, username: id, role });
      }
      const { token } = await accounts.startSession(id);
      return `${SESSION_COOKIE}=${token}`;
    },
    close: async () => {
      await app.close();
      await closeDatabase();
    },
  };
}
