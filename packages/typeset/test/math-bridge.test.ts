import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createMathRenderer, checkMathSubset, classifyTexError, readMathGeometry } from "../src/math/index.ts";
import type { MathRenderer, MathResult } from "../src/math/index.ts";
import type { Diagnostic, SourceRef } from "../src/index.ts";

/**
 * Brief 40, chunk 40.2: the MathJax bridge and the subset gate (D41).
 *
 * Three things are under test, and they fail in very different ways:
 *
 * 1. **The bridge draws.** TeX in, SVG plus placement geometry out. A wrong
 *    number here is a formula sitting off the baseline, which is *subtly* wrong
 *    across a whole page — so the geometry is asserted as numbers, not merely
 *    as "something came back".
 * 2. **Every failure is loud** (D38). Undefined macros, syntax errors and
 *    out-of-subset constructs each produce a `Diagnostic`, with the *right*
 *    code: `unsupported` for real LaTeX we declined, `undefined-command` for a
 *    thing that does not exist. `wiki/typeset.md` records that the engine has
 *    conflated those twice already.
 * 3. **The gate reads the MathML, not the source.** The proof is a macro: a
 *    `\newcommand` whose body hides `\begin{cases}` has no `cases` anywhere in
 *    its TeX, and a source-level regex would wave it through.
 *
 * ## Why one renderer, and why one test spawns a child process
 *
 * `MathJax.init()` is a **per-process singleton**: measured against
 * `mathjax@4.1.3`, a second call with a *different* config returns the first
 * instance and silently ignores the new one. So the whole file shares one
 * renderer, and the single test that needs MathJax configured the other way —
 * the `noundefined` counter-proof, which is the reason settled call §4 exists —
 * runs in its own Node process. Asserting only the configured-correctly half
 * would leave the claim "left alone, MathJax renders undefined macros as red
 * text with no error" untested, and that claim is the entire justification for
 * dropping the package.
 */

const AT: SourceRef = { file: "main.tex", line: 12 };
const PACKAGE_ROOT = join(import.meta.dirname, "..");

/**
 * Built once. `init()` reads MathJax's components off disk and is the slow part
 * of this file by an order of magnitude; it is also a singleton, so building
 * per test would buy nothing but wall time.
 */
const renderer: MathRenderer = await createMathRenderer();

function codesOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code ?? "(none)");
}

/** Every diagnostic this subsystem emits must be placeable in the editor. */
function assertWellFormed(result: MathResult): void {
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.file, AT.file);
    assert.equal(diagnostic.line, AT.line);
    assert.notEqual(diagnostic.message, "");
  }
  // `run` and `diagnostics` are exclusive by contract: there is no "rendered,
  // but with a warning" state, because a run this engine is unsure about must
  // not reach a published PDF looking confident.
  assert.equal(result.run === null, result.diagnostics.length > 0);
}

test("inline math renders to a self-contained SVG with placement geometry", () => {
  const result = renderer.render({ tex: "x^2", display: false, at: AT });
  assertWellFormed(result);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.run, null);
  const run = result.run;
  if (run === null) return;

  assert.match(run.svg, /^<svg\b/);
  assert.match(run.svg, /<\/svg>$/);
  assert.equal(run.display, false);

  // `fontCache: "none"` inlines glyph outlines. Chunk 40.1's emitter resolves
  // neither `<use>` nor `<defs>`, and its failure mode is drawing nothing where
  // a glyph should be, so this is asserted rather than assumed (settled call §2).
  assert.ok(run.svg.includes("<path"), "glyphs must be inlined as <path> data");
  assert.ok(!run.svg.includes("<use"), "fontCache:\"none\" must leave no <use> to resolve");
  assert.ok(!run.svg.includes("<defs"), "fontCache:\"none\" must leave no <defs> to resolve");

  // Geometry is in `ex` — a property of the surrounding text font, which this
  // subsystem does not know. `x^2` is a superscript on the baseline: a little
  // wider than it is tall, and hanging only a hair below the baseline.
  const { geometry } = run;
  assert.ok(geometry.widthEx > 1 && geometry.widthEx < 5, `widthEx out of range: ${geometry.widthEx}`);
  assert.ok(geometry.heightEx > 1 && geometry.heightEx < 5, `heightEx out of range: ${geometry.heightEx}`);
  assert.ok(geometry.verticalAlignEx <= 0, "an ascender-only run must not sit above its baseline");
  assert.ok(geometry.verticalAlignEx > -1, `verticalAlignEx out of range: ${geometry.verticalAlignEx}`);
  assert.ok(geometry.viewBox.width > 0 && geometry.viewBox.height > 0);
});

test("display style is a different typesetting, not just different spacing", () => {
  // `\sum_{i=1}^{n}` sets its limits above and below in display style and beside
  // the sign inline. If `display` were ignored the two would come out the same
  // size, so the assertion is on the box rather than on the flag being echoed.
  const inline = renderer.render({ tex: "\\sum_{i=1}^{n} i", display: false, at: AT });
  const display = renderer.render({ tex: "\\sum_{i=1}^{n} i", display: true, at: AT });
  assert.deepEqual(inline.diagnostics, []);
  assert.deepEqual(display.diagnostics, []);
  assert.notEqual(inline.run, null);
  assert.notEqual(display.run, null);
  if (inline.run === null || display.run === null) return;

  assert.equal(inline.run.display, false);
  assert.equal(display.run.display, true);
  assert.ok(
    display.run.geometry.heightEx > inline.run.geometry.heightEx,
    `display should stack the limits and grow taller: ${display.run.geometry.heightEx} vs ${inline.run.geometry.heightEx}`,
  );
  assert.notEqual(inline.run.svg, display.run.svg);
});

test("an undefined macro is a diagnostic, not red text", () => {
  const result = renderer.render({ tex: "\\unknowncmd x", display: false, at: AT });
  assertWellFormed(result);
  assert.equal(result.run, null, "an expression that failed must never be drawn");
  assert.deepEqual(codesOf(result.diagnostics), ["undefined-command"]);
  assert.equal(result.diagnostics[0]?.construct, "\\unknowncmd");
  assert.match(result.diagnostics[0]?.message ?? "", /\\unknowncmd/);
});

test("MathJax with `noundefined` left in renders an undefined macro silently", () => {
  // The counter-proof for settled call §4, and the reason `bridge.ts` drops the
  // package. It runs in a child process because `init()` is a per-process
  // singleton and the rest of this file has already configured it correctly.
  //
  // If this test ever fails because MathJax started reporting undefined macros
  // on its own, the *fix* is to delete this test — never to stop dropping the
  // package, which the test above is what actually guards.
  const script = `
    const { init } = await import("mathjax");
    const captured = [];
    const MathJax = await init({
      loader: { load: ["input/tex", "output/svg"] },
      svg: { fontCache: "none" },
      tex: { formatError: (jax, err) => { captured.push(err.message); return jax.formatError(err); } },
    });
    const mml = MathJax.tex2mml("\\\\unknowncmd", { display: false });
    console.log(JSON.stringify({
      packages: MathJax.config.tex.packages,
      captured,
      red: /mathcolor="red"/.test(mml),
      merror: mml.includes("merror"),
    }));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  const observed = JSON.parse(stdout.trim()) as {
    packages: string[];
    captured: string[];
    red: boolean;
    merror: boolean;
  };

  assert.ok(observed.packages.includes("noundefined"), "MathJax's default package set still includes noundefined");
  assert.deepEqual(observed.captured, [], "with noundefined loaded, formatError is never called");
  assert.equal(observed.merror, false, "with noundefined loaded, nothing marks the expression as failed");
  assert.equal(observed.red, true, "with noundefined loaded, the undefined macro is set as red text instead");
});

test("a syntax error is a diagnostic naming what went wrong", () => {
  const result = renderer.render({ tex: "\\frac{1}", display: true, at: AT });
  assertWellFormed(result);
  assert.equal(result.run, null);
  assert.deepEqual(codesOf(result.diagnostics), ["syntax"]);
  // Malformed source, not an unimplemented construct: `\frac` is very much
  // implemented, this use of it is simply missing its second argument.
  assert.match(result.diagnostics[0]?.message ?? "", /Missing argument for \\frac/);
});

test("out-of-subset but valid: `cases` is refused even though MathJax draws it", () => {
  const tex = "\\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}";
  const result = renderer.render({ tex, display: true, at: AT });
  assertWellFormed(result);
  assert.equal(result.run, null, "a gated construct must not be drawn");
  assert.deepEqual(codesOf(result.diagnostics), ["unsupported"]);
  assert.equal(result.diagnostics[0]?.construct, "cases");
  // `unsupported`, never `undefined-environment`: `cases` is real amsmath and
  // telling an author it does not exist would be a lie (D38).
  assert.match(result.diagnostics[0]?.message ?? "", /does not implement cases/);
});

test("out-of-subset but valid: `\\DeclareMathOperator` is refused at its point of use", () => {
  const result = renderer.render({
    tex: "\\DeclareMathOperator{\\spn}{span}\\spn(x)",
    display: true,
    at: AT,
  });
  assertWellFormed(result);
  assert.equal(result.run, null);
  assert.deepEqual(codesOf(result.diagnostics), ["unsupported"]);
  // The declaration leaves no MathML of its own — what the gate sees is the
  // `\operatorname{span}` it expanded into, which is the construct that was
  // actually typeset. Naming that is honest; naming a command whose only trace
  // is the raw source would be the source-regex this design rejects.
  assert.equal(result.diagnostics[0]?.construct, "\\operatorname");
});

test("the gate reads the MathML, so a macro cannot hide an out-of-subset construct", () => {
  // The load-bearing test for settled call §5. There is no `cases` in this
  // source — only `\mycases` — so a regex over the TeX would find nothing.
  const hidden = renderer.render({
    tex: "\\newcommand{\\mycases}{\\begin{cases}1&a\\\\2&b\\end{cases}}\\mycases",
    display: true,
    at: AT,
  });
  assertWellFormed(hidden);
  assert.equal(hidden.run, null);
  assert.deepEqual(codesOf(hidden.diagnostics), ["unsupported"]);
  assert.equal(hidden.diagnostics[0]?.construct, "cases");

  // And the control: the same `\newcommand` mechanism wrapping something that
  // *is* in the subset must still compile, or the gate would just be refusing
  // macros.
  const allowed = renderer.render({
    tex: "\\newcommand{\\myfrac}[2]{\\frac{#1}{#2}}\\myfrac{a}{b}",
    display: true,
    at: AT,
  });
  assert.deepEqual(allowed.diagnostics, []);
  assert.notEqual(allowed.run, null);
});

test("in-subset constructs render with no diagnostic at all", () => {
  // One case per bullet of brief 40's "In" list. This is the other half of the
  // gate's job: an allowlist that refuses correct input is a bug, not caution.
  const inSubset = [
    "x^2 + y_1 - z_{a}^{b}",
    "\\frac{a}{b} + \\dfrac{c}{d} + \\tfrac{e}{f}",
    "\\sqrt{2} + \\sqrt[3]{x}",
    "\\sum_{i=1}^{n} i \\quad \\prod_j x \\quad \\int_0^\\infty e^{-x}\\,dx",
    "\\binom{n}{k}",
    "\\overbrace{a+b}^{s} \\underbrace{c+d}_{t}",
    "\\hat{x} \\vec{v} \\tilde{a} \\bar{y} \\dot{z} \\overline{w}",
    "\\left( \\frac{1}{2} \\right] \\left\\{ x \\right\\} \\bigl( a \\Bigr]",
    "\\begin{matrix}1&2\\\\3&4\\end{matrix}",
    "\\begin{pmatrix}1\\end{pmatrix}\\begin{bmatrix}1\\end{bmatrix}\\begin{vmatrix}1\\end{vmatrix}",
    "\\begin{array}{l|cr} a & b & c \\\\ d & e & f \\end{array}",
    "\\begin{align} a &= b \\\\ c &= d \\end{align}",
    "\\begin{gather} a \\\\ b \\end{gather}",
    "\\begin{split} a &= b \\end{split}",
    "\\alpha\\beta\\Gamma\\Omega \\le \\ne \\approx \\in \\subseteq",
    "\\to \\rightarrow \\Leftrightarrow \\mapsto \\longrightarrow",
    "\\sin x + \\cos y + \\log z + \\lim_{h \\to 0} f(h) + \\max_{a} g",
    "\\mathbb{R} \\mathcal{L} \\mathrm{d} \\mathbf{v} \\mathit{x}",
    "\\text{if and only if}",
    "\\infty \\partial \\nabla \\forall \\exists \\emptyset \\cdots \\ldots",
    "\\frac{\\partial f}{\\partial x} = \\lim_{h \\to 0} \\frac{f(x+h)-f(x)}{h}",
  ];
  for (const tex of inSubset) {
    const result = renderer.render({ tex, display: true, at: AT });
    assert.deepEqual(
      result.diagnostics,
      [],
      `in-subset construct was refused: ${tex}\n  ${result.diagnostics.map((d) => d.message).join("\n  ")}`,
    );
    assert.notEqual(result.run, null, tex);
  }
});

test("every out-of-subset construct is refused, and with the right code", () => {
  // The `construct` field is what the editor groups on, so it is asserted
  // alongside the code. `expected` is the code, `construct` what it names.
  const cases: readonly { tex: string; code: string; construct: string }[] = [
    // MathJax renders all of these cleanly; the gate refuses them anyway (D41).
    { tex: "\\begin{smallmatrix}1&2\\end{smallmatrix}", code: "unsupported", construct: "smallmatrix" },
    { tex: "\\substack{a\\\\b}", code: "unsupported", construct: "subarray" },
    { tex: "\\begin{multline} a \\\\ b \\end{multline}", code: "unsupported", construct: "multline" },
    { tex: "\\begin{eqnarray} a &=& b \\end{eqnarray}", code: "unsupported", construct: "eqnarray" },
    { tex: "\\xrightarrow{f}", code: "unsupported", construct: "\\xrightarrow" },
    { tex: "\\genfrac{(}{)}{0pt}{}{a}{b}", code: "unsupported", construct: "\\genfrac" },
    { tex: "\\mathsf{s}", code: "unsupported", construct: "\\mathsf" },
    // `\displaystyle` and `\boldsymbol` were on this list until 2026-08-29,
    // when the owner admitted both as common enough in ordinary papers to be
    // worth widening D41's gate. They are asserted as *rendering* in
    // `math-layout.test.ts` now. Do not restore them here.
    { tex: "\\phantom{x}", code: "unsupported", construct: "\\phantom" },
    // These MathJax cannot render either, because `bridge.ts` dropped the
    // packages — but they are real LaTeX, so `unsupported` and never
    // `undefined-command`. This fork is the one `wiki/typeset.md` records the
    // engine getting wrong twice.
    { tex: "\\color{red}{x}", code: "unsupported", construct: "\\color" },
    { tex: "\\href{https://example.com}{y}", code: "unsupported", construct: "\\href" },
    { tex: "\\cancel{x}", code: "unsupported", construct: "\\cancel" },
    { tex: "\\ce{H2O}", code: "unsupported", construct: "\\ce" },
    { tex: "\\newtheorem{thm}{Theorem}", code: "unsupported", construct: "\\newtheorem" },
    { tex: "\\begin{CD} A @>>> B \\end{CD}", code: "unsupported", construct: "CD" },
    { tex: "\\begin{tikzpicture}\\end{tikzpicture}", code: "unsupported", construct: "tikzpicture" },
    // MathJax's `\text{}` implements the accent commands and none of the
    // ligature, special-letter or symbol macros. Real LaTeX every one, so
    // `unsupported` with advice — "write the character" — rather than a claim
    // that `\ss` does not exist.
    { tex: "\\text{Stra\\ss e}", code: "unsupported", construct: "\\ss" },
    { tex: "\\text{\\oe uvre}", code: "unsupported", construct: "\\oe" },
    { tex: "\\text{gar\\c{c}on}", code: "unsupported", construct: "\\c" },
    { tex: "\\text{\\pounds 100}", code: "unsupported", construct: "\\pounds" },
    // And the genuine typo, which must NOT be dressed up as `unsupported`.
    { tex: "\\notacommand{x}", code: "undefined-command", construct: "\\notacommand" },
    { tex: "\\begin{notanenvironment}x\\end{notanenvironment}", code: "undefined-environment", construct: "notanenvironment" },
  ];
  for (const { tex, code, construct } of cases) {
    const result = renderer.render({ tex, display: true, at: AT });
    assertWellFormed(result);
    assert.equal(result.run, null, `must not be drawn: ${tex}`);
    assert.deepEqual(codesOf(result.diagnostics), [code], `wrong code for ${tex}`);
    assert.equal(result.diagnostics[0]?.construct, construct, `wrong construct for ${tex}`);
  }
});

test("a document cannot make MathJax load anything", () => {
  // `\require` is MathJax's "go and load a component" hook, and with `require`
  // and `autoload` present it makes `tex2svg` *throw* rather than diagnose —
  // and, worse, lets the document choose what the engine reads off disk. That
  // is the exact property the fontkit precedent in `wiki/typeset.md` depends on
  // not being true, so it is asserted here rather than left to review.
  for (const tex of ["\\require{physics}", "\\require{mhchem}", "\\color{red}{x}"]) {
    const result = renderer.render({ tex, display: false, at: AT });
    assertWellFormed(result);
    assert.equal(result.run, null);
    assert.deepEqual(codesOf(result.diagnostics), ["unsupported"], tex);
    assert.ok(
      !result.diagnostics.some((d) => /retry|asynchronous/i.test(d.message)),
      `${tex} must be diagnosed, never turned into a thrown async retry`,
    );
  }
});

test("one refused construct is one diagnostic, however many times it appears", () => {
  // A matrix of `\mathsf` cells is one decision the author has to make, not
  // thirty. The editor groups on `construct`, and thirty identical rows would
  // bury whatever else went wrong in the same document.
  const result = renderer.render({
    tex: "\\begin{matrix}\\mathsf{a}&\\mathsf{b}\\\\\\mathsf{c}&\\mathsf{d}\\end{matrix}",
    display: true,
    at: AT,
  });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.construct, "\\mathsf");
});

test("the gate never reads the root <math> element's data-latex", () => {
  // MathJax echoes the whole run onto the root as `data-latex`. Reading it would
  // be the source-level regex settled call §5 rejects — and it would also make
  // the gate fire on text that was never typeset. `checkMathSubset` is exercised
  // directly here because no TeX input can produce this shape on purpose.
  const mathml =
    '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\begin{cases}1\\end{cases}">' +
    '<mi data-latex="x">x</mi></math>';
  assert.deepEqual(checkMathSubset(mathml, AT), []);
});

test("classifyTexError keeps `unsupported` and `undefined-command` apart", () => {
  // Straight at the fork, without a render, so a change to either table shows up
  // as this test rather than as a subtly mislabelled diagnostic in a PDF.
  const declined = classifyTexError("Undefined control sequence \\color", AT);
  assert.equal(declined.code, "unsupported");
  assert.equal(declined.construct, "\\color");

  const typo = classifyTexError("Undefined control sequence \\clor", AT);
  assert.equal(typo.code, "undefined-command");
  assert.equal(typo.construct, "\\clor");

  const declinedEnvironment = classifyTexError("Unknown environment 'CD'", AT);
  assert.equal(declinedEnvironment.code, "unsupported");
  assert.equal(declinedEnvironment.construct, "CD");

  const typoEnvironment = classifyTexError("Unknown environment 'pmatrixx'", AT);
  assert.equal(typoEnvironment.code, "undefined-environment");
  assert.equal(typoEnvironment.construct, "pmatrixx");

  assert.equal(classifyTexError("Extra close brace or missing open brace", AT).code, "syntax");
});

test("geometry that cannot be read is an engine error, never a guessed box", () => {
  // The document cannot cause this — it would mean MathJax's output shape moved
  // under a version bump. A guessed baseline is the silent wrong answer D38
  // exists to prevent, so the failure is `internal` and there is no geometry.
  const noUnits = readMathGeometry('<svg style="vertical-align: -1.5em;" width="2ex" height="3ex" viewBox="0 0 1 1">', AT);
  assert.equal(noUnits.geometry, null);
  assert.deepEqual(codesOf(noUnits.diagnostics), ["internal"]);
  assert.match(noUnits.diagnostics[0]?.message ?? "", /vertical-align/);

  const noViewBox = readMathGeometry('<svg style="vertical-align: 0;" width="2ex" height="3ex">', AT);
  assert.equal(noViewBox.geometry, null);
  assert.deepEqual(codesOf(noViewBox.diagnostics), ["internal"]);

  const notSvg = readMathGeometry("<span>nope</span>", AT);
  assert.equal(notSvg.geometry, null);
  assert.deepEqual(codesOf(notSvg.diagnostics), ["internal"]);

  // A bare `0` is a length, not a missing value: `0ex` and `0` are the same, and
  // it is what MathJax writes for a run that sits exactly on the baseline.
  const flat = readMathGeometry('<svg style="vertical-align: 0;" width="2.5ex" height="1ex" viewBox="0 -442 572 453">', AT);
  assert.deepEqual(flat.diagnostics, []);
  assert.deepEqual(flat.geometry, {
    verticalAlignEx: 0,
    widthEx: 2.5,
    heightEx: 1,
    viewBox: { minX: 0, minY: -442, width: 572, height: 453 },
  });
});

test("rendering is deterministic", () => {
  // Goldens elsewhere in this package depend on it, and a font cache that leaked
  // ids between calls would break them in a way nothing else here would catch.
  const first = renderer.render({ tex: "\\frac{a}{b}", display: true, at: AT });
  const second = renderer.render({ tex: "\\frac{a}{b}", display: true, at: AT });
  assert.equal(first.run?.svg, second.run?.svg);
  assert.deepEqual(first.run?.geometry, second.run?.geometry);
});

test("the whole symbol sweep renders synchronously — no font range loads lazily", () => {
  // The guard on `FONT_WARMUP`. MathJax v4 loads New Computer Modern in dynamic
  // ranges, and a cold `\mathbb{R}` *throws* rather than draws. `render()` is
  // synchronous by contract, so every range brief 40's In list can reach has to
  // be in memory before a caller ever gets the renderer.
  //
  // A range the warm-up misses shows up here as a diagnostic mentioning a load —
  // which is the point: a red test, not a thrown retry inside someone's compile.
  const sweep = [
    "\\mathbb{R}\\mathbb{Z}\\mathbb{N}\\mathbb{Q}\\mathbb{C}",
    "\\mathcal{L}\\mathcal{A}\\mathcal{F}\\mathcal{O}\\mathcal{P}",
    "\\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta\\iota\\kappa\\lambda\\mu\\nu\\xi\\pi\\rho\\sigma\\tau\\upsilon\\phi\\chi\\psi\\omega",
    "\\Gamma\\Delta\\Theta\\Lambda\\Xi\\Pi\\Sigma\\Upsilon\\Phi\\Psi\\Omega",
    "\\varepsilon\\varphi\\vartheta\\varrho\\varsigma\\varpi",
    "\\to\\gets\\longrightarrow\\hookrightarrow\\rightleftharpoons\\Longleftrightarrow\\mapsto\\uparrow\\downarrow\\nearrow\\rightsquigarrow\\twoheadrightarrow\\Rightarrow\\Leftrightarrow",
    "\\sum\\int\\oint\\iint\\prod\\coprod\\bigcup\\bigcap\\bigoplus\\bigotimes\\bigwedge\\bigvee\\bigsqcup",
    "\\aleph\\hbar\\wp\\Re\\Im\\partial\\nabla\\forall\\exists\\neg\\emptyset\\varnothing\\infty\\top\\bot\\vdash\\models\\ell\\angle\\surd\\imath\\jmath",
    "\\triangle\\square\\diamond\\bigcirc\\star\\bullet\\circ\\dagger\\ddagger\\clubsuit\\spadesuit\\heartsuit\\diamondsuit\\flat\\sharp\\natural",
    "\\le\\ge\\ne\\approx\\equiv\\sim\\simeq\\cong\\subset\\supset\\subseteq\\supseteq\\in\\ni\\notin\\propto\\perp\\parallel\\preceq\\succeq\\lesssim\\gtrsim\\nleq\\ngeq\\doteq\\asymp\\therefore\\because",
    "\\pm\\mp\\times\\div\\cdot\\ast\\cap\\cup\\oplus\\ominus\\otimes\\oslash\\odot\\wedge\\vee\\setminus\\uplus\\sqcup\\sqcap\\amalg\\wr\\boxplus",
    "\\hat{x}\\check{x}\\breve{x}\\mathring{x}\\ddot{x}\\widehat{abc}\\widetilde{abc}\\overrightarrow{ab}\\vec{x}\\dot{x}\\acute{x}\\grave{x}\\tilde{x}\\bar{x}\\overline{abc}\\underline{abc}",
    "\\text{caf\u00e9 na\u00efve Stra\u00dfe \u00c5ngstr\u00f6m \u0153uvre \u00a3100 \u00a9 \u2020}",
    "\\text{caf\\'e na\\\"ive \\~nandu \\^etre}",
    "\\left\\langle x\\right\\rangle\\left\\lceil x\\right\\rceil\\left\\lfloor x\\right\\rfloor\\left\\|x\\right\\|\\left\\vert x\\right\\vert",
    "\\cdots\\ldots\\vdots\\ddots\\dots",
    "\\Bigg(\\bigg[\\Big\\{\\big|\\biggl\\langle\\Biggr\\rangle",
  ];
  for (const tex of sweep) {
    for (const display of [true, false]) {
      const result = renderer.render({ tex, display, at: AT });
      assert.deepEqual(
        result.diagnostics,
        [],
        `symbol sweep failed (display=${display}): ${tex}\n  ${result.diagnostics.map((d) => d.message).join("\n  ")}`,
      );
      assert.notEqual(result.run, null);
    }
  }
});

test("a run is always exactly one <svg> — MathJax's own line breaking is off", () => {
  // MathJax v4 breaks long *inline* math by itself, emitting several `<svg>`s
  // separated by `<mjx-break>` inside one container. Measured: this expression
  // came back as seven children before `linebreaks: { inline: false }`.
  //
  // Brief 40 puts line breaking inside math explicitly out of scope, Atrium
  // already breaks lines with Knuth-Plass over its own boxes, and brief 40's
  // overrun check needs one unbroken width to measure against the text block.
  // A pre-broken run would quietly defeat all three.
  const wide =
    "\\to\\gets\\longrightarrow\\hookrightarrow\\rightleftharpoons\\Longleftrightarrow\\mapsto" +
    "\\uparrow\\downarrow\\nearrow\\rightsquigarrow\\twoheadrightarrow\\Rightarrow\\Leftrightarrow";
  for (const display of [true, false]) {
    const result = renderer.render({ tex: wide, display, at: AT });
    assert.deepEqual(result.diagnostics, []);
    const svg = result.run?.svg ?? "";
    assert.equal(svg.match(/<svg\b/g)?.length, 1, "a run must be a single <svg>");
    assert.ok(!svg.includes("mjx-break"), "MathJax must not have broken the run into lines");
    // And the width is the run's real natural width, which is what the overrun
    // check downstream compares against the text block.
    assert.ok((result.run?.geometry.widthEx ?? 0) > 20, "a broken run would report only its first line's width");
  }
});
