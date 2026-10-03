import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES } from "./common/config.js";
import { registerCatalogRoutes } from "./modules/catalog/catalog.controller.js";
import { registerLatexRoutes } from "./modules/latex/latex.controller.js";
import { registerLibraryRoutes } from "./modules/library/library.controller.js";
import { registerNotesRoutes } from "./modules/notes/notes.controller.js";
import { registerProfileRoutes } from "./modules/profiles/profiles.controller.js";
import { registerWardGuard } from "./modules/ward/ward.guard.js";
import type { WardClient } from "./modules/ward/ward.client.js";

/**
 * Build the Fastify instance: plugins, the Ward guard, then every module's
 * routes.
 *
 * Separate from `index.ts` so that constructing the app and *running* it are
 * two different acts — `index.ts` owns the database bootstrap, the listen and
 * the shutdown handlers, and this owns what the app is made of. It is also what
 * makes the app reachable from `app.inject` without a process listening on a
 * port.
 *
 * `wardClient` is the test seam (brief 63): a test injects a scripted client,
 * and production omits it so the guard builds one from the environment.
 */
export async function buildApp(options: { wardClient?: WardClient } = {}): Promise<FastifyInstance> {
  /*
   * The `?token=` log redaction is gone with the fallback it protected.
   *
   * Cover-image `<img>` tags used to carry the session token in the query
   * string, because an `<img>` cannot send an `Authorization` header — so every
   * request URL was a potential credential and the serialiser scrubbed it.
   * Ward's cookie is `Path=/` on the shared origin and the browser attaches it
   * to an image request without being asked, so no token reaches a URL any
   * more and there is nothing left to redact.
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

  // No CORS (brief 65). It was permissive (`origin: true`, every origin
  // reflected) from when the web client called the API cross-origin (D14).
  // Since D54 nothing does: the deploy and development both serve the API on
  // the page's own origin, so a browser needs no CORS header to read it, and
  // the empty allowlist is the honest one. Registering the plugin with
  // `credentials: true` as well would have made any site able to read a
  // signed-in person's library for as long as Ward's cookie stays
  // `SameSite=Lax`, which atrium does not control. If a cross-origin caller
  // ever appears, add it here by name; never reflect the request's origin.

  // 50MB (from MAX_UPLOAD_MB) upload ceiling (D15). @fastify/multipart truncates
  // past this; the routes inspect `file.truncated` and answer 413.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // The Ward session guard. Registered app-wide BEFORE the routes so every
  // non-allowlisted request has an authenticated caller holding an atrium
  // grant. Atrium's rule that no route does its own auth survives the move.
  registerWardGuard(app, { client: options.wardClient });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerLibraryRoutes(app);
  registerCatalogRoutes(app);
  registerNotesRoutes(app);
  registerProfileRoutes(app);
  registerLatexRoutes(app);

  return app;
}
