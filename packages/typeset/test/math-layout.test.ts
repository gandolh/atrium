import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompileResult, GlyphRun, Page, PlacedItem } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { createMathRenderer } from "../src/math/index.ts";
import type { MathRenderer } from "../src/math/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import { defaultDesign } from "../src/layout/design.ts";

/**
 * Brief 40, chunk 40.4: placing a set formula on the page.
 *
 * The bridge (40.2) and the emitter (40.1) each have their own suite; this one
 * is about the *seam between the engine and them* — which is where brief 40's
 * math went missing once already, and the reason several assertions below look
 * paranoid.
 *
 * **The regression this file exists for.** Before this chunk, `layout/vlist.ts`
 * had no arm for either math kind and neither dispatcher was
 * exhaustiveness-checked, so growing the `Inline`/`Block` unions produced *no*
 * typecheck error. A document with `$x^2$` and a numbered `equation` compiled
 * to a valid PDF with **zero diagnostics and no math on the page** — while
 * `\ref` still resolved, so even the labels looked healthy. That is precisely
 * the silent loss D38's failure contract exists to prevent, and it is why
 * nothing here asserts "no diagnostics" as evidence that math *rendered*: the
 * bug produced a clean diagnostic list. **Every test below asserts on placed
 * output.**
 *
 * `MathJax.init()` is a per-process singleton (see `math-bridge.test.ts` for
 * the measurement), so the whole file shares one renderer.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const design = defaultDesign();
const renderer: MathRenderer = await createMathRenderer();

function project(body: string): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  return {
    "main.tex": encoder.encode(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`),
  };
}

/** Compile with the math renderer wired in — the ordinary path for these tests. */
function run(body: string): CompileResult {
  return compile(project(body), "main.tex", { fonts, math: renderer });
}

/** Compile with **no** renderer, to prove the un-rendered path is still loud. */
function runWithoutMath(body: string): CompileResult {
  return compile(project(body), "main.tex", { fonts });
}

type PlacedMathItem = Extract<PlacedItem, { kind: "math" }>;

function mathItems(result: CompileResult): PlacedMathItem[] {
  return result.pages.flatMap((page) =>
    (page as Page).items.filter((i): i is PlacedMathItem => i.kind === "math"),
  );
}

/**
 * `\ps@plain`'s folio also renders as a `glyphrun`, well below the text body —
 * excluded so a test asserting on "the text of the page" never trips on the
 * page number at the foot of it. Same helper, same reason, as `tables.test.ts`.
 */
function glyphRuns(page: Page): GlyphRun[] {
  return page.items.filter(
    (i): i is GlyphRun => i.kind === "glyphrun" && i.y <= design.marginTop + design.textHeight,
  );
}

function pageText(result: CompileResult): string {
  return result.pages.flatMap((p) => glyphRuns(p as Page).map((g) => g.text)).join(" ");
}

/** Round to the golden dump's own precision, so float noise never trips an assertion. */
function r(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// --- the silent drop --------------------------------------------------------

test("inline and display math reach the page as placed items, not as a clean nothing", () => {
  const result = run(
    "Before the math.\nInline $x^2 + \\alpha$ here.\n\\begin{equation}\\label{eq:one}\nE = mc^2\n\\end{equation}\nAfter, see \\ref{eq:one}.",
  );

  const placed = mathItems(result);
  assert.equal(placed.length, 2, `expected one inline and one display formula, got ${placed.length}`);

  // Both carry real geometry. A zero-width or zero-height box would satisfy
  // "an item exists" while still painting nothing, which is the failure this
  // file is named after wearing a different hat.
  for (const item of placed) {
    assert.ok(item.width > 0, `a placed formula has zero width: ${item.source}`);
    assert.ok(item.height > 0, `a placed formula has zero height: ${item.source}`);
  }

  // The surrounding prose is untouched, and the equation number and the \ref
  // both resolved — the machinery either side of the formula still works.
  const text = pageText(result);
  assert.match(text, /Before the math\./);
  assert.match(text, /\(1\)/, "the equation number should be set");
  assert.match(text, /After, see 1\./, "\\ref to the equation should resolve to its number");
});

test("a math-free document places no math items at all", () => {
  // The other half of the contract: this chunk added arms to two dispatchers
  // and a third in `page.ts`, and a document with no math must take the path it
  // took before any of them existed. The goldens are the real proof; this is
  // the cheap direct assertion.
  const result = run("Just prose, no mathematics anywhere in it.");
  assert.equal(mathItems(result).length, 0);
  assert.equal(result.diagnostics.length, 0);
});

// --- placement --------------------------------------------------------------

test("a display is centred in the text measure", () => {
  const result = run("\\[ a + b = c \\]");
  const [display] = mathItems(result);
  assert.ok(display, "the display should be placed");

  const centre = display.x + display.width / 2;
  const measureCentre = design.marginLeft + design.textWidth / 2;
  assert.equal(
    r(centre),
    r(measureCentre),
    `display centre ${centre} should sit at the text-width centre ${measureCentre}`,
  );
});

test("inline math sits on the baseline of the line it is in, across a whole paragraph", () => {
  // Brief 40 calls this "the detail that betrays a bad implementation", and
  // says to verify it on a full page of prose rather than a single line — a
  // constant offset error is invisible on one line and obvious over many.
  // A formula hangs below its baseline, so a placed item's `y` (its TOP edge)
  // sits ABOVE the baseline by its own ascent; what must line up is the
  // formula's baseline against the text baseline of the same line.
  const filler = "The quick brown fox jumps over the lazy dog and keeps running. ";
  const body = Array.from({ length: 8 }, (_, i) => `${filler}Then $x_{${i}}$ appears. ${filler}`).join("");
  const result = run(body);

  const placed = mathItems(result);
  assert.equal(placed.length, 8, `expected 8 inline formulas, got ${placed.length}`);
  assert.ok(result.pages.length >= 1);

  // Every formula must share a baseline with glyphs on its own line. Group the
  // page's glyph runs by their baseline `y` and require each formula to find
  // one it overlaps vertically — a formula floating between two text lines
  // fails this, which is exactly the constant-offset bug.
  for (const page of result.pages as Page[]) {
    const runs = glyphRuns(page);
    const baselines = [...new Set(runs.map((g) => r(g.y)))];
    const onThisPage = page.items.filter((i): i is PlacedMathItem => i.kind === "math");
    for (const item of onThisPage) {
      const top = item.y;
      const bottom = item.y + item.height;
      const shares = baselines.some((b) => b >= top - 0.001 && b <= bottom + 0.001);
      assert.ok(
        shares,
        `formula ${item.source} spans y ${r(top)}..${r(bottom)} and crosses no text baseline on its page ` +
          `(baselines: ${baselines.slice(0, 12).join(", ")})`,
      );
    }
  }
});

// --- numbering --------------------------------------------------------------

test("equation numbers are continuous across several equations", () => {
  const result = run(
    "\\begin{equation}a\\end{equation}\n\\begin{equation}b\\end{equation}\n\\begin{equation}c\\end{equation}",
  );
  const text = pageText(result);
  assert.match(text, /\(1\)/);
  assert.match(text, /\(2\)/);
  assert.match(text, /\(3\)/);
  assert.equal(mathItems(result).length, 3);
});

test("a starred display is set, and carries no number", () => {
  const result = run("\\begin{equation*}a = b\\end{equation*}");
  assert.equal(mathItems(result).length, 1, "the formula is still set");
  assert.doesNotMatch(pageText(result), /\(1\)/, "a starred equation takes no number");
});

test("the equation counter and \\ref agree, and \\ref prints the bare number", () => {
  // `setEquationNumber` adds the parentheses and `formatEquationNumber` does
  // not, deliberately — a \ref prints `2`, the number beside the display prints
  // `(2)`. This asserts they have not drifted into printing the same thing.
  const result = run(
    "\\begin{equation}\\label{a}x\\end{equation}\n\\begin{equation}\\label{b}y\\end{equation}\nSee \\ref{a} and \\ref{b}.",
  );
  const text = pageText(result);
  assert.match(text, /\(1\)/);
  assert.match(text, /\(2\)/);
  assert.match(text, /See 1 and 2\./);
});

// --- the loud-failure contract ----------------------------------------------

test("a display wider than the text width is a diagnostic, not a silent overrun", () => {
  const wide = Array.from({ length: 40 }, (_, i) => `x_{${i}}+`).join("");
  const result = run(`\\[ ${wide} y \\]`);

  const overfull = result.diagnostics.filter((d) => d.code === "overfull-box");
  assert.equal(overfull.length, 1, `expected one overfull-box diagnostic, got ${result.diagnostics.length} diagnostics`);
  assert.equal(overfull[0]!.severity, "warning", "an overrun is visible and fixable, so it warns rather than refusing");
  assert.match(overfull[0]!.message, /wider than/);

  // Warned about, but still placed: brief 39 set the precedent that an oversized
  // box the author can see beats one that is nowhere.
  assert.equal(mathItems(result).length, 1, "an overrunning display is still set");
});

test("math with no renderer supplied is an error, not a silent drop", () => {
  // The same class of failure as the regression this file is named for, from a
  // different cause: a caller that forgot to inject the renderer must be told,
  // never handed a PDF with the mathematics quietly missing.
  const result = runWithoutMath("Inline $x^2$ here.");
  assert.equal(mathItems(result).length, 0);
  assert.ok(
    result.diagnostics.some((d) => d.severity === "error"),
    `expected an error when math is present and no renderer was supplied, got: ${JSON.stringify(
      result.diagnostics.map((d) => `${d.severity} ${d.code}`),
    )}`,
  );
});

test("a prose-only document still compiles with no renderer supplied", () => {
  // The renderer is optional, and must stay optional for every document that
  // never asks for mathematics.
  const result = runWithoutMath("Prose only, no mathematics.");
  assert.equal(result.diagnostics.length, 0);
  assert.ok(result.pdf !== null);
});

test("per-line numbering in a multi-line display is reported, not quietly skipped", () => {
  // A known gap: `\begin{align}` goes to MathJax as ONE run, so the per-line
  // baselines live inside a single SVG and cannot be recovered from its
  // container attributes. Brief 40 asks for per-line numbering, so this falls
  // short of the brief — and the contract that matters is that it SAYS so.
  const result = run("\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}");
  const said = result.diagnostics.filter((d) => d.code === "unsupported");
  assert.equal(said.length, 1, "the gap must be reported at the display's own line");
  assert.match(said[0]!.message, /multi-line display/);
  assert.equal(mathItems(result).length, 1, "the display itself is still set");
});

test("an unnumbered multi-line display sets cleanly", () => {
  // `align*` asks for no numbers, so the gap above cannot arise and nothing
  // should be reported — the diagnostic must be about the missing numbers, not
  // about multi-line displays in general.
  const result = run("\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}");
  assert.equal(result.diagnostics.length, 0, JSON.stringify(result.diagnostics.map((d) => d.message)));
  assert.equal(mathItems(result).length, 1);
});

// --- the render-time half of the gate ---------------------------------------

test("the widening did not become 'accept whatever MathJax renders'", () => {
  // The MathML gate's own half of D41. `\mathsf` and `\mathfrak` pass the
  // document layer — `builtins.ts` admits them at name level — and are turned
  // away here, at render, by `math/subset.ts`. That two-allowlist split is
  // chunk 40.3's recorded concern, and this test is what stops the render-side
  // list from quietly widening to match the name-side one.
  for (const [body, name] of [
    ["$\\mathfrak{g}$", "\\mathfrak"],
    ["$\\mathsf{A}$", "\\mathsf"],
    ["$\\mathtt{x}$", "\\mathtt"],
  ] as const) {
    const diagnostics = run(body).diagnostics;
    assert.ok(
      diagnostics.some((d) => d.code === "unsupported"),
      `${name} should still report unsupported, got: ${JSON.stringify(diagnostics.map((d) => d.code))}`,
    );
  }
});

test("the four admitted on 2026-08-29 render, and \\boldsymbol never reads as undefined", () => {
  for (const body of ["\\begin{gather*}a = b \\\\ c = d\\end{gather*}", "$\\displaystyle\\frac{a}{b}$", "$\\boldsymbol{\\alpha}$"]) {
    const result = run(body);
    assert.deepEqual(result.diagnostics, [], `${body} should set clean`);
    assert.ok(mathItems(result).length > 0, `${body} should actually place something`);
  }
});
