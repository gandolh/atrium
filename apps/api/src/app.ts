import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { healthRoutes } from "./features/health/index.js";
import { catalogRoutes } from "./features/catalog/index.js";
import { registerJukeboxRoutes } from "./features/jukebox/index.js";
import { registerLatexRoutes } from "./features/latex/index.js";
import { registerLibraryRoutes } from "./features/library/index.js";
import { lookupRoutes } from "./features/lookup/index.js";
import { notesRoutes } from "./features/notes/index.js";
import { profileRoutes } from "./features/profiles/index.js";
import { authGuard } from "./plugins/auth/index.js";
import { errors } from "./plugins/errors.js";
import { multipart } from "./plugins/multipart.js";
import type { Accounts, WardClient } from "../vendor/ward/ward-auth.js";

/**
 * Build the Fastify instance: the auth guard, plugins, then every module's
 * routes.
 *
 * Separate from `server.ts` so that constructing the app and *running* it are
 * two different acts — `server.ts` owns the database bootstrap, the listen and
 * the shutdown handlers, and this owns what the app is made of. It is also what
 * makes the app reachable from `app.inject` without a process listening on a
 * port.
 *
 * The first two options are the seam. `server.ts` opens the accounts on the
 * real database and builds the Ward client from the environment; a test passes
 * accounts on its scratch database and, when it needs one, a Ward client over
 * a fake `fetch`. Without `wardClient` atrium has local accounts only.
 */
export async function buildApp(options: {
  accounts: Accounts;
  wardClient?: WardClient;
  /** The process's server options: the logger, `trustProxy` and the timeouts (`server.ts`). Tests leave it out. */
  server?: FastifyServerOptions;
}): Promise<FastifyInstance> {
  /*
   * No `?token=` log redaction: no credential ever reaches a URL. Cover
   * `<img>` tags used to carry the session token in the query string, because
   * an `<img>` cannot send an `Authorization` header. The session is a cookie
   * scoped to the API prefix (D58), and every cover and media URL is built
   * under that prefix, so the browser attaches it on its own.
   */
  const app = Fastify({ logger: true, ...options.server });

  // The one error handler, first, so it covers everything registered after it.
  await app.register(errors);

  // Route schemas are zod, through the type provider: requests are decoded and
  // replies encoded with the route's schemas. Set on the root, so every scope
  // registered after it inherits them.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The session guard (D58), next: the library's plugin, then atrium's
  // jukebox allowlist and active profile. Registered before every other plugin
  // and route, because Fastify copies hooks into a child context when the
  // child is created and anything registered earlier would not be guarded.
  // Atrium's rule that no route does its own auth survives the move.
  await app.register(authGuard, { accounts: options.accounts, wardClient: options.wardClient });

  // No CORS. It was permissive (`origin: true`, every origin
  // reflected) from when the web client called the API cross-origin (D14).
  // Since D54 nothing does: the deploy and development both serve the API on
  // the page's own origin, so a browser needs no CORS header to read it, and
  // the empty allowlist is the honest one. Registering the plugin with
  // `credentials: true` as well would have made any site able to read a
  // signed-in person's library. If a cross-origin caller ever appears, add it
  // here by name; never reflect the request's origin.

  // Uploads: one file, up to MAX_UPLOAD_MB (D15).
  await app.register(multipart);

  await app.register(healthRoutes);
  registerLibraryRoutes(app);
  await app.register(catalogRoutes);
  await app.register(notesRoutes);
  await app.register(profileRoutes);
  registerLatexRoutes(app);
  registerJukeboxRoutes(app);
  await app.register(lookupRoutes);

  return app;
}
