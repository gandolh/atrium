import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompileResult, Diagnostic } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * The loud-failure contract (brief 37, chunk 9, D38): every construct outside
 * the engine's subset produces a diagnostic naming it, with a file and a line
 * — never a silent skip, never a guess. Chunk 6 published the exact
 * inventory (`src/macro/builtins.ts`); this file proves every item in it, and
 * every "other site" the brief lists, actually reports.
 *
 * The lists below are transcribed from the brief rather than imported from
 * `builtins.ts`: importing the table would make this suite tautological
 * (it would only ever check whatever the source currently says), where the
 * point is to hold the source to an independently-written spec.
 *
 * Every assertion is on `diagnostics` — code, severity, `construct`, `line` —
 * never on layout, so this file cannot collide with a parallel chunk editing
 * layout code.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function compileSource(src: string): CompileResult {
  return compile({ "main.tex": encode(src) }, "main.tex", { fonts });
}

/** Wrap a body in the minimal preamble every fixture below needs. */
function doc(body: string): string {
  return `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

function unsupportedFor(result: CompileResult, construct: string): Diagnostic | undefined {
  return result.diagnostics.find((d) => d.code === "unsupported" && d.construct === construct);
}

// --- 1. commands: real LaTeX, deliberately not implemented ------------------

const UNSUPPORTED_COMMANDS = [
  // `caption` is not here: chunk 39.4 sets captions for real. Bare — which is
  // how this list calls every name — it is a caption with no float to number,
  // and that is a permanent authoring error rather than a missing capability,
  // so what it reports is `syntax`, not `unsupported`. See
  // `figures-tables-bib.test.ts`'s "a \caption outside a float is refused".
  "centering",
  "cite",
  "citep",
  "citet",
  "nocite",
  "bibliography",
  // `bibliographystyle` is not here: chunk 39.5 implemented it for real. A
  // bare `\bibliographystyle` (this list's fixture calls every name bare, with
  // no argument) is now purely a `syntax` error ("needs a style name"); the
  // `unsupported` diagnostic only fires for a *named*, unrecognised style
  // (e.g. `\bibliographystyle{apalike}`, covered in `figures-tables-bib.test.ts`),
  // which this bare-invocation harness cannot exercise.
  "bibitem",
  "textsc",
  "scshape",
  "textsl",
  "slshape",
  "marginpar",
  "footnotemark",
  "footnotetext",
  "thanks",
  "and",
  "hspace",
  "vspace",
  "hfill",
  "vfill",
  "smallskip",
  "medskip",
  "bigskip",
  "linebreak",
  "nolinebreak",
  "pagestyle",
  "thispagestyle",
  "setlength",
  "addtolength",
  "newcounter",
  "setcounter",
  "addtocounter",
  "stepcounter",
  "refstepcounter",
  "appendix",
  "chapter",
  "part",
  "index",
  "glossary",
  "newtheorem",
  "usetikzlibrary",
  "colorbox",
  "textcolor",
  "href",
  "url",
];

test("every unsupported command in the brief's inventory reports `unsupported` naming itself", () => {
  for (const name of UNSUPPORTED_COMMANDS) {
    const result = compileSource(doc(`\\${name}`));
    const hit = unsupportedFor(result, `\\${name}`);
    assert.ok(hit !== undefined, `\\${name} did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(hit.severity, "error", `\\${name} should be error-severity`);
    assert.equal(hit.line, 3, `\\${name} should point at the line it was written on`);
  }
});

// --- 2. TeX programming: permanently out of scope ---------------------------

const TEX_PROGRAMMING_COMMANDS = [
  "def",
  "gdef",
  "edef",
  "xdef",
  "let",
  "catcode",
  "expandafter",
  "noexpand",
  "csname",
  "endcsname",
  "newif",
  "ifx",
  "ifnum",
  "fi",
  "else",
  "advance",
  "multiply",
  "divide",
  "count",
  "dimen",
  "newcount",
  "newdimen",
  "hbox",
  "vbox",
  "makeatletter",
  "makeatother",
  "write",
  "immediate",
  "openout",
  "special",
];

test("every TeX-programming primitive reports `unsupported`, permanently out of scope", () => {
  for (const name of TEX_PROGRAMMING_COMMANDS) {
    const result = compileSource(doc(`\\${name}`));
    const hit = unsupportedFor(result, `\\${name}`);
    assert.ok(hit !== undefined, `\\${name} did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
    assert.match(hit.message, /permanently out of scope/);
  }
});

// --- 3. environments ---------------------------------------------------------

/**
 * `equation`, `equation*`, `align`, `align*`, `gather`, `displaymath` and
 * `math` are excluded from the main table below — see the dedicated test
 * further down, which documents why they currently fail this contract.
 */
const UNSUPPORTED_ENVIRONMENTS = [
  // `figure`, `figure*`, `table` and `table*` are gone from this inventory:
  // chunk 39.4 places floats for real, so a well-formed one now reports
  // nothing at all. `test/floats.test.ts` covers what they do instead.
  // `wrapfigure` stays — text wrapped around a float is on brief 39's Out list.
  "wrapfigure",
  "tabularx",
  "longtable",
  "array",
  "eqnarray",
  // `thebibliography` stays here for the one shape this inventory exercises
  // (a plain `\begin{thebibliography}...x...\end{thebibliography}` with no
  // real `\bibitem`, so 0 entries): chunk 39.5 still reports `unsupported`
  // for an empty list, because there is genuinely nothing to format. A
  // non-empty `thebibliography` is fully implemented and reports nothing —
  // see `figures-tables-bib.test.ts`'s bibliography section for that case.
  "thebibliography",
  "center",
  "flushleft",
  "flushright",
  "quote",
  "quotation",
  "verse",
  "minipage",
  "tikzpicture",
  "lstlisting",
  "Verbatim",
  "multicols",
  "titlepage",
  "list",
  "trivlist",
  "picture",
  "theorem",
  "proof",
];

test("every unsupported environment in the brief's inventory reports `unsupported` naming itself", () => {
  for (const name of UNSUPPORTED_ENVIRONMENTS) {
    const result = compileSource(doc(`\\begin{${name}}\nx\n\\end{${name}}`));
    const hit = unsupportedFor(result, name);
    assert.ok(hit !== undefined, `${name} did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(hit.severity, "error");
  }
});

const AMSMATH_ENVIRONMENTS = ["equation", "equation*", "align", "align*", "gather", "displaymath", "math"];

/*
 * Regression test for a bug fixed 2026-08-27, kept because both halves of it
 * would fail silently if it came back.
 *
 * `@unified-latex` hands back `mathenv` nodes whose `env` is an unnormalised
 * `{ type: "string", content, position }` object rather than a plain string —
 * unlike ordinary `environment` nodes, which is why `eqnarray` was never
 * affected and these seven were. The environment lookup then keyed on that
 * object, coerced to `"[object Object]"`, matched nothing, and reported
 * `undefined-environment` ("not a thing at all") for the single most common
 * math construct in LaTeX, where the honest answer is `unsupported` ("real
 * LaTeX, deliberately not implemented yet — brief 40").
 *
 * The second assertion is the half that would have bitten far from here: the
 * raw object also landed in the diagnostic's `construct` field, which the
 * shared schema declares `z.string().optional()`. That schema is validated at
 * the API boundary in brief 38, so this would have surfaced as a serialization
 * failure in a different package, long after anyone remembered why.
 */
test(
  "amsmath-family environments (equation, align, gather, displaymath, math) report `unsupported`",
  () => {
    for (const name of AMSMATH_ENVIRONMENTS) {
      const result = compileSource(doc(`\\begin{${name}}\nx=y\n\\end{${name}}`));
      const hit = unsupportedFor(result, name);
      assert.ok(hit !== undefined, `${name} did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
      // Also assert the diagnostic's own field types are sane, independent of
      // which code it carries — a `construct` that is not a string is a
      // correctness bug regardless of the unsupported/undefined question.
      for (const d of result.diagnostics) {
        assert.equal(typeof (d.construct ?? ""), "string", `${name}: construct must be a string, got ${JSON.stringify(d.construct)}`);
      }
    }
  },
);

// --- 4. other sites -----------------------------------------------------

test("inline math ($...$) reports `unsupported` naming the construct", () => {
  const result = compileSource(doc("Some $x+y$ math."));
  assert.ok(unsupportedFor(result, "$...$") !== undefined);
});

test("display math (\\[...\\]) reports `unsupported` naming the construct", () => {
  const result = compileSource(doc("\\[x+y\\]"));
  assert.ok(unsupportedFor(result, "\\[...\\]") !== undefined);
});

test("\\documentclass for a class other than article reports `unsupported`", () => {
  const result = compileSource("\\documentclass{report}\n\\begin{document}\nx\n\\end{document}\n");
  const hit = unsupportedFor(result, "\\documentclass{report}");
  assert.ok(hit !== undefined);
});

test("\\usepackage outside the accepted five reports `unsupported`", () => {
  const result = compileSource("\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\nx\n\\end{document}\n");
  assert.ok(unsupportedFor(result, "\\usepackage{tikz}") !== undefined);
});

test("\\usepackage for one of the five accepted packages is an info, not an error, and has no effect", () => {
  for (const name of ["geometry", "inputenc", "fontenc", "lmodern", "textcomp"]) {
    const result = compileSource(
      `\\documentclass{article}\n\\usepackage{${name}}\n\\begin{document}\nx\n\\end{document}\n`,
    );
    assert.ok(!result.diagnostics.some((d) => d.code === "unsupported" && d.severity === "error" && d.construct === `\\usepackage{${name}}`));
    assert.ok(result.pdf !== null, `\\usepackage{${name}} should not block compilation`);
  }
  // `geometry` genuinely changes output (margins), so it alone carries no
  // "has no effect" info diagnostic; the other four are no-ops and do.
  for (const name of ["inputenc", "fontenc", "lmodern", "textcomp"]) {
    const result = compileSource(
      `\\documentclass{article}\n\\usepackage{${name}}\n\\begin{document}\nx\n\\end{document}\n`,
    );
    const info = result.diagnostics.find((d) => d.construct === `\\usepackage{${name}}`);
    assert.ok(info !== undefined, `\\usepackage{${name}} should still produce an info diagnostic`);
    assert.equal(info.severity, "info");
    assert.match(info.message, /has no effect/);
  }
});

test("\\section[short]{...} reports `unsupported` for the optional short-title form", () => {
  const result = compileSource(doc("\\section[Short]{Long Title}"));
  assert.ok(unsupportedFor(result, "\\section[...]") !== undefined);
});

test("\\\\[len] reports `unsupported` for the extra-space form of a line break", () => {
  const result = compileSource(doc("Line one\\\\[2em]\nLine two"));
  assert.ok(unsupportedFor(result, "\\\\[...]") !== undefined);
});

test("itemize[...] options report `unsupported`", () => {
  const result = compileSource(doc("\\begin{itemize}[label=x]\n\\item one\n\\end{itemize}"));
  assert.ok(unsupportedFor(result, "itemize[...]") !== undefined);
});

test("\\item[...] on an enumerate reports `unsupported`", () => {
  const result = compileSource(doc("\\begin{enumerate}\n\\item[a] one\n\\end{enumerate}"));
  assert.ok(unsupportedFor(result, "\\item[...]") !== undefined);
});

test("\\renewcommand of a formatting hook (\\thesection) reports `unsupported`", () => {
  const result = compileSource(
    "\\documentclass{article}\n\\renewcommand{\\thesection}{X}\n\\begin{document}\nx\n\\end{document}\n",
  );
  assert.ok(unsupportedFor(result, "\\thesection") !== undefined);
});

test("\\renewcommand of a formatting hook (\\labelenumii) reports `unsupported`", () => {
  const result = compileSource(
    "\\documentclass{article}\n\\renewcommand{\\labelenumii}{Y}\n\\begin{document}\nx\n\\end{document}\n",
  );
  assert.ok(unsupportedFor(result, "\\labelenumii") !== undefined);
});

/*
 * `\input` is resolved by `resolveInputs()`, which runs BEFORE macro expansion
 * and recurses into every command argument — including `\newcommand` bodies.
 * So a bare `\input` inside a definition is reached while it still has no file
 * name, and is diagnosed there rather than at the call site.
 *
 * There used to be a branch in `applySpecial()` with a message about `\input`
 * "produced by a macro", written for a case that could never arrive: the
 * pre-pass always gets there first, and `\csname` (the only other way to
 * synthesize the name) is permanently unsupported. It was deleted 2026-08-27
 * rather than made reachable. Dead code that claims to handle a case it cannot
 * reach is worse than no code, because the next reader believes it.
 *
 * What this pins is the property that actually matters, and which survives
 * whichever branch reports it: the construct is never silently dropped. It
 * errors, names `\input`, points at the line the token is really on, and
 * withholds the PDF.
 */
test(
  "\\input inside a macro definition is diagnosed, not silently dropped",
  () => {
    // \newcommand{\startinput}{\input}  ...  \startinput{other}
    // The parser does not know \startinput's arity, so `{other}` is never
    // attached as \input's argument until after expansion splices \input in —
    // at which point \input and the sibling group are separate nodes, which
    // is the shape meant to reach applyCommand's "input" branch.
    const src =
      "\\documentclass{article}\n\\newcommand{\\startinput}{\\input}\n\\begin{document}\n\\startinput{other}\n\\end{document}\n";
    const result = compileSource(src);
    const hit = result.diagnostics.find((d) => d.construct === "\\input");
    assert.ok(
      hit !== undefined,
      `\\input was dropped without a diagnostic, got: ${JSON.stringify(result.diagnostics)}`,
    );
    assert.equal(hit.severity, "error");
    assert.equal(hit.code, "syntax");
    // Line 2 is the \newcommand body, where the bare \input actually sits —
    // not line 4 where \startinput is called. A diagnostic that pointed at the
    // call site would be pointing at source that does not contain the problem.
    assert.equal(hit.line, 2);
    assert.equal(result.pdf, null);
  },
);

// --- 5. warning-severity: the engine has no clock ---------------------------

test("\\today is a warning, not an error, and does not block compilation", () => {
  const result = compileSource(doc("Today is \\today."));
  const hit = result.diagnostics.find((d) => d.construct === "\\today");
  assert.ok(hit !== undefined);
  assert.equal(hit.severity, "warning");
  assert.equal(hit.code, "unsupported");
  assert.ok(result.pdf !== null, "\\today should not block compilation");
});

test("\\maketitle with no \\date is a warning, not an error", () => {
  const result = compileSource("\\documentclass{article}\n\\title{T}\n\\begin{document}\n\\maketitle\n\\end{document}\n");
  const hit = result.diagnostics.find((d) => d.construct === "\\maketitle" && d.code === "unsupported");
  assert.ok(hit !== undefined);
  assert.equal(hit.severity, "warning");
  assert.ok(result.pdf !== null);
});

// --- 6. unsupported vs undefined --------------------------------------------

test("a genuine LaTeX command reports `unsupported`; an invented one reports `undefined-command`", () => {
  // `\includegraphics` used to be this suite's stock exemplar of "real LaTeX,
  // deliberately not implemented" — chunk 39.2 implemented it for real, so it
  // now reports `missing-file`/a decode diagnostic instead. `\textsc` takes
  // over the role: it is still genuinely unsupported (no small-caps face).
  const real = compileSource(doc("\\textsc{x}"));
  assert.equal(real.diagnostics.find((d) => d.construct === "\\textsc")?.code, "unsupported");

  const fake = compileSource(doc("\\notarealcommand"));
  const fakeDiag = fake.diagnostics.find((d) => d.construct === "\\notarealcommand");
  assert.ok(fakeDiag !== undefined);
  assert.equal(fakeDiag.code, "undefined-command");
  assert.doesNotMatch(fakeDiag.message, /this engine does not implement/);
});

test("a genuine LaTeX environment reports `unsupported`; an invented one reports `undefined-environment`", () => {
  // Same swap as above, for environments: `tabular` is chunk 39.3's, and a
  // valid one (as this fixture now is) sets for real with no diagnostic at
  // all. `longtable` is still genuinely out of scope.
  const real = compileSource(doc("\\begin{longtable}{c}\nx\n\\end{longtable}"));
  assert.equal(real.diagnostics.find((d) => d.construct === "longtable")?.code, "unsupported");

  const fake = compileSource(doc("\\begin{notarealenv}\nx\n\\end{notarealenv}"));
  const fakeDiag = fake.diagnostics.find((d) => d.construct === "notarealenv");
  assert.ok(fakeDiag !== undefined);
  assert.equal(fakeDiag.code, "undefined-environment");
});

// --- 7. positions ------------------------------------------------------------

test("an unsupported construct several lines into a document reports the right line", () => {
  // `\textsc` replaces `\includegraphics` as the exemplar here too — see the
  // "unsupported vs undefined" tests above for why.
  const src = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Line three text.",
    "Line four text.",
    "\\textsc{cat}",
    "\\end{document}",
    "",
  ].join("\n");
  const result = compileSource(src);
  const hit = unsupportedFor(result, "\\textsc");
  assert.ok(hit !== undefined);
  assert.equal(hit.line, 5);
});

test("an unsupported construct inside a \\newcommand body reports the definition's line, not the call site's", () => {
  const src = [
    "\\documentclass{article}", // 1
    "\\newcommand{\\foo}{\\textsc{x}}", // 2 - the construct is written here
    "\\begin{document}", // 3
    "Some text here.", // 4
    "More text.", // 5
    "\\foo", // 6 - expanded here; NOT where the diagnostic should point
    "\\end{document}", // 7
    "",
  ].join("\n");
  const result = compileSource(src);
  const hit = unsupportedFor(result, "\\textsc");
  assert.ok(hit !== undefined);
  assert.equal(hit.line, 2, "the diagnostic should point at the source line the construct is literally written on");
});

test("a document made entirely of unsupported constructs reports every one of them, not just the first", () => {
  // `\includegraphics` is left in the fixture (chunk 39.2's own suite covers
  // its new behaviour): it now reports `missing-file` rather than
  // `unsupported`, so it drops out of the Set below, but the per-construct
  // line assertion after it still holds — a diagnostic still names it, on
  // the right line, whatever its code.
  const src = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\includegraphics{a.png}",
    "\\centering",
    "\\thanks{x}",
    "\\href{http://x}{y}",
    "\\end{document}",
    "",
  ].join("\n");
  const result = compileSource(src);
  const unsupportedConstructs = result.diagnostics.filter((d) => d.code === "unsupported").map((d) => d.construct);
  assert.deepEqual(new Set(unsupportedConstructs), new Set(["\\centering", "\\thanks", "\\href"]));
  // And each on its own correct line.
  assert.equal(result.diagnostics.find((d) => d.construct === "\\includegraphics")?.line, 3);
  assert.equal(result.diagnostics.find((d) => d.construct === "\\centering")?.line, 4);
  assert.equal(result.diagnostics.find((d) => d.construct === "\\thanks")?.line, 5);
  assert.equal(result.diagnostics.find((d) => d.construct === "\\href")?.line, 6);
});
