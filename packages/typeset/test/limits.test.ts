import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompileResult } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import { loadFixture } from "./harness.ts";

/**
 * Adversarial tests for the resource-limit machinery (brief 37, chunk 9, D38):
 * the deterministic step budget, `maxPages`, `maxOutputBytes` and cooperative
 * cancellation. Chunk 7 wired the enforcement; nothing before this chunk tried
 * to break it on purpose.
 *
 * Every assertion here is about diagnostics, counts, byte lengths and elapsed
 * time — never about a layout position or a golden dump — so this file cannot
 * collide with a parallel chunk that is editing layout code.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function project(body: string): { files: Record<string, Uint8Array>; entrypoint: string } {
  return {
    files: { "main.tex": encode(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`) },
    entrypoint: "main.tex",
  };
}

function budgetDiagnostics(result: CompileResult) {
  return result.diagnostics.filter((d) => d.code === "budget-exceeded");
}

/** A handful of short paragraphs — small enough that the whole pipeline
 * (resolve-inputs, macro expansion, document building, layout) runs in a
 * fraction of the step counts below, which is what lets a fine-grained scan
 * over `stepBudget` land inside each pipeline stage in turn. */
function smallDocument(): { files: Record<string, Uint8Array>; entrypoint: string } {
  const paras = Array.from(
    { length: 5 },
    (_, i) => `Paragraph number ${i} with some words in it to spend steps and steps and steps.`,
  ).join("\n\n");
  return project(paras);
}

// --- the step budget ---------------------------------------------------

test("a low step budget stops the compile with exactly one diagnostic and steps === stepBudget", () => {
  // `prose` is plain text with no macros, so every spend() during the run
  // costs exactly 1 — the budget is hit on the nose rather than overshot by a
  // multi-unit macro-expansion charge.
  const fixture = loadFixture("prose");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, stepBudget: 50 });
  assert.equal(result.pdf, null);
  const diags = budgetDiagnostics(result);
  assert.equal(
    diags.length,
    1,
    `expected exactly one budget-exceeded diagnostic, got ${diags.length}: ${JSON.stringify(diags)}`,
  );
  assert.equal(result.stats.steps, 50);
});

test("a step budget large enough for the document produces no budget diagnostic", () => {
  const fixture = loadFixture("prose");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, stepBudget: 5_000_000 });
  assert.equal(budgetDiagnostics(result).length, 0);
  assert.ok(result.pdf !== null);
});

/**
 * `compile()` gives the document-building stage its own `Budget` object and
 * the layout stage a *second*, freshly created one (`compile.ts`: `const
 * budget = createBudget(Math.max(0, opts.stepBudget - build.steps), ...)`).
 * Each `Budget` has its own independent `reported` latch, so when the
 * document-building stage is the one that actually exhausts the shared
 * step count — after already flushing some blocks, which the layout stage
 * then tries to walk — the fresh layout budget's very first `spend()` call
 * also trips (its `remaining` starts at 0 or below), and `compileProject`'s
 * own `if (budget.stopped && !budget.reported)` check does not know the
 * document layer already reported the same exhaustion. The result is two
 * `budget-exceeded` diagnostics for one runaway compile.
 *
 * This is exactly the failure mode the brief asked this chunk to rule out.
 * It reproduces reliably in a narrow but real band of `stepBudget` values —
 * scanned here rather than pinned to one magic number, since the exact band
 * shifts with per-node step costs that are not this test's business to know.
 */
/*
 * Was a confirmed bug, fixed 2026-08-27: `compileProject` builds a second
 * `Budget` for the layout stage, which reset the `reported` latch that
 * `Budget` documents as shared across stages — so a run the document layer had
 * already reported was reported again the moment layout's first `spend()`
 * tripped. The latch is now carried across the stage boundary. Kept as a
 * regression test rather than deleted: the two-Budget structure is still there,
 * so the bug is one refactor away from returning.
 */
test("no double-report when the document-building stage is the one that runs out", () => {
    const { files, entrypoint } = smallDocument();
    for (let budget = 10; budget <= 800; budget += 5) {
      const result = compile(files, entrypoint, { fonts, stepBudget: budget });
      const diags = budgetDiagnostics(result);
      assert.ok(
        diags.length <= 1,
        `stepBudget=${budget}: expected at most one budget-exceeded diagnostic, got ` +
          `${diags.length}: ${JSON.stringify(diags.map((d) => d.message))}`,
      );
    }
  },
);

// --- infinite macro recursion -------------------------------------------

test("a self-referential macro (\\x -> \\x) terminates with a diagnostic, never a hang", () => {
  const src = "\\documentclass{article}\n\\newcommand{\\x}{\\x}\n\\begin{document}\n\\x\n\\end{document}\n";
  const t0 = performance.now();
  const result = compile({ "main.tex": encode(src) }, "main.tex", { fonts });
  const elapsed = performance.now() - t0;
  assert.equal(result.pdf, null);
  assert.equal(budgetDiagnostics(result).length, 1);
  assert.match(result.diagnostics[0]!.message, /never terminates/);
  assert.ok(elapsed < 2000, `expected the recursion to be caught quickly, took ${elapsed.toFixed(1)}ms`);
});

test(
  "a doubling macro (\\l -> \\l\\l) terminates well under a second — pins the 17s splice regression",
  () => {
    const src = "\\documentclass{article}\n\\newcommand{\\l}{\\l\\l}\n\\begin{document}\n\\l\n\\end{document}\n";
    const t0 = performance.now();
    const result = compile({ "main.tex": encode(src) }, "main.tex", { fonts });
    const elapsed = performance.now() - t0;
    assert.equal(result.pdf, null);
    assert.equal(budgetDiagnostics(result).length, 1);
    // A splice-based expansion once took 17 seconds on this exact input; the
    // pushback-queue design (see macro/expand.ts) is what keeps this fast.
    assert.ok(elapsed < 1000, `doubling macro took ${elapsed.toFixed(1)}ms — expected well under 1000ms`);
  },
);

test("a doubling macro is stopped by the pending-node cap before the step budget is even reached", () => {
  // With the engine's generous default 5,000,000-step budget, `\l -> \l\l`
  // should never get anywhere near it: `MAX_PENDING` (200,000 unread nodes)
  // fires first, which is the property that keeps the doubling case fast
  // regardless of how large `stepBudget` is configured.
  const src = "\\documentclass{article}\n\\newcommand{\\l}{\\l\\l}\n\\begin{document}\n\\l\n\\end{document}\n";
  const result = compile({ "main.tex": encode(src) }, "main.tex", { fonts });
  assert.ok(result.stats.steps < 5_000_000, `expected to stop well short of the step budget, got ${result.stats.steps}`);
  assert.match(result.diagnostics[0]!.message, /unread nodes/);
});

// --- maxPages -------------------------------------------------------------

test("maxPages stops a runaway document with one diagnostic and no unbounded work", () => {
  const body = Array.from({ length: 500 }, (_, i) => `Text ${i}.\n\n\\newpage`).join("\n\n");
  const { files, entrypoint } = project(body);
  const t0 = performance.now();
  const result = compile(files, entrypoint, { fonts, maxPages: 3 });
  const elapsed = performance.now() - t0;
  assert.equal(result.pages.length, 3);
  assert.equal(result.pdf, null);
  const limitDiags = result.diagnostics.filter((d) => d.code === "limit-exceeded");
  assert.equal(limitDiags.length, 1);
  assert.ok(elapsed < 10_000, `maxPages enforcement took ${elapsed.toFixed(1)}ms`);
});

test("a maxPages large enough for the document produces no limit diagnostic", () => {
  const { files, entrypoint } = project("Text.\n\n\\newpage\n\nMore text.");
  const result = compile(files, entrypoint, { fonts, maxPages: 2000 });
  assert.ok(!result.diagnostics.some((d) => d.code === "limit-exceeded"));
  assert.ok(result.pdf !== null);
});

// --- maxOutputBytes ---------------------------------------------------------

test("maxOutputBytes rejects with no bytes and reports the size it computed", () => {
  const fixture = loadFixture("prose");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, maxOutputBytes: 10 });
  assert.equal(result.pdf, null);
  assert.equal(result.stats.bytes, 0);
  const limitDiags = result.diagnostics.filter((d) => d.code === "limit-exceeded");
  assert.equal(limitDiags.length, 1);
  // The message quotes the real, larger computed size. That is only possible
  // if the cap was checked against `planSerialization`'s size *before*
  // `writeDocument` allocated the output buffer the cap exists to avoid
  // (see pdf/render.ts: `plan.size > cap` is checked, then `writeDocument`
  // runs only in the surviving branch) — reading that source is the stronger
  // evidence; this is the behavioural half of the same claim.
  assert.match(limitDiags[0]!.message, /would be \d+ bytes/);
});

test("maxOutputBytes exactly at the PDF's real size does not reject it", () => {
  const fixture = loadFixture("prose");
  const uncapped = compile(fixture.files, fixture.entrypoint, { fonts });
  assert.ok(uncapped.pdf !== null);
  const exact = compile(fixture.files, fixture.entrypoint, { fonts, maxOutputBytes: uncapped.pdf.length });
  assert.ok(exact.pdf !== null);
  assert.deepEqual([...exact.pdf], [...uncapped.pdf]);
});

test("maxOutputBytes rejection completes quickly rather than allocating first", () => {
  // A generous but real bound: if the cap were enforced only after
  // `writeDocument` built the whole buffer, this would still pass on a small
  // fixture — the value of this test is as a smoke check alongside the
  // source-level evidence in the assertion above, not as a substitute for it.
  const fixture = loadFixture("structured");
  const t0 = performance.now();
  const result = compile(fixture.files, fixture.entrypoint, { fonts, maxOutputBytes: 1 });
  const elapsed = performance.now() - t0;
  assert.equal(result.pdf, null);
  assert.ok(elapsed < 5000, `maxOutputBytes rejection took ${elapsed.toFixed(1)}ms`);
});

// --- cancellation ------------------------------------------------------

test("an already-aborted signal produces exactly one cancellation diagnostic", () => {
  const fixture = loadFixture("prose");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, signal: { aborted: true } });
  assert.equal(result.pdf, null);
  const diags = budgetDiagnostics(result);
  assert.equal(diags.length, 1, `expected exactly one, got: ${JSON.stringify(diags)}`);
  assert.match(diags[0]!.message, /cancelled/);
  // Aborted before the very first step is spent, so nothing was charged.
  assert.equal(result.stats.steps, 0);
});

test("a signal is polled repeatedly at step boundaries, not read once at the start", () => {
  let reads = 0;
  const signal = {
    get aborted() {
      reads++;
      return reads > 20;
    },
  };
  const fixture = loadFixture("structured");
  const result = compile(fixture.files, fixture.entrypoint, { fonts, signal });
  assert.equal(result.pdf, null);
  assert.ok(reads > 20, "the signal must be polled repeatedly, not read once");
  assert.ok(budgetDiagnostics(result).some((d) => /cancelled/.test(d.message)));
});

/**
 * The same double-`Budget` design flaw documented above for a plain step
 * budget also fires for cancellation: a signal that flips mid-compile, right
 * as the document-building stage is partway through flushing blocks, trips
 * the fresh layout-stage `Budget` a second time and produces two
 * `budget-exceeded` diagnostics for one cancelled compile.
 */
/* Same root cause as the step-budget double-report above, and fixed by the same
 * carried latch — a cancellation the document layer had already reported was
 * re-observed and re-reported by the fresh layout Budget. Both paths are kept
 * because they reach the duplicate through different fields (`remaining`
 * versus `signal.aborted`), and a future change could plausibly fix one only. */
test("no double-report when cancellation lands while the document-building stage is flushing blocks", () => {
    const { files, entrypoint } = smallDocument();
    for (let threshold = 10; threshold <= 800; threshold += 5) {
      let reads = 0;
      const signal = {
        get aborted() {
          reads++;
          return reads > threshold;
        },
      };
      const result = compile(files, entrypoint, { fonts, signal });
      const diags = budgetDiagnostics(result);
      assert.ok(
        diags.length <= 1,
        `threshold=${threshold}: expected at most one budget-exceeded diagnostic, got ` +
          `${diags.length}: ${JSON.stringify(diags.map((d) => d.message))}`,
      );
    }
  },
);

// --- determinism (in-process; see determinism.test.ts for cross-process) ---

test("repeated in-process compiles of the same source are byte-identical", () => {
  const fixture = loadFixture("structured");
  const first = compile(fixture.files, fixture.entrypoint, { fonts }).pdf;
  assert.ok(first !== null);
  for (let i = 0; i < 5; i++) {
    const next = compile(fixture.files, fixture.entrypoint, { fonts }).pdf;
    assert.ok(next !== null);
    assert.deepEqual([...next], [...first]);
  }
});
