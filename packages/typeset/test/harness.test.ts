import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/index.ts";
import type { CompileResult, FontHandle, Page } from "../src/index.ts";
import { checkGolden, compareDump, dumpResult, goldenTest, loadFixture } from "./harness.ts";

/**
 * Tests for the harness itself. Chunk 1 has no engine, so these prove the road
 * rather than the traffic: that a fixture loads, that a compile function's
 * output serialises to a stable dump, and that a mismatch produces a diff a
 * human can act on.
 */

/** A font stub. Only `id` reaches the dump; the rest satisfies the interface. */
const STUB_FONT: FontHandle = {
  id: "stub-roman",
  postscriptName: "StubRoman",
  unitsPerEm: 1000,
  ascent: 750,
  descent: 250,
  lineGap: 0,
  xHeight: 450,
  capHeight: 700,
  data: new Uint8Array(0),
  glyphsForString: (text) => [...text].map((_, i) => i + 1),
  advanceWidth: () => 500,
  kern: () => 0,
  shape: (text, size) => ({
    glyphs: [...text].map((_, i) => ({ id: i + 1, advance: size / 2, xOffset: 0, yOffset: 0, cluster: i })),
    width: (text.length * size) / 2,
    height: size * 0.75,
    depth: size * 0.25,
  }),
};

function run(text: string, x: number, y: number): Page["items"][number] {
  return {
    kind: "glyphrun",
    x,
    y,
    font: STUB_FONT,
    size: 10,
    glyphs: STUB_FONT.shape(text, 10).glyphs,
    width: STUB_FONT.shape(text, 10).width,
    text,
  };
}

/**
 * Stands in for a real compile: it ignores the source and returns a fixed
 * layout, which is exactly what is needed to test the harness independently of
 * an engine that does not exist yet.
 */
function stubCompile(files: Record<string, Uint8Array>, entrypoint: string): CompileResult {
  return {
    pdf: null,
    pages: [
      {
        number: 1,
        width: 612,
        height: 792,
        items: [
          run("The quick brown fox jumps", 72, 84),
          run("over the lazy dog.", 72, 96),
          { kind: "rule", x: 72, y: 120, width: 468, height: 0.4 },
        ],
      },
    ],
    diagnostics: [
      {
        file: entrypoint,
        line: 9,
        column: 1,
        severity: "warning",
        message: "reference `fig:missing' is undefined",
        code: "undefined-reference",
      },
    ],
    stats: { pages: 1, steps: 42, bytes: files[entrypoint]?.length ?? 0 },
  };
}

// The end-to-end path: fixture -> compile -> dump -> golden.
goldenTest("hello-stub", stubCompile, { fixture: "hello" });
goldenTest("hello-notimpl", compile, { fixture: "hello" });

test("loadFixture reads a .tex file and keeps its name as the entrypoint", () => {
  const fixture = loadFixture("hello");
  assert.equal(fixture.entrypoint, "hello.tex");
  assert.ok(fixture.files["hello.tex"] instanceof Uint8Array);
  assert.match(new TextDecoder().decode(fixture.files["hello.tex"]), /\\documentclass\{article\}/);
});

test("the dump rounds to three decimals and normalises negative zero", () => {
  const result: CompileResult = {
    pdf: null,
    pages: [
      {
        number: 1,
        width: 612.0000001,
        height: 792,
        items: [{ kind: "rule", x: -0.0004, y: 1 / 3, width: 10.98765, height: 0.4 }],
      },
    ],
    diagnostics: [],
    stats: { pages: 1, steps: 0, bytes: 0 },
  };
  const dump = dumpResult(result, "x.tex");
  assert.match(dump, /## page 1 {2}612\.000 x 792\.000/);
  assert.match(dump, /x= {4}0\.000 y= {4}0\.333 w= {3}10\.988 h= {4}0\.400/);
  assert.doesNotMatch(dump, /-0\.000/);
});

test("a non-finite dimension is printed, not rounded away", () => {
  const result: CompileResult = {
    pdf: null,
    pages: [
      { number: 1, width: 612, height: 792, items: [{ kind: "rule", x: NaN, y: 0, width: 1, height: 1 }] },
    ],
    diagnostics: [],
    stats: { pages: 1, steps: 0, bytes: 0 },
  };
  assert.match(dumpResult(result, "x.tex"), /x= {6}NaN/);
});

test("a diagnostic dumps severity, position, code and message", () => {
  const dump = dumpResult(stubCompile({ "a.tex": new Uint8Array(0) }, "a.tex"), "a.tex");
  assert.match(dump, /warning a\.tex:9:1 +undefined-reference {2}reference `fig:missing' is undefined/);
});

test("an empty result still dumps a readable skeleton", () => {
  const dump = dumpResult(
    { pdf: null, pages: [], diagnostics: [], stats: { pages: 0, steps: 0, bytes: 0 } },
    "empty.tex",
  );
  assert.match(dump, /pages: 0/);
  assert.match(dump, /## diagnostics\n {2}\(none\)/);
});

test("compareDump returns null for identical dumps", () => {
  assert.equal(compareDump("a\nb\n", "a\nb\n"), null);
});

test("compareDump shows the changed line with surrounding context", () => {
  const before = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
  const after = ["l1", "l2", "l3", "CHANGED", "l5", "l6", "l7"].join("\n");
  const diff = compareDump(before, after);
  assert.ok(diff !== null);
  assert.match(diff, /^--- golden\n\+\+\+ actual\n/);
  assert.match(diff, /@@ golden line 1 @@/);
  assert.match(diff, /^-l4$/m);
  assert.match(diff, /^\+CHANGED$/m);
  // Context on both sides, but not the whole file.
  assert.match(diff, /^ l3$/m);
  assert.match(diff, /^ l5$/m);
});

test("compareDump handles insertions and deletions, not just replacements", () => {
  const diff = compareDump("a\nb\nc\n", "a\nc\n");
  assert.ok(diff !== null);
  assert.match(diff, /^-b$/m);
  // `[^+]` so the `+++ actual` header does not count as an added line.
  assert.doesNotMatch(diff, /^\+[^+]/m);
});

test("a missing golden fails with the blessing instructions", () => {
  assert.throws(
    () => checkGolden("does-not-exist", "anything\n", { goldenDir: mkdtempSync(join(tmpdir(), "typeset-")), bless: false }),
    /UPDATE_GOLDEN=1/,
  );
});

test("blessing writes the golden, and the written golden then matches", () => {
  const goldenDir = mkdtempSync(join(tmpdir(), "typeset-"));
  const dump = dumpResult(stubCompile({ "hello.tex": new Uint8Array(0) }, "hello.tex"), "hello.tex");

  checkGolden("blessed", dump, { goldenDir, bless: true });
  assert.equal(readFileSync(join(goldenDir, "blessed.txt"), "utf8"), dump);

  // The round trip is the point: what blessing writes is what checking accepts.
  assert.doesNotThrow(() => checkGolden("blessed", dump, { goldenDir, bless: false }));
  assert.throws(
    () => checkGolden("blessed", `${dump}extra\n`, { goldenDir, bless: false }),
    /golden mismatch/,
  );
});
