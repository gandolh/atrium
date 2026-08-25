import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { maxUploadBytesFromMb } from "@ebook-reader/shared";

/**
 * Runtime configuration, resolved once from the environment and validated at
 * import time. Unlike the previous "safe defaults" scheme, every variable in
 * the .env contract is now REQUIRED — a missing or malformed value aborts
 * startup with a clear message instead of silently falling back. See
 * .env.example for the full contract. (User accounts are NOT configured here —
 * they live in the DB and are created by scripts/seed.ts.)
 */

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/api/src (or dist)
const API_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Load the single repo-root `.env` into process.env before validating.
 * Best-effort: in production the variables may be injected by the process
 * manager (pm2/systemd) rather than a file, so a missing `.env` is fine — the
 * schema check below is the real gate.
 */
const ENV_FILE = resolve(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

/**
 * Every API variable is required. Numbers are coerced from their string env
 * form and must be positive; strings must be non-empty (so `APP_PASSWORD=`
 * counts as unset). Path overrides (LIBRARY_DATA_DIR/BASE_PATH) are NOT part of
 * this contract — they stay optional below.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  HOST: z.string().min(1),
  MAX_UPLOAD_MB: z.coerce.number().positive(),
  CONVERT_TIMEOUT_MS: z.coerce.number().int().positive(),
  CONVERT_JOB_TIMEOUT_MS: z.coerce.number().int().positive(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map(
    (issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`,
  );
  // Fail fast: don't boot a half-configured server. Written to stderr directly
  // (the Fastify logger isn't up yet) and exit non-zero.
  console.error(
    "\n============================================================\n" +
      "  Invalid or missing environment configuration.\n" +
      "  Set these variables (copy .env.example to .env) and retry:\n\n" +
      lines.join("\n") +
      "\n============================================================\n",
  );
  process.exit(1);
}

const env = parsed.data;

export const PORT = env.PORT;
export const HOST = env.HOST;

export const MAX_UPLOAD_MB = env.MAX_UPLOAD_MB;
export const MAX_UPLOAD_BYTES = maxUploadBytesFromMb(MAX_UPLOAD_MB);

export const CONVERT_TIMEOUT_MS = env.CONVERT_TIMEOUT_MS;

/**
 * Ceiling on a library conversion job (D34, brief 34 decision 4). Defaults to
 * 24 hours in `.env.example`, which looks absurd until you read it as what it
 * is: a **last-resort reaper, not a UX guard**. Nobody waits at the screen for
 * a conversion — the row says `running`, the client polls, and the person goes
 * away. The only job this number has is to stop a wedged `ebook-convert` from
 * pinning a CPU forever; the answer to "this is taking too long" is Cancel
 * (decision 5), which is why the ceiling can afford to be this generous.
 *
 * Distinct from `CONVERT_TIMEOUT_MS`, the old 60s cap on the *synchronous*
 * export route (D15) — that one was a UX guard, because a request was blocked
 * on it.
 */
export const CONVERT_JOB_TIMEOUT_MS = env.CONVERT_JOB_TIMEOUT_MS;

/**
 * Library storage roots (decisions.md D24/D25). Everything lives under the
 * API package's `data/` (DB) and sibling dirs, resolved relative to this
 * source file so it's stable regardless of cwd (dev `tsx` vs built `dist/`).
 * All three are gitignored. Override the base with `LIBRARY_DATA_DIR` (an
 * optional deploy override, not part of the required .env contract).
 */
export const DATA_DIR = process.env.LIBRARY_DATA_DIR
  ? resolve(process.env.LIBRARY_DATA_DIR)
  : resolve(API_ROOT, "data");
export const DB_PATH = resolve(DATA_DIR, "library.db");
/** Original uploaded PDF/EPUB files: `library/<id>.<ext>`. */
export const LIBRARY_FILES_DIR = resolve(API_ROOT, "library");
/** Extracted cover thumbnails: `images/thumbnails/<id>.jpg`. */
export const THUMBNAILS_DIR = resolve(API_ROOT, "images", "thumbnails");

/**
 * Base URL of the Gutendex instance the catalog proxy talks to (brief 22).
 * Env-overridable (`GUTENDEX_BASE_URL`) for a self-hosted mirror or tests;
 * defaults to the public community instance. Not part of the required .env
 * contract — an optional deploy override, like `LIBRARY_DATA_DIR`. The trailing
 * slash is trimmed so URL joins are predictable.
 */
export const GUTENDEX_BASE_URL = (
  process.env.GUTENDEX_BASE_URL?.trim() || "https://gutendex.com"
).replace(/\/+$/, "");
