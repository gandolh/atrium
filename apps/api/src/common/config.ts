import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { maxUploadBytesFromMb } from "@ebook-reader/shared";

/**
 * Runtime configuration, resolved once from the environment and validated at
 * import time. Unlike the previous "safe defaults" scheme, every variable in
 * the .env contract is now REQUIRED — a missing or malformed value aborts
 * startup with a clear message instead of silently falling back. See
 * .env.example for the full contract.
 *
 * User accounts are **not here and not in this database** — Ward owns them.
 * What is here is how to reach Ward and how to prove atrium is atrium.
 */

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/api/src/common (or dist/common)

/**
 * The API package's directory: the first directory above this file whose
 * `package.json` is named `@ebook-reader/api`.
 *
 * Found by name rather than by counting `..`, because counting is what broke
 * (brief 53). Brief 52 moved this file one level down, into `common/`, and every
 * storage root and the `.env` path silently moved one level with it: the API
 * booted on a brand-new empty database while the real library sat beside it.
 * Walking to the package works from `src` under tsx and from the built `dist`
 * alike, and if a move ever leaves the package behind, startup fails here
 * instead of resolving somewhere new.
 */
function findApiRoot(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@ebook-reader/api") {
      return dir;
    }
    if (dirname(dir) === dir) {
      throw new Error(
        `config.ts: no @ebook-reader/api package.json above ${start}, so the storage roots and .env cannot be resolved.`,
      );
    }
  }
}

const API_ROOT = findApiRoot(HERE);
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Load the single repo-root `.env` into process.env before validating.
 * Best-effort: in production the variables may be injected by the process
 * manager (pm2/systemd) rather than a file, so a missing `.env` is fine — the
 * schema check below is the real gate. Both are exported for the startup log.
 */
export const ENV_FILE = resolve(REPO_ROOT, ".env");
export const ENV_FILE_LOADED = existsSync(ENV_FILE);
if (ENV_FILE_LOADED) {
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

  /**
   * Ward, the estate's identity service. All three are **required**, and each
   * is required for a different reason worth stating.
   *
   * `WARD_PUBLIC_ORIGIN` is also the expected `iss` on every token, compared as
   * an exact string — a bare origin, no trailing slash.
   *
   * `WARD_API_BASE_PATH` is `/ward-api` in this estate and has no default on
   * purpose. Defaulting it to `""` resolves the JWKS to
   * `<origin>/.well-known/jwks.json`, a path nothing serves; that shipped once
   * in the reference client and would have made every app in the estate reject
   * every token on the deploy that carried it.
   *
   * `WARD_APP_KEY` is atrium's own service key, issued from Ward's console.
   * Without it `POST /ward-api/introspect` refuses every call, which is a total
   * outage for this app rather than a degraded mode — hence required rather
   * than optional, so a missing one stops the boot instead of surfacing as a
   * 503 on somebody's first page load.
   */
  WARD_PUBLIC_ORIGIN: z.string().url(),
  WARD_API_BASE_PATH: z.string().min(1),
  WARD_APP_KEY: z.string().min(1),
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

/** Ward's public origin, and the `iss` every access token must carry. */
export const WARD_PUBLIC_ORIGIN = env.WARD_PUBLIC_ORIGIN.replace(/\/+$/, "");
/** Ward's prefix behind Caddy — `/ward-api`. See the schema note. */
export const WARD_API_BASE_PATH = env.WARD_API_BASE_PATH;
/**
 * Atrium's Ward service key. **A secret.** Server-side only — it must never be
 * exposed to the web client, put in a Vite variable, or logged.
 */
export const WARD_APP_KEY = env.WARD_APP_KEY;

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
 * API package's `data/` (DB) and sibling dirs, resolved from the package
 * itself (`findApiRoot` above) so it's stable regardless of cwd and of where
 * this file sits (dev `tsx` vs built `dist/`).
 * All three are gitignored. Override the base with `LIBRARY_DATA_DIR` (an
 * optional deploy override, not part of the required .env contract).
 */
export const DATA_DIR = process.env.LIBRARY_DATA_DIR
  ? resolve(process.env.LIBRARY_DATA_DIR)
  : resolve(API_ROOT, "data");
export const DB_PATH = resolve(DATA_DIR, "library.db");
/**
 * Original uploaded PDF/EPUB files: `library/<id>.<ext>`.
 *
 * Every storage root (`LIBRARY_DATA_DIR`, `LIBRARY_FILES_DIR`,
 * `THUMBNAILS_DIR`, and brief 38's `LATEX_PROJECTS_DIR` /
 * `DOCUMENT_VERSIONS_DIR` below) is independently overridable via env, same
 * pattern as `DATA_DIR` above. Redirect them all together to point a
 * test/deploy at a scratch storage root, so a scratch database and scratch
 * files move as one — never redirect the database alone and run against the
 * real files.
 */
export const LIBRARY_FILES_DIR = process.env.LIBRARY_FILES_DIR
  ? resolve(process.env.LIBRARY_FILES_DIR)
  : resolve(API_ROOT, "library");
/** Extracted cover thumbnails: `images/thumbnails/<id>.jpg`. See the note above. */
export const THUMBNAILS_DIR = process.env.THUMBNAILS_DIR
  ? resolve(process.env.THUMBNAILS_DIR)
  : resolve(API_ROOT, "images", "thumbnails");

/**
 * LaTeX project working trees (brief 38): one directory per project, at
 * `latex/<projectId>/`, holding the `.tex` sources plus any figures and `.bib`
 * files the editor uploaded. This is the **draft** side of brief 38 — live,
 * mutable, never shown in the gallery.
 *
 * It is also the **confinement root** every path-accepting LaTeX route checks
 * against; see `latex-paths.ts`. Nothing may join an untrusted path onto this
 * directory directly.
 */
export const LATEX_PROJECTS_DIR = process.env.LATEX_PROJECTS_DIR
  ? resolve(process.env.LATEX_PROJECTS_DIR)
  : resolve(API_ROOT, "latex");

/**
 * Published version artifacts (brief 38 step 6): the per-version PDF and the
 * zip of the project tree that produced it, at `versions/<versionId>.pdf` and
 * `versions/<versionId>.zip`. These are **immutable** once written — a version
 * is a snapshot — which is what makes them a different root from the mutable
 * draft trees above rather than a subdirectory of them.
 *
 * Both new roots are env-overridable for exactly the reason D39 gives: a
 * storage root that cannot be redirected cannot be tested destructively, which
 * is how brief 34's verification run permanently destroyed one of the owner's
 * books on 2026-08-25. Redirect **all five** roots together at a scratch base
 * when pointing a test or a throwaway deploy somewhere safe — a scratch
 * database next to real files is the precise shape of that accident.
 */
export const DOCUMENT_VERSIONS_DIR = process.env.DOCUMENT_VERSIONS_DIR
  ? resolve(process.env.DOCUMENT_VERSIONS_DIR)
  : resolve(API_ROOT, "versions");

/**
 * Read an OPTIONAL positive-number env override, or fall back to a default.
 *
 * Deliberately not part of the required zod schema above (D29): these are
 * tuning knobs, and demanding them of every deploy would make the contract
 * noisier without making it safer. But "optional" must not mean "silently
 * ignored" — a typo'd `LATEX_TIMEOUT_MS=12O000` (letter O) that quietly fell
 * back to the default would be exactly the silent-fallback behaviour this
 * file's header disowns. So a value that is *present but malformed* is fatal,
 * the same as a malformed required one; only an *absent* value takes the
 * default.
 */
function numericOverride(name: string, fallback: number, integer = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    console.error(
      `\n============================================================\n` +
        `  Invalid environment configuration.\n\n` +
        `  - ${name}: expected a positive ${integer ? "integer" : "number"}, got ${JSON.stringify(raw)}\n` +
        `\n  (This variable is optional — unset it to use the default of ${fallback}.)\n` +
        `============================================================\n`,
    );
    process.exit(1);
  }
  return value;
}

/**
 * Wall-clock ceiling on a LaTeX compile route (brief 38 step 3), in ms.
 *
 * This is the **outer backstop, not the real guard**. The typesetting engine is
 * a pure function with a deterministic step budget (D38) — that budget is what
 * actually stops a runaway `\newcommand` recursion, and it stops it at the same
 * point on every machine. This timer only exists for the case the step budget
 * cannot see: the process wedged somewhere outside the engine's step loop.
 *
 * Two minutes is therefore generous on purpose. Shortening it would not make
 * the engine safer, it would only start failing slow-but-legitimate documents
 * on a slow machine, non-deterministically — the one property D38 bought.
 */
export const LATEX_TIMEOUT_MS = numericOverride("LATEX_TIMEOUT_MS", 120_000, true);

/**
 * Ceiling on the compiled PDF a single compile may produce, in MB.
 *
 * A document can be small and its output enormous (a loop emitting pages), so
 * the input caps below do not imply this one. Enforced while the PDF is being
 * written, so the disk cannot fill before anyone notices.
 */
export const LATEX_MAX_OUTPUT_MB = numericOverride("LATEX_MAX_OUTPUT_MB", 25);
export const LATEX_MAX_OUTPUT_BYTES = maxUploadBytesFromMb(LATEX_MAX_OUTPUT_MB);

/**
 * Ceiling on the total on-disk size of one project's working tree, in MB —
 * sources plus every uploaded figure and `.bib`. Checked on each write/upload
 * against the tree's current size, since `MAX_UPLOAD_MB` only bounds a *single*
 * file and a project is an unbounded number of them.
 */
export const LATEX_MAX_PROJECT_MB = numericOverride("LATEX_MAX_PROJECT_MB", 50);
export const LATEX_MAX_PROJECT_BYTES = maxUploadBytesFromMb(LATEX_MAX_PROJECT_MB);

/**
 * Ceiling on one note's save body, in MB (brief 56). Every autosave carries the
 * whole notebook, every page's strokes, so Fastify's 1 MiB default was a wall a
 * well-used notebook would hit at around 870 strokes, after which every save
 * failed. 16 MiB is roughly fifteen times that once points are rounded at
 * capture.
 */
export const NOTE_MAX_MB = numericOverride("NOTE_MAX_MB", 16);
/** Floored: Fastify refuses a fractional route `bodyLimit` at registration,
 *  which would be a crash on boot for `NOTE_MAX_MB=0.5` (as `MAX_PROJECT_BYTES`). */
export const NOTE_MAX_BYTES = Math.floor(maxUploadBytesFromMb(NOTE_MAX_MB));

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
