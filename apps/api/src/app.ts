import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES } from "./common/config.js";
import { registerCatalogRoutes } from "./modules/catalog/catalog.controller.js";
import { registerJukeboxRoutes } from "./modules/jukebox/jukebox.controller.js";
import { registerLatexRoutes } from "./modules/latex/latex.controller.js";
import { registerLibraryRoutes } from "./modules/library/library.controller.js";
import { registerNotesRoutes } from "./modules/notes/notes.controller.js";
import { registerProfileRoutes } from "./modules/profiles/profiles.controller.js";
import { registerAuthGuard } from "./modules/auth/auth.guard.js";
import type { Accounts, WardClient } from "../vendor/ward/ward-auth.js";

/**
 * Build the Fastify instance: the auth guard, plugins, then every module's
 * routes.
 *
 * Separate from `index.ts` so that constructing the app and *running* it are
 * two different acts — `index.ts` owns the database bootstrap, the listen and
 * the shutdown handlers, and this owns what the app is made of. It is also what
 * makes the app reachable from `app.inject` without a process listening on a
 * port.
 *
 * Both options are the seam (brief 63). `index.ts` opens the accounts on the
 * real database and builds the Ward client from the environment; a test passes
 * accounts on its scratch database and, when it needs one, a Ward client over
 * a fake `fetch`. Without `wardClient` atrium has local accounts only.
 */
export async function buildApp(options: {
  accounts: Accounts;
  wardClient?: WardClient;
}): Promise<FastifyInstance> {
  /*
   * No `?token=` log redaction: no credential ever reaches a URL. Cover
   * `<img>` tags used to carry the session token in the query string, because
   * an `<img>` cannot send an `Authorization` header. The session is a cookie
   * scoped to the API prefix (D58), and every cover and media URL is built
   * under that prefix, so the browser attaches it on its own.
   */
  const app = Fastify({ logger: true });

  /**
   * One app-wide error handler (brief 73). Set before anything is registered,
   * so every route's handler, and every route-level `errorHandler` that passes
   * an error on with `reply.send(error)`, ends here.
   *
   * Fastify's default answers a 500 with the error's own `message`, and for a
   * Knex/SQLite error that is the **full SQL statement with its bound values**
   * (brief 54's regression run received one, Ward subject included). A server
   * error tells the client only that it happened; the real error goes to the
   * log with the request id. A 4xx raised by Fastify itself (bad JSON, a body
   * too large, an unsupported media type) describes the request, so it keeps
   * its status and message: passed on to Fastify's default handler unchanged.
   */
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.send(error);
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "INTERNAL" });
  });

  // The session guard (D58), first: the library's plugin, then atrium's
  // jukebox allowlist and active profile. Registered before every other plugin
  // and route, because Fastify copies hooks into a child context when the
  // child is created and anything registered earlier would not be guarded.
  // Atrium's rule that no route does its own auth survives the move.
  await registerAuthGuard(app, { accounts: options.accounts, wardClient: options.wardClient });

  // No CORS (brief 65). It was permissive (`origin: true`, every origin
  // reflected) from when the web client called the API cross-origin (D14).
  // Since D54 nothing does: the deploy and development both serve the API on
  // the page's own origin, so a browser needs no CORS header to read it, and
  // the empty allowlist is the honest one. Registering the plugin with
  // `credentials: true` as well would have made any site able to read a
  // signed-in person's library. If a cross-origin caller ever appears, add it
  // here by name; never reflect the request's origin.

  // 50MB (from MAX_UPLOAD_MB) upload ceiling (D15). @fastify/multipart truncates
  // past this; the routes inspect `file.truncated` and answer 413.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerLibraryRoutes(app);
  registerCatalogRoutes(app);
  registerNotesRoutes(app);
  registerProfileRoutes(app);
  registerLatexRoutes(app);
  registerJukeboxRoutes(app);

  return app;
}
