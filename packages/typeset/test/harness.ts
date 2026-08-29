import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import type { CompileFn, CompileOptions, CompileResult } from "../src/index.ts";
import type { Diagnostic } from "../src/index.ts";

/**
 * The golden-dump harness — the repo's first test suite (brief 37, M0).
 *
 * A typesetting engine cannot be maintained without one: every change to line
 * breaking silently moves every line on every page, so the only way to know
 * whether a change is an improvement is to read the movement. A golden file is
 * that reading — a stable textual transcript of the positioned layout plus the
 * diagnostics.
 *
 * **Never PDF bytes.** A PDF carries a creation date, an object order and a
 * compressed stream; two identical documents produce different bytes, and a
 * diff of them tells a human nothing. The layout dump is reproducible and
 * legible, which is the entire point.
 *
 * The harness is deliberately dependency-free: `node --test` is the runner and
 * Node 24 executes these TypeScript files directly by stripping their types.
 */

/** Golden dumps round every number to this many decimals.
 *
 * 0.001 pt is about 1/72000 inch — roughly 350 nanometres, three orders of
 * magnitude finer than any device that will ever render this and far below what
 * a reader could see moved. Below it, doubles accumulate roughly 1e-12 pt of
 * error across a page's worth of additions, so the rounding step sits about a
 * billion times above the noise: a golden never fails because a machine added
 * the same numbers in a different order, and never hides a difference that
 * matters. */
const PRECISION = 3;

const HERE = import.meta.dirname;
const DEFAULT_FIXTURE_DIR = join(HERE, "fixtures");
const DEFAULT_GOLDEN_DIR = join(HERE, "golden");

export interface Fixture {
  /** The whole project, as `compile()` wants it. */
  files: Record<string, Uint8Array>;
  entrypoint: string;
}

export interface HarnessDirs {
  fixtureDir?: string;
  goldenDir?: string;
  /**
   * Write the golden instead of comparing against it. Defaults to whether
   * `UPDATE_GOLDEN` is set in the environment, read per call rather than once
   * at load so a test can exercise the blessing path without re-importing.
   */
  bless?: boolean;
}

/**
 * Load `fixtures/<name>.tex` as a one-file project, or `fixtures/<name>/` as a
 * multi-file one entered at `main.tex`. The single-file entrypoint keeps the
 * fixture's own name so diagnostics quote a filename a human recognises.
 */
export function loadFixture(name: string, dirs: HarnessDirs = {}): Fixture {
  const root = dirs.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  const asDir = join(root, name);
  if (isDirectory(asDir)) {
    const files: Record<string, Uint8Array> = {};
    for (const path of walk(asDir)) {
      // Project-relative, forward-slashed: the same key on every platform, so
      // a diagnostic's `file` is stable in the golden.
      files[relative(asDir, path).split(sep).join("/")] = new Uint8Array(readFileSync(path));
    }
    return { files, entrypoint: "main.tex" };
  }
  const entrypoint = `${name}.tex`;
  return {
    files: { [entrypoint]: new Uint8Array(readFileSync(join(root, entrypoint))) },
    entrypoint,
  };
}

/**
 * Render a compile result as a golden dump.
 *
 * The format is line-oriented, one placed item per line, in paint order down
 * the page, with the varying-length text last so the fixed columns in front of
 * it stay aligned in a diff. When line breaking changes, the diff shows which
 * lines moved and by how much, which is the question a reviewer is actually
 * asking.
 *
 * `stats.steps` and `stats.bytes` are deliberately absent: they change with
 * every internal refactor and would make every golden churn for reasons no
 * reviewer can judge. Page count is in the header because it is a real signal.
 */
export function dumpResult(result: CompileResult, entrypoint: string): string {
  const out: string[] = [];
  out.push("# typeset golden dump v1");
  out.push(`document: ${entrypoint}`);
  out.push(`pages: ${result.pages.length}`);

  for (const page of result.pages) {
    out.push("");
    out.push(`## page ${page.number}  ${num(page.width)} x ${num(page.height)}`);
    if (page.items.length === 0) out.push("  (empty)");
    for (const item of page.items) {
      if (item.kind === "glyphrun") {
        out.push(
          `  glyphs  x=${col(item.x)} y=${col(item.y)} w=${col(item.width)}` +
            `  ${item.font.id}@${num(item.size)}  ${quote(item.text)}`,
        );
      } else if (item.kind === "image") {
        // Same fixed columns as a rule (`y` is likewise the top edge), plus
        // the file-map path at the end — the one field a human reads to check
        // the right image landed. Without this arm a `PlacedImage` falls into
        // the `rule` branch below and prints as an untitled rectangle, which
        // would silently mislabel every image once a golden contains one.
        out.push(
          `  image   x=${col(item.x)} y=${col(item.y)} w=${col(item.width)} h=${col(item.height)}  ${quote(item.path)}`,
        );
      } else if (item.kind === "math") {
        // Same fixed columns again (`y` is the top edge, `h` covers height *and*
        // depth), plus the TeX at the end — the one field a human reads to check
        // that the right formula landed in the right place. Without this arm a
        // `PlacedMath` falls into the `rule` branch below and prints as an
        // untitled rectangle, which is exactly how a formula would look if it
        // had silently become one.
        out.push(
          `  math    x=${col(item.x)} y=${col(item.y)} w=${col(item.width)} h=${col(item.height)}  ${quote(item.source)}`,
        );
      } else {
        out.push(
          `  rule    x=${col(item.x)} y=${col(item.y)} w=${col(item.width)} h=${col(item.height)}`,
        );
      }
    }
  }

  out.push("");
  out.push("## diagnostics");
  if (result.diagnostics.length === 0) out.push("  (none)");
  for (const d of result.diagnostics) out.push(`  ${dumpDiagnostic(d)}`);

  return `${out.join("\n")}\n`;
}

/**
 * `construct` is intentionally not dumped: by contract its content also appears
 * in `message`, and printing it twice would double the noise in every diff.
 * The unit tests assert on it directly instead.
 */
function dumpDiagnostic(d: Diagnostic): string {
  const where = d.column === undefined ? `${d.file}:${d.line}` : `${d.file}:${d.line}:${d.column}`;
  return `${d.severity.padEnd(7)} ${where.padEnd(24)} ${(d.code ?? "-").padEnd(20)} ${d.message}`;
}

/** `null` when the two dumps match; otherwise a diff a human can read. */
export function compareDump(expected: string, actual: string): string | null {
  if (expected === actual) return null;
  return diffLines(expected.split("\n"), actual.split("\n"));
}

/**
 * Compare `actual` against `golden/<name>.txt`, or write it when blessing.
 * Throws with the diff on mismatch.
 */
export function checkGolden(name: string, actual: string, dirs: HarnessDirs = {}): void {
  const dir = dirs.goldenDir ?? DEFAULT_GOLDEN_DIR;
  const path = join(dir, `${name}.txt`);

  if (dirs.bless ?? Boolean(process.env["UPDATE_GOLDEN"])) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, actual);
    return;
  }

  let expected: string;
  try {
    expected = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no golden for "${name}" at ${path}\n` +
        `re-run with UPDATE_GOLDEN=1 to write it, then read the result before committing it.\n\n` +
        `--- would be written ---\n${actual}`,
    );
  }

  const diff = compareDump(expected, actual);
  if (diff !== null) {
    throw new Error(
      `golden mismatch for "${name}" (${path})\n` +
        `if the new layout is correct, re-run with UPDATE_GOLDEN=1.\n\n${diff}`,
    );
  }
}

export interface GoldenTestOptions extends HarnessDirs {
  /** Fixture to load. Defaults to the test's own name. */
  fixture?: string;
  compileOptions?: CompileOptions;
}

/**
 * Register a `node --test` case that compiles a fixture and holds the result
 * against `golden/<name>.txt`. This is what a per-feature test file calls.
 */
export function goldenTest(name: string, compileFn: CompileFn, opts: GoldenTestOptions = {}): void {
  test(`golden: ${name}`, () => {
    const fixture = loadFixture(opts.fixture ?? name, opts);
    const result = compileFn(fixture.files, fixture.entrypoint, opts.compileOptions);
    checkGolden(name, dumpResult(result, fixture.entrypoint), opts);
  });
}

// --- number formatting -----------------------------------------------------

/**
 * A non-finite dimension is a bug; it is printed literally rather than rounded
 * away so it shows up loudly in the diff instead of hiding as `0.000`.
 */
function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = value.toFixed(PRECISION);
  // `(-0.0004).toFixed(3)` is `-0.000`; without this a sign flip too small to
  // see would churn goldens forever.
  return rounded === `-${(0).toFixed(PRECISION)}` ? (0).toFixed(PRECISION) : rounded;
}

/** Right-aligned so the columns line up down a page of set text. */
function col(value: number): string {
  return num(value).padStart(9);
}

function quote(text: string): string {
  // JSON escaping: newlines and quotes become visible instead of breaking the
  // one-item-per-line format.
  return JSON.stringify(text);
}

// --- diffing ---------------------------------------------------------------

/**
 * Beyond this many cells the LCS table stops being worth building; a dump that
 * large is a runaway anyway, so fall back to reporting the first difference.
 */
const MAX_DIFF_CELLS = 4_000_000;
const CONTEXT = 3;

function diffLines(expected: string[], actual: string[]): string {
  if (expected.length * actual.length > MAX_DIFF_CELLS) return firstDifference(expected, actual);

  const ops = lcsOps(expected, actual);
  const changed: number[] = [];
  for (let k = 0; k < ops.length; k++) if (ops[k]!.tag !== " ") changed.push(k);
  if (changed.length === 0) return "(dumps differ only in trailing whitespace)";

  // Group changes that are within 2*CONTEXT of each other so neighbouring
  // edits read as one hunk rather than a stutter of near-identical blocks.
  const hunks: Array<[number, number]> = [];
  let from = changed[0]!;
  let to = changed[0]!;
  for (const k of changed.slice(1)) {
    if (k - to > CONTEXT * 2) {
      hunks.push([from, to]);
      from = k;
    }
    to = k;
  }
  hunks.push([from, to]);

  const lines: string[] = ["--- golden", "+++ actual"];
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - CONTEXT);
    const end = Math.min(ops.length - 1, last + CONTEXT);
    lines.push(`@@ golden line ${ops[start]!.expectedLine} @@`);
    for (let k = start; k <= end; k++) lines.push(`${ops[k]!.tag}${ops[k]!.text}`);
  }
  return lines.join("\n");
}

interface DiffOp {
  tag: " " | "-" | "+";
  text: string;
  /** 1-based line number in the golden, for the hunk header. */
  expectedLine: number;
}

/**
 * Plain longest-common-subsequence diff. Myers would be asymptotically better,
 * but a dump is a few hundred lines and correctness here is worth more than
 * speed: this is the code a reviewer trusts when a line-breaking change moves
 * every line on the page.
 */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", text: a[i]!, expectedLine: i + 1 });
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      ops.push({ tag: "-", text: a[i]!, expectedLine: i + 1 });
      i++;
    } else {
      ops.push({ tag: "+", text: b[j]!, expectedLine: i + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ tag: "-", text: a[i]!, expectedLine: i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ tag: "+", text: b[j]!, expectedLine: i + 1 });
    j++;
  }
  return ops;
}

function firstDifference(expected: string[], actual: string[]): string {
  const limit = Math.max(expected.length, actual.length);
  for (let i = 0; i < limit; i++) {
    if (expected[i] !== actual[i]) {
      return [
        `--- golden`,
        `+++ actual`,
        `@@ golden line ${i + 1} @@  (dump too large to diff in full)`,
        `-${expected[i] ?? "<end of file>"}`,
        `+${actual[i] ?? "<end of file>"}`,
      ].join("\n");
    }
  }
  return "(dumps differ only in trailing whitespace)";
}

// --- fs helpers ------------------------------------------------------------

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}
