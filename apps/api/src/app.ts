import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES } from "./common/config.js";
import { registerCatalogRoutes } from "./modules/catalog/catalog.controller.js";
import { registerLatexRoutes } from "./modules/latex/latex.controller.js";
import { registerLibraryRoutes } from "./modules/library/library.controller.js";
import { registerNotesRoutes } from "./modules/notes/notes.controller.js";
import { registerProfileRoutes } from "./modules/profiles/profiles.controller.js";
import { registerWardGuard } from "./modules/ward/ward.guard.js";

/**
 * Build the Fastify instance: plugins, the Ward guard, then every module's
 * routes.
 *
 * Separate from `index.ts` so that constructing the app and *running* it are
 * two different acts — `index.ts` owns the database bootstrap, the listen and
 * the shutdown handlers, and this owns what the app is made of. It is also what
 * makes the app reachable from `app.inject` without a process listening on a
 * port.
 */
export async function buildApp(): Promise<FastifyInstance> {
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

  // Permissive CORS — single-user tool, web talks cross-origin via VITE_API_URL
  // (D14; no Vite proxy). Enumerate methods so the library routes' PATCH/DELETE
  // (with a JSON body → preflighted) aren't blocked; the default allowlist omits
  // PATCH. PUT joins it for brief 38's file-write route (`PUT /latex/:id/files/*`),
  // which is likewise preflighted and would otherwise be blocked in the browser
  // while working perfectly under `app.inject`.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // 50MB (from MAX_UPLOAD_MB) upload ceiling (D15). @fastify/multipart truncates
  // past this; the routes inspect `file.truncated` and answer 413.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // The Ward session guard. Registered app-wide BEFORE the routes so every
  // non-allowlisted request has an authenticated caller holding an atrium
  // grant. Atrium's rule that no route does its own auth survives the move.
  registerWardGuard(app);

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
