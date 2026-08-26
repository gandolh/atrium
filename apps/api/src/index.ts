import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { isCalibreAvailable } from "./calibre.js";
import { registerAuthGuard, registerAuthRoutes } from "./auth.js";
import {
  CONVERT_TIMEOUT_MS,
  HOST,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  PORT,
} from "./config.js";
import {
  backfillLibraryMetadata,
  reconcileMissingCovers,
  registerLibraryRoutes,
} from "./library-routes.js";
import { registerCatalogRoutes } from "./catalog-routes.js";
import { cancelAllConverts, sweepInterruptedOutputs } from "./convert-jobs.js";
import { registerNotesRoutes } from "./notes-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";

const app = Fastify({
  logger: {
    serializers: {
      // Cover-image <img> tags carry the platform-password token as ?token=
      // (a static credential) — it must never reach logs in plaintext.
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
// (decisions.md D14; no Vite proxy). Enumerate methods so the library routes'
// PATCH/DELETE (with a JSON body → preflighted) aren't blocked; the default
// allowlist omits PATCH.
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});

// 50MB (from MAX_UPLOAD_MB) upload ceiling (D15). @fastify/multipart truncates
// past this; the route inspects `file.truncated` and returns TOO_LARGE.
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

/**
 * Startup probe for `ebook-convert`. Missing Calibre is NOT fatal — the server
 * still boots, and a conversion started from the library fails that book's
 * convert job with the Calibre-missing reason rather than taking anything else
 * down (D5, D34). We log a loud warning so it's obvious the machine can't
 * actually convert.
 */
async function checkCalibre(): Promise<void> {
  const available = await isCalibreAvailable();
  if (available) {
    app.log.info("Calibre `ebook-convert` found on PATH — conversion enabled.");
    return;
  }
  app.log.warn(
    "============================================================\n" +
      "  WARNING: `ebook-convert` (Calibre) was NOT found on PATH.\n" +
      "  Book conversion (PDF <-> EPUB) will fail on every attempt.\n" +
      "  Install Calibre and ensure `ebook-convert` is on PATH.\n" +
      "  See decisions.md D5.\n" +
      "============================================================",
  );
}

async function start(): Promise<void> {
  try {
    await checkCalibre();
    await app.listen({ port: PORT, host: HOST });
    app.log.info(
      { maxUploadMb: MAX_UPLOAD_MB, convertTimeoutMs: CONVERT_TIMEOUT_MS },
      "API ready",
    );
    // Backfill series/subjects metadata for pre-existing rows (brief 21). Fired
    // off the request path (not awaited) so it never delays readiness; failures
    // are logged, not fatal.
    void backfillLibraryMetadata(app.log).catch((err) => {
      app.log.error({ err }, "library metadata backfill failed");
    });
    // Drop cover paths whose thumbnail file is missing (e.g. a library DB
    // carried over from another machine with stale absolute paths), so the
    // client renders its fallback tile instead of firing a doomed cover request
    // that surfaces as ERR_BLOCKED_BY_ORB. Off the request path; non-fatal.
    void reconcileMissingCovers(app.log).catch((err) => {
      app.log.error({ err }, "cover reconcile failed");
    });
    // `db.ts` reaps rows left `running` by a process that died mid-conversion;
    // this reclaims the disk those same jobs were using. The converted book's
    // id never outlived the process, so the output is named from the SOURCE row
    // precisely so it can still be found here (convert-jobs.ts `inProgressPath`).
    void sweepInterruptedOutputs()
      .then((removed) => {
        if (removed > 0) app.log.info({ removed }, "removed interrupted conversion output");
      })
      .catch((err) => {
        app.log.error({ err }, "conversion output sweep failed");
      });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// A conversion child is spawned with `detached: false`, so a plain SIGTERM to
// this process leaves `ebook-convert` running and its output orphaned — the
// very leak the boot sweep above exists to clean up. Killing in-flight jobs on
// a clean shutdown means there is usually nothing left to sweep.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    const cancelled = cancelAllConverts();
    if (cancelled > 0) app.log.info({ cancelled }, "cancelled conversions on shutdown");
    void app.close().then(() => process.exit(0));
  });
}

void start();
