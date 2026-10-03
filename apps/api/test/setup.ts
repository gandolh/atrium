/**
 * Loaded with `--import` before any test file, in every test process.
 *
 * `config.ts` resolves the storage roots **at import** and `knex.ts` opens
 * `DB_PATH` **at import**, so the only safe moment to redirect them is before
 * the first API module loads. This file does that, then proves it: it imports
 * `config.ts` and throws unless every exported root resolved inside this
 * process's scratch directory. Nothing imports `knex.ts` until that passes.
 *
 * Why this is enforced in code rather than by habit: on 2026-08-25 a
 * verification run with the database redirected but the files not destroyed
 * one of the owner's books (D39), and brief 53 showed a file move silently
 * re-pointing every default root. A test run must not be able to reach the real
 * library, even by accident.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

export const SCRATCH = mkdtempSync(join(tmpdir(), "atrium-api-test-"));
// Registered first, so a run the assertion below refuses still cleans up.
process.on("exit", () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** Every storage root `config.ts` reads. All five move together, always. */
const ROOTS = {
  LIBRARY_DATA_DIR: "data",
  LIBRARY_FILES_DIR: "library",
  THUMBNAILS_DIR: "images/thumbnails",
  LATEX_PROJECTS_DIR: "latex",
  DOCUMENT_VERSIONS_DIR: "versions",
} as const;

for (const [name, sub] of Object.entries(ROOTS)) {
  process.env[name] = join(SCRATCH, sub);
}

// What `config.ts`'s schema requires today. Set unconditionally: the repo-root
// `.env` is loaded too, but `process.loadEnvFile` never overrides a variable
// that is already set, so these win.
Object.assign(process.env, {
  PORT: "3999", // never listened on: tests use app.inject
  HOST: "127.0.0.1",
  MAX_UPLOAD_MB: "50",
  CONVERT_JOB_TIMEOUT_MS: "60000",
  WARD_PUBLIC_ORIGIN: "http://ward.test",
  WARD_API_BASE_PATH: "/ward-api",
  WARD_APP_KEY: "test-app-key",
});

const config = await import("../src/common/config.js");
const resolved = {
  DATA_DIR: config.DATA_DIR,
  DB_PATH: config.DB_PATH,
  LIBRARY_FILES_DIR: config.LIBRARY_FILES_DIR,
  THUMBNAILS_DIR: config.THUMBNAILS_DIR,
  LATEX_PROJECTS_DIR: config.LATEX_PROJECTS_DIR,
  DOCUMENT_VERSIONS_DIR: config.DOCUMENT_VERSIONS_DIR,
};
const escaped = Object.entries(resolved).filter(([, path]) => {
  const rel = relative(SCRATCH, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel);
});
if (escaped.length > 0) {
  throw new Error(
    `test/setup.ts: refusing to run. These storage roots resolve outside the scratch directory ${SCRATCH}:\n` +
      escaped.map(([name, path]) => `  ${name} = ${path}`).join("\n"),
  );
}
