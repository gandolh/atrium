import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "./harness.ts";

/**
 * Cross-process determinism (brief 37, chunk 9, D38).
 *
 * `compile()`'s golden-test strategy — and the whole idea of comparing PDF
 * bytes at all — depends on the same source producing byte-identical output
 * every time. `compile.test.ts` already checks that within one process; this
 * file checks the harder claim: that it holds across two entirely separate
 * `node` processes, which is what actually matters for a compile job that
 * might run on a different worker, a different day, on the same machine.
 *
 * The child program is generated at test time (never checked in) and run with
 * `execFileSync`, which spawns a genuinely separate OS process each call —
 * two calls are two processes, not two calls into the same one.
 */

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const SRC_INDEX = join(PACKAGE_ROOT, "src", "index.ts");
const NODE_FONTS = join(PACKAGE_ROOT, "node", "fonts.ts");

/**
 * Writes a tiny standalone compiler to `dir/child.mjs`: read a project
 * directory from argv, compile it, print the PDF as base64 on stdout. Kept
 * outside the package (a fresh temp directory per test run) per this chunk's
 * instruction to leave throwaway scripts out of `packages/typeset`.
 */
function writeChildProgram(dir: string): string {
  const path = join(dir, "child.mjs");
  const source = `
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compile, createLatinModernProvider } from ${JSON.stringify(SRC_INDEX)};
import { loadLatinModernBytes } from ${JSON.stringify(NODE_FONTS)};

const fonts = createLatinModernProvider(loadLatinModernBytes());
const projectDir = process.argv[2];
const entrypoint = process.argv[3];
const files = {};
for (const name of readdirSync(projectDir)) {
  files[name] = new Uint8Array(readFileSync(join(projectDir, name)));
}
const result = compile(files, entrypoint, { fonts });
if (result.pdf === null) {
  console.error("COMPILE_FAILED: " + JSON.stringify(result.diagnostics));
  process.exit(1);
}
process.stdout.write(Buffer.from(result.pdf).toString("base64"));
`;
  writeFileSync(path, source);
  return path;
}

/** Materialise a fixture's in-memory files onto disk for the child process to read. */
function writeProject(dir: string, files: Record<string, Uint8Array>): void {
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(dir, name), bytes);
  }
}

function compileInChildProcess(childPath: string, projectDir: string, entrypoint: string): string {
  return execFileSync(process.execPath, [childPath, projectDir, entrypoint], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

test("the same multi-file project compiles to byte-identical PDFs in two separate processes", () => {
  const fixture = loadFixture("structured");
  const work = mkdtempSync(join(tmpdir(), "typeset-determinism-"));
  const childPath = writeChildProgram(work);
  const projectDir = join(work, "project");
  mkdirSync(projectDir);
  writeProject(projectDir, fixture.files);

  const first = compileInChildProcess(childPath, projectDir, fixture.entrypoint);
  const second = compileInChildProcess(childPath, projectDir, fixture.entrypoint);

  assert.ok(first.length > 0, "the child process produced output");
  assert.equal(first, second, "byte-identical (as base64) across two separate node processes");
});

test("a plain single-file document is also byte-identical across separate processes", () => {
  const fixture = loadFixture("prose");
  const work = mkdtempSync(join(tmpdir(), "typeset-determinism-"));
  const childPath = writeChildProgram(work);
  const projectDir = join(work, "project");
  mkdirSync(projectDir);
  writeProject(projectDir, fixture.files);

  const first = compileInChildProcess(childPath, projectDir, fixture.entrypoint);
  const second = compileInChildProcess(childPath, projectDir, fixture.entrypoint);
  assert.equal(first, second);

  // And the decoded bytes really do look like a PDF, so an empty-string
  // false positive from a broken child program cannot pass this test.
  const bytes = Buffer.from(first, "base64");
  assert.match(bytes.subarray(0, 8).toString("latin1"), /^%PDF-1\.[0-9]/);
});

test("sanity: the harness actually detects a difference when there is one", () => {
  // A meta-test for the comparison method itself: two genuinely different
  // documents must not compare equal, so a bug that made the harness always
  // report "equal" (e.g. an empty string on both sides) cannot hide behind
  // the two tests above.
  const work = mkdtempSync(join(tmpdir(), "typeset-determinism-"));
  const childPath = writeChildProgram(work);

  const dirA = join(work, "a");
  const dirB = join(work, "b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  const enc = new TextEncoder();
  writeFileSync(
    join(dirA, "main.tex"),
    enc.encode("\\documentclass{article}\n\\begin{document}\nFirst document.\n\\end{document}\n"),
  );
  writeFileSync(
    join(dirB, "main.tex"),
    enc.encode("\\documentclass{article}\n\\begin{document}\nA very different second document entirely.\n\\end{document}\n"),
  );

  const outA = compileInChildProcess(childPath, dirA, "main.tex");
  const outB = compileInChildProcess(childPath, dirB, "main.tex");
  assert.notEqual(outA, outB);
});
