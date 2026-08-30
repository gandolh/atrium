import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES } from "./common/config.js";
import { registerAuthRoutes } from "./modules/auth/auth.controller.js";
import { registerAuthGuard } from "./modules/auth/auth.guard.js";
import { registerCatalogRoutes } from "./modules/catalog/catalog.controller.js";
import { registerLatexRoutes } from "./modules/latex/latex.controller.js";
import { registerLibraryRoutes } from "./modules/library/library.controller.js";
import { registerNotesRoutes } from "./modules/notes/notes.controller.js";
import { registerProfileRoutes } from "./modules/profiles/profiles.controller.js";

/**
 * Build the Fastify instance: plugins, the auth guard, then every module's
 * routes.
 *
 * Separate from `index.ts` so that constructing the app and *running* it are
 * two different acts — `index.ts` owns the database bootstrap, the listen and
 * the shutdown handlers, and this owns what the app is made of. It is also what
 * makes the app reachable from `app.inject` without a process listening on a
 * port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      serializers: {
        // Cover-image <img> tags carry the session token as ?token= (they
        // cannot send headers) — it must never reach logs in plaintext.
        req(request) {
          return {
            method: request.method,
            url: request.url.replace(/([?&]token=)[^&]*/g, "$1[redacted]"),
            host: request.headers?.host,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
  });

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

  // Per-user session guard. Registered app-wide BEFORE the routes so every
  // non-allowlisted request must present a valid session token.
  registerAuthGuard(app);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerAuthRoutes(app);
  registerLibraryRoutes(app);
  registerCatalogRoutes(app);
  registerNotesRoutes(app);
  registerProfileRoutes(app);
  registerLatexRoutes(app);

  return app;
}
