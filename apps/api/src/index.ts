import { buildApp } from "./app.js";
import { CONVERT_TIMEOUT_MS, HOST, MAX_UPLOAD_MB, PORT } from "./common/config.js";
import { initDatabase } from "./database/bootstrap.js";
import { closeDatabase } from "./database/knex.js";
import { isCalibreAvailable } from "./modules/library/calibre.service.js";
import { cancelAllConverts, sweepInterruptedOutputs } from "./modules/library/convert.service.js";
import {
  backfillLibraryMetadata,
  sweepOrphanThumbnails,
} from "./modules/library/library-maintenance.service.js";
import { cancelAllLatexCompiles } from "./modules/latex/latex-compile.service.js";

/**
 * Process entry point: bring the database up, build the app, listen, and shut
 * down cleanly.
 *
 * ## Why the database is an awaited step now
 *
 * It used to happen as a side effect of importing `db.ts` — the schema, every
 * migration and the two job reapers ran synchronously at module load, before
 * anything could ask whether they had worked. With Knex none of that can be
 * synchronous, so `initDatabase()` is an explicit `await` **before**
 * `app.listen()`. That ordering is the contract: a migration that fails stops
 * the server from coming up at all, rather than being discovered by the first
 * request that reads a column which does not exist.
 */
const app = await buildApp();

/**
 * Startup probe for `ebook-convert`. Missing Calibre is NOT fatal — the server
 * still boots, and a conversion started from the library fails that book's
 * convert job with the Calibre-missing reason rather than taking anything else
 * down (D5, D34). We log a loud warning so it's obvious the machine can't
 * actually convert.
 */
async function checkCalibre(): Promise<void> {
  if (await isCalibreAvailable()) {
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
    // Migrations and the boot-time data repairs. Before `listen`, deliberately:
    // nothing may serve a request against a database whose shape is unknown.
    await initDatabase();
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
    // Reap thumbnails no live row can claim (brief 48). Same fire-and-forget
    // shape for the same reason: it deletes files, so it must never be able to
    // stop the API from serving. It refuses to delete anything on a partial
    // read — see `sweepOrphanThumbnails`, where that refusal is the point.
    void sweepOrphanThumbnails(app.log).catch((err) => {
      app.log.error({ err }, "orphan thumbnail sweep failed");
    });
    // `initDatabase` reaps rows left `running` by a process that died
    // mid-conversion; this reclaims the disk those same jobs were using. The
    // converted book's id never outlived the process, so the output is named
    // from the SOURCE row precisely so it can still be found here
    // (`convert.service.ts` `inProgressPath`).
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

/**
 * Stop in-flight work, then close the server and the database pool.
 *
 * A conversion child is spawned with `detached: false`, so a plain SIGTERM to
 * this process leaves `ebook-convert` running and its output orphaned — the
 * very leak the boot sweep exists to clean up. Killing in-flight jobs on a
 * clean shutdown means there is usually nothing left to sweep.
 *
 * Async now, because cancelling a conversion writes to the database (it resets
 * the source row to `none`). The handler therefore awaits rather than
 * fire-and-forgetting: exiting mid-write is exactly the "row left `running`
 * with nothing running" state the reapers exist to clean up, and there is no
 * reason to create work for the next boot when the write takes milliseconds.
 */
async function shutdown(signal: string): Promise<void> {
  const cancelled = await cancelAllConverts();
  if (cancelled > 0) app.log.info({ signal, cancelled }, "cancelled conversions on shutdown");
  // LaTeX compiles have no child process to orphan — the engine is in-process
  // (D38) — so this is not about leaked work but about the *slot*. A compile
  // still holding one when the process goes down leaves its row `running`, and
  // `reapInterruptedLatexCompiles()` flips those to `failed` on the way back up.
  // Cancelling here *terminates* the compile's worker thread (brief 44) rather
  // than waiting for the engine to notice a flag at its next step boundary — a
  // document nobody will read is not worth delaying a shutdown for, and the
  // thread dies with the process regardless.
  const compiles = cancelAllLatexCompiles();
  if (compiles > 0) app.log.info({ signal, compiles }, "cancelled LaTeX compiles on shutdown");
  await app.close();
  // Last, so nothing above can find the pool already destroyed.
  await closeDatabase();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((err) => {
      app.log.error({ err }, "shutdown failed");
      process.exit(1);
    });
  });
}

void start();
