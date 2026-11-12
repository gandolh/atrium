import closeWithGrace from "close-with-grace";
import { buildApp } from "./app.js";
import {
  CONNECTION_TIMEOUT_MS,
  DATA_DIR,
  DOCUMENT_VERSIONS_DIR,
  ENV_FILE,
  ENV_FILE_LOADED,
  HOST,
  KEEP_ALIVE_TIMEOUT_MS,
  LATEX_PROJECTS_DIR,
  LIBRARY_FILES_DIR,
  MAX_UPLOAD_MB,
  PORT,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_DELAY_MS,
  THUMBNAILS_DIR,
  TRUSTED_PROXIES,
  WARN_WITHOUT_TRUSTED_PROXIES,
} from "./config.js";
import { initDatabase, logMigratedAccounts } from "./db/bootstrap.js";
import { closeDatabase } from "./db/knex.js";
import { isCalibreAvailable } from "./modules/library/calibre.service.js";
import { cancelAllConverts, sweepInterruptedOutputs } from "./modules/library/convert.service.js";
import { backfillLibraryMetadata, sweepOrphanThumbnails } from "./modules/library/library-maintenance.service.js";
import { cancelAllLatexCompiles } from "./modules/latex/latex-compile.service.js";
import { createWardClient, wardClientOptionsFromEnv } from "../vendor/ward/ward-auth.js";

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

/**
 * The database first, then "Sign in with Ward" (D58), then the app, because
 * the guard is made of the accounts and the Ward client.
 *
 * `initDatabase()` runs the migrations and the boot-time data repairs before
 * anything is built, deliberately: nothing may serve a request against a
 * database whose shape is unknown, and it answers the accounts, opened on the
 * same connection Knex uses (`auth-store.ts`). A failure here stops the
 * process before it listens.
 *
 * Ward is optional. With no `WARD_OIDC_ISSUER` the app runs on local accounts
 * only, and the login page shows no Ward button; with the issuer set and
 * another `WARD_OIDC_*` missing, this throws and names it, which is always a
 * deploy mistake. `createWardClient` imports the key now, so a bad key stops
 * the boot, but it does not contact Ward: atrium starts while Ward is down.
 * Read here and nowhere else, so a test never picks up the real issuer from
 * the repo-root `.env`.
 */
const { accounts, migratedAccounts } = await initDatabase().catch((err: unknown) => {
  console.error("database bootstrap failed:", err);
  process.exit(1);
});
const wardOptions = wardClientOptionsFromEnv();
const wardClient = wardOptions === undefined ? undefined : await createWardClient(wardOptions);
const app = await buildApp({
  accounts,
  wardClient,
  server: {
    logger: true,
    // Loopback, plus the proxies the sign-in lockout already trusts, so the
    // request log shows the client. Ward's lockout reads the socket itself.
    trustProxy: ["loopback", ...TRUSTED_PROXIES],
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  },
});

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

/**
 * Startup check for `AUTH_TRUSTED_PROXIES`. Not fatal either: a
 * deploy without it still serves everyone, but the password lockout then keys
 * on the proxy, so the sixth wrong password from anyone answers 429 to every
 * account for 15 minutes. Only when the server listens beyond loopback, as it
 * does in the container: locally the dev proxy is loopback, which the library
 * always trusts. An empty or blank value is an empty list, so it counts as unset.
 */
function checkTrustedProxies(): void {
  if (!WARN_WITHOUT_TRUSTED_PROXIES || TRUSTED_PROXIES.length > 0) return;
  app.log.warn(
    "============================================================\n" +
      "  WARNING: AUTH_TRUSTED_PROXIES is not set.\n" +
      "  Behind a container proxy every client then shares one\n" +
      "  sign-in lockout counter: six wrong passwords from anyone\n" +
      "  lock every account out of password sign-in for 15 minutes.\n" +
      "  Set it to the proxy's network, e.g. 172.16.0.0/12 for\n" +
      "  Docker's default bridges. See .env.example.\n" +
      "============================================================",
  );
}

async function start(): Promise<void> {
  try {
    await checkCalibre();
    checkTrustedProxies();
    // The first boot after D58 turns each Ward subject into a passwordless
    // account; say which, and how each gets in.
    logMigratedAccounts(app.log, migratedAccounts, { signInWithWard: wardClient !== undefined });
    await app.listen({ port: PORT, host: HOST });
    // Every storage root, in the first line an operator reads. Two incidents and
    // the storage-roots fix were all a root silently pointing somewhere unintended; this is
    // where the next one shows.
    app.log.info(
      {
        maxUploadMb: MAX_UPLOAD_MB,
        storageRoots: {
          data: DATA_DIR,
          library: LIBRARY_FILES_DIR,
          thumbnails: THUMBNAILS_DIR,
          latex: LATEX_PROJECTS_DIR,
          versions: DOCUMENT_VERSIONS_DIR,
        },
        envFile: { path: ENV_FILE, loaded: ENV_FILE_LOADED },
        signInWithWard: wardClient === undefined ? "off" : wardClient.issuer,
      },
      "API ready",
    );
    // Backfill series/subjects metadata for pre-existing rows. Fired
    // off the request path (not awaited) so it never delays readiness; failures
    // are logged, not fatal.
    void backfillLibraryMetadata(app.log).catch((err) => {
      app.log.error({ err }, "library metadata backfill failed");
    });
    // Reap thumbnails no live row can claim. Same fire-and-forget
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
 * Stop in-flight work, then close the server and the database pool, on
 * SIGTERM, SIGINT or an uncaught error. close-with-grace exits once this
 * resolves, and exits anyway after `SHUTDOWN_DELAY_MS`.
 *
 * A conversion child is spawned with `detached: false`, so a plain SIGTERM to
 * this process leaves `ebook-convert` running and its output orphaned — the
 * very leak the boot sweep exists to clean up. Killing in-flight jobs on a
 * clean shutdown means there is usually nothing left to sweep.
 *
 * Cancelling a conversion writes to the database (it resets the source row to
 * `none`), so it is awaited: exiting mid-write is exactly the "row left
 * `running` with nothing running" state the reapers exist to clean up.
 *
 * `app.close()` runs the app's `preClose` hooks first, and the Jukebox's
 * answers the bot's held long poll: Fastify waits for requests in flight, so
 * a poll left waiting would hold the shutdown for the rest of its wait.
 */
closeWithGrace({ delay: SHUTDOWN_DELAY_MS, logger: app.log }, async ({ signal, err }) => {
  if (err) app.log.error({ err }, "closing on an uncaught error");
  const cancelled = await cancelAllConverts();
  if (cancelled > 0) app.log.info({ signal, cancelled }, "cancelled conversions on shutdown");
  // LaTeX compiles have no child process to orphan — the engine is in-process
  // (D38) — so this is not about leaked work but about the *slot*. A compile
  // still holding one when the process goes down leaves its row `running`, and
  // `reapInterruptedLatexCompiles()` flips those to `failed` on the way back up.
  // Cancelling here *terminates* the compile's worker thread rather
  // than waiting for the engine to notice a flag at its next step boundary — a
  // document nobody will read is not worth delaying a shutdown for, and the
  // thread dies with the process regardless.
  const compiles = cancelAllLatexCompiles();
  if (compiles > 0) app.log.info({ signal, compiles }, "cancelled LaTeX compiles on shutdown");
  await app.close();
  // Last, so nothing above can find the pool already destroyed.
  await closeDatabase();
});

void start();
