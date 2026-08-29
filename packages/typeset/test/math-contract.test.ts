import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocument } from "../src/doc/index.ts";
import type { BuildResult } from "../src/doc/index.ts";
import type { Block, DisplayMathBlock, Inline, MathInline, ParagraphBlock } from "../src/doc/index.ts";
import type { Diagnostic } from "../src/diagnostics.ts";
import { checkDisplayOverrun, setEquationNumber } from "../src/doc/model.ts";
import {
  BUILTIN_COMMANDS,
  BUILTIN_ENVIRONMENTS,
  MATH_COMMANDS,
  lookupCommand,
  lookupEnvironment,
} from "../src/macro/builtins.ts";

/**
 * The math document-model contract (brief 40, chunk 40.3).
 *
 * Two claims, and they are opposites — which is the whole point of the file:
 *
 * 1. **Every construct on brief 40's In list becomes a typed node.** Not a
 *    diagnostic, not a dropped node: a `math` inline or a `displaymath` block
 *    carrying the TeX a renderer will be handed.
 * 2. **Every construct on its Out list reports `unsupported`, and never
 *    `undefined-command` / `undefined-environment`.** That distinction *is*
 *    D38's loud-failure contract — `unsupported` means "real LaTeX we
 *    declined", the undefined codes mean "not a thing at all" — and this
 *    engine has now got it backwards twice, both times for math. So the Out
 *    assertions below check the code positively *and* assert the absence of
 *    the undefined codes, rather than only the former.
 *
 * Two of the Out entries, `\DeclareMathOperator` and `cases`, render perfectly
 * well in MathJax. They are refused anyway: D41 §5 is the owner's explicit
 * call that math is gated to the In list even where the renderer could draw
 * more, because a subset whose edge is not knowable cannot honour D38. A test
 * that let them through would be asserting the recommendation the owner
 * overrode.
 *
 * The In/Out lists here are **transcribed from the brief**, not imported from
 * `builtins.ts`, for the reason `unsupported.test.ts` gives: importing the
 * table would only ever check that the source agrees with itself.
 *
 * Everything is asserted through `buildDocument` — the document layer alone.
 * Rendering (chunk 40.2), placement (40.4) and setting the number at the
 * margin (40.5) are deliberately not exercised here, so this file cannot
 * collide with those chunks.
 */

function build(body: string): BuildResult {
  const source = `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  return buildDocument({ "main.tex": source }, "main.tex");
}

function errorsOf(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

function blocksOf(body: string): Block[] {
  const result = build(body);
  assert.deepEqual(
    errorsOf(result.diagnostics).map((d) => d.message),
    [],
    `unexpected errors for ${JSON.stringify(body)}`,
  );
  return result.document.blocks;
}

function firstDisplay(body: string): DisplayMathBlock {
  const block = blocksOf(body).find((b): b is DisplayMathBlock => b.kind === "displaymath");
  assert.ok(block !== undefined, `no displaymath block for ${JSON.stringify(body)}`);
  return block;
}

function inlinesOf(body: string): Inline[] {
  const para = blocksOf(body).find((b): b is ParagraphBlock => b.kind === "paragraph");
  assert.ok(para !== undefined, `no paragraph for ${JSON.stringify(body)}`);
  return para.content;
}

function firstMathInline(body: string): MathInline {
  const inline = inlinesOf(body).find((i): i is MathInline => i.kind === "math");
  assert.ok(inline !== undefined, `no math inline for ${JSON.stringify(body)}`);
  return inline;
}

/**
 * The Out-list assertion, in one place because getting it slightly wrong is
 * exactly the failure this file exists to catch. A construct is refused
 * *correctly* only if all four hold: an `unsupported` diagnostic exists, it
 * names the construct, it carries a `detail` explaining why (the message is
 * longer than the bare "this engine does not implement X" stem), and no
 * `undefined-*` diagnostic was produced instead of or alongside it.
 */
function assertDeclined(body: string, construct: string): Diagnostic {
  const result = build(body);
  const undefinedCodes = result.diagnostics.filter(
    (d) => d.code === "undefined-command" || d.code === "undefined-environment",
  );
  assert.deepEqual(
    undefinedCodes.map((d) => `${d.code}: ${d.construct ?? d.message}`),
    [],
    `${construct} was reported as undefined — it is real LaTeX this engine declined, which is \`unsupported\` (D38)`,
  );
  const hit = result.diagnostics.find((d) => d.code === "unsupported" && d.construct === construct);
  assert.ok(
    hit !== undefined,
    `${construct} did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`,
  );
  assert.equal(hit.severity, "error");
  assert.match(hit.message, / — /, `${construct}'s diagnostic carries no detail saying why`);
  assert.ok(hit.line > 0, `${construct}'s diagnostic has no line`);
  assert.equal(hit.file, "main.tex");
  return hit;
}

// --- 1. the In list: inline math --------------------------------------------

test("$...$ and \\(...\\) both become a math inline on the text baseline's line", () => {
  for (const [body, construct] of [
    ["before $x+y$ after", "$...$"],
    ["before \\(x+y\\) after", "$...$"],
  ] as const) {
    const math = firstMathInline(body);
    assert.equal(math.kind, "math");
    assert.equal(math.construct, construct);
    assert.equal(math.display, false, "inline math is never display style");
    assert.equal(math.source, "x+y");
    assert.equal(math.loc.file, "main.tex");
    assert.equal(math.loc.line, 3, "the node points at the line the math was written on");
  }
});

test("a math inline sits between the words around it, and does not break the paragraph", () => {
  const kinds = inlinesOf("before $x$ after").map((i) => i.kind);
  assert.deepEqual(kinds, ["text", "space", "math", "space", "text"]);
});

test("the source handed to the renderer is the *expanded* TeX, not the characters written", () => {
  // The reason `MathInline.source` is a string built from the AST rather than a
  // slice of the file: MathJax has never heard of the document's own macros,
  // and macro expansion runs before this. A slice would hand it `\half`.
  const source =
    "\\documentclass{article}\n\\newcommand{\\half}{\\frac{1}{2}}\n\\begin{document}\n$\\half$\n\\end{document}\n";
  const result = buildDocument({ "main.tex": source }, "main.tex");
  assert.deepEqual(errorsOf(result.diagnostics), []);
  const para = result.document.blocks[0] as ParagraphBlock;
  const math = para.content.find((i): i is MathInline => i.kind === "math");
  assert.equal(math?.source, "\\frac{1}{2}");
});

test("^ and _ print back as themselves, not as the text-mode accent macros", () => {
  // `\^` is the circumflex accent and `\_` is an underscore: both are real
  // commands that would render, so getting this wrong sets a *different*
  // formula rather than failing. The parser reports both as commands because
  // in math they take an argument.
  assert.equal(firstMathInline("$x^2$").source, "x^{2}");
  assert.equal(firstMathInline("$x_i$").source, "x_{i}");
  assert.equal(firstMathInline("$z_a^b$").source, "z_{a}^{b}");
});

test("a control word is separated from a following letter, so \\alpha x is not \\alphax", () => {
  assert.equal(firstMathInline("$\\alpha x$").source, "\\alpha x");
  // …and a control word followed by a non-letter needs no space at all.
  assert.equal(firstMathInline("$\\left( x \\right)$").source, "\\left( x \\right)");
});

// --- 2. the In list: display math -------------------------------------------

test("\\[...\\] becomes an unnumbered display block", () => {
  const block = firstDisplay("\\[x+y\\]");
  assert.equal(block.kind, "displaymath");
  assert.equal(block.variant, "bracket");
  assert.equal(block.construct, "\\[...\\]");
  assert.equal(block.display, true);
  assert.equal(block.numbered, false);
  assert.equal(block.source, "x+y");
  assert.equal(block.lines.length, 1);
  assert.equal(block.lines[0]!.number, null);
  assert.equal(block.lines[0]!.marker, null);
  assert.equal(block.loc.line, 3);
});

/** One entry per display environment on brief 40's In list. */
const IN_LIST_DISPLAYS = [
  { name: "equation", body: "E = mc^2", numbered: true },
  { name: "equation*", body: "E = mc^2", numbered: false },
  { name: "displaymath", body: "E = mc^2", numbered: false },
  { name: "align", body: "a &= b \\\\ c &= d", numbered: true },
  { name: "align*", body: "a &= b \\\\ c &= d", numbered: false },
  { name: "gather", body: "a \\\\ b", numbered: true },
  { name: "split", body: "a &= b", numbered: false },
] as const;

test("every display environment on the In list becomes a display block of its own variant", () => {
  for (const entry of IN_LIST_DISPLAYS) {
    const block = firstDisplay(`\\begin{${entry.name}}${entry.body}\\end{${entry.name}}`);
    assert.equal(block.variant, entry.name, `${entry.name} built the wrong variant`);
    assert.equal(block.construct, entry.name);
    assert.equal(block.display, true);
    assert.equal(block.numbered, entry.numbered, `${entry.name} numbered the wrong way`);
    assert.ok(block.lines.length >= 1, `${entry.name} produced no lines`);
  }
});

test("a display environment's source keeps its \\begin/\\end, because MathJax needs them", () => {
  // `align`'s alignment points only mean anything inside the environment; a
  // bare `a &= b` handed to a renderer is an error, not a display.
  const block = firstDisplay("\\begin{align}a &= b \\\\ c &= d\\end{align}");
  assert.match(block.source, /^\\begin\{align\}/);
  assert.match(block.source, /\\end\{align\}$/);
  // `&` loses the space before it in the parse (`@unified-latex` normalises it
  // away), which changes nothing about the formula, so the assertion compares
  // without spaces rather than pinning the parser's spacing.
  assert.match(block.source.replace(/ /g, ""), /a&=b/);
});

test("an aligned environment splits into one line per \\\\, each carrying its own TeX", () => {
  const block = firstDisplay("\\begin{align}a &= b \\\\ c &= d \\\\ e &= f\\end{align}");
  assert.equal(block.lines.length, 3);
  assert.deepEqual(
    block.lines.map((l) => l.source.replace(/ /g, "")),
    ["a&=b", "c&=d", "e&=f"],
  );
  // The lines are not the renderer's input — the whole block is — so they carry
  // no wrapper of their own.
  for (const line of block.lines) assert.ok(!line.source.includes("\\begin"));
});

test("a trailing \\\\ before \\end does not open a blank numbered line", () => {
  const block = firstDisplay("\\begin{align}a &= b \\\\ c &= d \\\\\\end{align}");
  assert.equal(block.lines.length, 2);
});

test("a single-line display is one line, even though it never saw a \\\\", () => {
  // So nothing downstream needs two shapes for "a display".
  assert.equal(firstDisplay("\\begin{equation}x\\end{equation}").lines.length, 1);
  assert.equal(firstDisplay("\\[x\\]").lines.length, 1);
});

test("a matrix, an array and growing delimiters ride inside the TeX, not as blocks of their own", () => {
  // Everything inside a math run is the renderer's problem by design: the
  // document layer models the run, never the formula. This is the assertion
  // that says so.
  const block = firstDisplay("\\[\\left(\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\\right)\\]");
  assert.equal(blocksOf("\\[\\begin{pmatrix}1\\end{pmatrix}\\]").length, 1);
  assert.match(block.source, /\\begin\{pmatrix\}/);
  assert.match(block.source, /\\end\{pmatrix\}/);
  assert.match(block.source, /\\left\(/);
  assert.match(firstDisplay("\\[\\begin{array}{l|cr}a&b&c\\end{array}\\]").source, /\\begin\{array\}\{l\|cr\}/);
});

// --- 3. the equation counter, \label and \ref --------------------------------

test("equation numbers run straight through the document, as article.cls numbers them", () => {
  const blocks = blocksOf(
    "\\begin{equation}a\\end{equation}\n\\section{S}\n\\begin{equation}b\\end{equation}",
  ).filter((b): b is DisplayMathBlock => b.kind === "displaymath");
  assert.deepEqual(
    blocks.map((b) => b.lines[0]!.number),
    ["1", "2"],
    "a \\section must not reset the equation counter: \\theequation is a bare arabic number in article, so it would print two (1)s",
  );
});

test("a starred display and \\[...\\] step nothing, so the numbers around them are unbroken", () => {
  const numbers = blocksOf(
    "\\begin{equation}a\\end{equation}\n\\begin{equation*}b\\end{equation*}\n\\[c\\]\n\\begin{equation}d\\end{equation}",
  )
    .filter((b): b is DisplayMathBlock => b.kind === "displaymath")
    .map((b) => b.lines[0]!.number);
  assert.deepEqual(numbers, ["1", null, null, "2"]);
});

test("every line of an align is numbered on its own, and \\nonumber opts one out", () => {
  const block = firstDisplay("\\begin{align}a &= b \\\\ c &= d \\nonumber \\\\ e &= f\\end{align}");
  assert.deepEqual(
    block.lines.map((l) => l.number),
    ["1", null, "2"],
  );
  // `\nonumber` is a numbering instruction this file has already carried out;
  // handing it to a renderer would be handing it an instruction, not maths.
  assert.ok(!block.source.includes("\\nonumber"));
});

test("\\notag is \\nonumber's amsmath spelling and does the same thing", () => {
  const block = firstDisplay("\\begin{gather}a \\notag \\\\ b\\end{gather}");
  assert.deepEqual(
    block.lines.map((l) => l.number),
    [null, "1"],
  );
});

test("\\ref to an equation resolves through the existing label machinery, with no new mechanism", () => {
  const result = build(
    "\\begin{equation}\\label{eq:first}a\\end{equation}\n\\begin{equation}\\label{eq:second}b\\end{equation}\nsee \\ref{eq:second}",
  );
  assert.deepEqual(errorsOf(result.diagnostics), []);
  assert.equal(result.document.labels.get("eq:first")?.text, "1");
  assert.equal(result.document.labels.get("eq:second")?.text, "2");
  const para = result.document.blocks.find(
    (b): b is ParagraphBlock => b.kind === "paragraph" && b.content.some((i) => i.kind === "reference"),
  );
  const ref = para!.content.find((i) => i.kind === "reference");
  assert.ok(ref !== undefined && ref.kind === "reference");
  assert.equal(ref.text, "2", "\\ref prints the equation's number, not ??");
});

test("a \\label on one align line refers to that line's number, not the display's first", () => {
  const result = build("\\begin{align}a &= b \\\\ c &= d \\label{eq:l2}\\end{align}");
  assert.deepEqual(errorsOf(result.diagnostics), []);
  assert.equal(result.document.labels.get("eq:l2")?.text, "2");
});

test("a \\label inside an unnumbered display is a warning, not a blank \\ref", () => {
  // Same rule `\label` already follows everywhere else: a label with nothing
  // numbered to refer to would set an empty string in a published document.
  const result = build("\\[x \\label{eq:nope}\\]");
  const hit = result.diagnostics.find((d) => d.code === "undefined-reference");
  assert.ok(hit !== undefined, `expected a warning — got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.severity, "warning");
});

test("a numbered equation emits a marker before its block, so \\pageref can resolve", () => {
  // The two-pass cycle closes through the markers layout places; equations use
  // that one rather than a second reference mechanism (brief 40 step 3).
  const blocks = blocksOf("\\begin{align}a \\\\ b\\end{align}");
  const markers = blocks.filter((b) => b.kind === "marker").map((b) => b.kind === "marker" && b.name);
  assert.deepEqual(markers, ["equation:0", "equation:1"]);
  const display = blocks.find((b): b is DisplayMathBlock => b.kind === "displaymath")!;
  assert.deepEqual(
    display.lines.map((l) => l.marker),
    ["equation:0", "equation:1"],
    "each numbered line's marker is the one emitted for it",
  );
  assert.ok(
    blocks.indexOf(display) > blocks.findIndex((b) => b.kind === "marker"),
    "the markers are emitted before the display, so they land on its page",
  );
});

test("\\label inside math is stripped from the TeX the renderer is handed", () => {
  const block = firstDisplay("\\begin{equation}\\label{eq:x}E = mc^2\\end{equation}");
  assert.ok(!block.source.includes("\\label"), `\\label leaked into the source: ${block.source}`);
  assert.match(block.source, /E = mc\^\{2\}/);
});

// --- 4. the Out list: real LaTeX, declined, and never "undefined" ------------

/**
 * Brief 40's Out list, transcribed: `\newtheorem` and theorem environments,
 * `cases` beyond what `array` gives, commutative diagrams, `mathtools` /
 * `physics` / `siunitx`, `\DeclareMathOperator`, custom math alphabets, and
 * TikZ in math.
 *
 * `where` is the fixture, because half of these are only writable inside math.
 */
const OUT_LIST = [
  // \DeclareMathOperator and cases — the two D41 §5 singles out: MathJax
  // renders both, and the owner chose to refuse them anyway.
  { construct: "\\DeclareMathOperator", body: "\\DeclareMathOperator{\\spn}{span}" },
  { construct: "\\operatorname", body: "$\\operatorname{span}(v)$" },
  { construct: "cases", body: "\\[\\begin{cases}1 & x>0 \\\\ 0 & x\\le 0\\end{cases}\\]" },
  { construct: "cases", body: "$\\begin{cases}1\\end{cases}$" },
  // \newtheorem and theorem environments.
  { construct: "\\newtheorem", body: "\\newtheorem{thm}{Theorem}" },
  { construct: "theorem", body: "\\begin{theorem}x\\end{theorem}" },
  { construct: "lemma", body: "\\begin{lemma}x\\end{lemma}" },
  { construct: "proof", body: "\\begin{proof}x\\end{proof}" },
  // Commutative diagrams.
  { construct: "tikzcd", body: "\\[\\begin{tikzcd}A \\end{tikzcd}\\]" },
  { construct: "CD", body: "\\[\\begin{CD}A @>>> B\\end{CD}\\]" },
  { construct: "\\xymatrix", body: "$\\xymatrix{A}$" },
  // TikZ in math.
  { construct: "\\tikz", body: "$\\tikz{}$" },
  { construct: "tikzpicture", body: "\\begin{tikzpicture}\\end{tikzpicture}" },
  // mathtools.
  { construct: "\\DeclarePairedDelimiter", body: "\\DeclarePairedDelimiter{\\abs}{|}{|}" },
  { construct: "\\coloneqq", body: "$a \\coloneqq b$" },
  { construct: "\\mathclap", body: "$\\mathclap{x}$" },
  { construct: "dcases", body: "\\[\\begin{dcases}1\\end{dcases}\\]" },
  // physics.
  { construct: "\\dv", body: "$\\dv{f}{x}$" },
  { construct: "\\ket", body: "$\\ket{\\psi}$" },
  { construct: "\\qty", body: "$\\qty(x)$" },
  // siunitx.
  { construct: "\\SI", body: "$\\SI{3}{\\metre}$" },
  { construct: "\\si", body: "$\\si{\\metre}$" },
  { construct: "\\num", body: "$\\num{1234}$" },
  // Custom math alphabets.
  // Written bare, unlike the rest: `\DeclareMathAlphabet`'s first argument is
  // a *macro name*, and `@unified-latex` has no signature for the command, so
  // the `{\myalph}` would arrive as a sibling group and be walked as ordinary
  // content — where a name that has (by definition) never been defined is
  // `undefined-command`, correctly, but about the wrong thing.
  { construct: "\\DeclareMathAlphabet", body: "\\DeclareMathAlphabet" },
  { construct: "\\mathscr", body: "$\\mathscr{A}$" },
  { construct: "\\mathfrak", body: "$\\mathfrak{g}$" },
  // Displays outside the In list. Real amsmath, so real LaTeX, so declined
  // rather than undefined — and this is the group most likely to regress,
  // because it sits one character away from the supported spellings.
  { construct: "multline", body: "\\begin{multline}a\\end{multline}" },
  { construct: "alignat", body: "\\begin{alignat}{2}a &= b\\end{alignat}" },
  { construct: "flalign", body: "\\begin{flalign}a &= b\\end{flalign}" },
  { construct: "gather*", body: "\\begin{gather*}a\\end{gather*}" },
  { construct: "aligned", body: "\\[\\begin{aligned}a &= b\\end{aligned}\\]" },
  { construct: "subequations", body: "\\begin{subequations}a\\end{subequations}" },
  { construct: "smallmatrix", body: "$\\begin{smallmatrix}1\\end{smallmatrix}$" },
  { construct: "math", body: "\\begin{math}x\\end{math}" },
  { construct: "eqnarray", body: "\\begin{eqnarray}a &=& b\\end{eqnarray}" },
  // amsmath numbering machinery outside the In list. `\tag` in particular
  // would print a number the equation counter never issued.
  { construct: "\\tag", body: "\\begin{equation}x \\tag{$\\star$}\\end{equation}" },
  { construct: "\\eqref", body: "\\begin{equation}\\label{e}x\\end{equation}see \\eqref{e}" },
  { construct: "\\intertext", body: "\\begin{align}a \\\\ \\intertext{and}b\\end{align}" },
  { construct: "\\substack", body: "$\\sum_{\\substack{i<j}} x$" },
  { construct: "\\numberwithin", body: "\\numberwithin{equation}{section}" },
] as const;

test("every construct on brief 40's Out list reports `unsupported` — never `undefined-*`", () => {
  for (const entry of OUT_LIST) assertDeclined(entry.body, entry.construct);
});

test("the Out list's diagnostics each say *why*, not just that", () => {
  // A refusal with no reason is the same dead end as no refusal at all: the
  // author cannot tell whether to rewrite the construct or file a bug.
  for (const entry of OUT_LIST) {
    const hit = assertDeclined(entry.body, entry.construct);
    const detail = hit.message.split(" — ").slice(1).join(" — ");
    assert.ok(detail.length > 20, `${entry.construct}: detail is too thin to act on — "${hit.message}"`);
  }
});

test("a construct hidden behind a macro is still gated, because the gate runs after expansion", () => {
  // Not the whole of D41 §5's gate — that one reads MathJax's MathML and is
  // chunk 40.2's — but the half the document layer can prove: a `\newcommand`
  // is gone by the time this walk happens, so hiding `cases` in one does not
  // hide it from the name-level gate.
  const source =
    "\\documentclass{article}\n\\newcommand{\\mycases}{\\begin{cases}1\\end{cases}}\n\\begin{document}\n\\[\\mycases\\]\n\\end{document}\n";
  const result = buildDocument({ "main.tex": source }, "main.tex");
  const hit = result.diagnostics.find((d) => d.code === "unsupported" && d.construct === "cases");
  assert.ok(hit !== undefined, `got: ${JSON.stringify(result.diagnostics)}`);
});

test("a genuinely made-up control sequence inside math is NOT reported as unsupported", () => {
  // The other side of the same contract. `\frobnicate` is not real LaTeX that
  // this engine declined, so calling it `unsupported` would be as wrong as
  // calling `cases` undefined. The document layer says nothing and leaves it
  // to the renderer, which raises a real error for it (D41 §4).
  const result = build("$\\frobnicate{x}$");
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "unsupported"),
    [],
    "an unknown name inside math must not be guessed at",
  );
});

// --- 5. math-mode constructs written outside math ---------------------------

test("a math command written in text mode is `unsupported`, never `undefined-command`", () => {
  // `\frac` IS implemented — inside math. Outside it there is nothing for it
  // to set, and real LaTeX refuses it too ("Missing $ inserted"). What it must
  // never do is claim `\frac` is not a LaTeX command.
  for (const [construct, body] of [
    ["\\frac", "\\frac{1}{2}"],
    ["\\alpha", "the letter \\alpha"],
    ["\\left", "\\left( x"],
    ["\\sqrt", "\\sqrt{2}"],
  ] as const) {
    const hit = assertDeclined(body, construct);
    assert.match(hit.message, /math/);
  }
});

test("a math structure environment written in text mode reports the same way", () => {
  for (const name of ["pmatrix", "bmatrix", "vmatrix", "array", "matrix"]) {
    assertDeclined(`\\begin{${name}}1\\end{${name}}`, name);
  }
});

// --- 6. the tables themselves ------------------------------------------------

test("no generated math row silently shadows a hand-written builtin row", () => {
  // The math rows are spread into `BUILTIN_COMMANDS` first so the explicit
  // rows below win. That is only safe while the two sets are disjoint: a
  // collision would mean a name whose meaning depends on the order of a spread
  // — e.g. `\underline`, which is real in both modes and must stay text.
  const explicit = new Set(["underline", "ldots", "dots", "and", "index", "part", "S", "P"]);
  for (const name of MATH_COMMANDS) {
    assert.ok(!explicit.has(name), `${name} is both a math-only row and a text-mode row`);
  }
});

test("every In-list math name is in a table, and resolves to something that is not a refusal", () => {
  for (const name of MATH_COMMANDS) {
    const spec = lookupCommand(name);
    assert.ok(spec !== undefined, `\\${name} is in no table at all — it would be undefined-command`);
    assert.notEqual(spec.role, "unsupported", `\\${name} is on the In list but a table says it is declined`);
  }
  for (const name of ["equation", "align", "gather", "split", "pmatrix", "array"]) {
    const spec = lookupEnvironment(name);
    assert.ok(spec !== undefined, `${name} is in no table at all — it would be undefined-environment`);
    assert.notEqual(spec.role, "unsupported");
  }
});

test("every name the Out list fixtures use is a table row, so none of them can drift to undefined", () => {
  for (const entry of OUT_LIST) {
    const bare = entry.construct.startsWith("\\") ? entry.construct.slice(1) : entry.construct;
    const spec = entry.construct.startsWith("\\")
      ? BUILTIN_COMMANDS[bare]
      : BUILTIN_ENVIRONMENTS[bare];
    assert.ok(spec !== undefined, `${entry.construct} has no row`);
    assert.equal(spec.role, "unsupported", `${entry.construct}'s row is not a refusal`);
  }
});

// --- 7. the seams chunks 40.4 and 40.5 still owe -----------------------------

test("an unlanded math seam fails loudly and names the chunk that owes it", () => {
  // The point of the stub. A seam that returned a neutral value instead —
  // `null` for the overrun check, `[]` for the number — would be a display
  // silently set with no number and no complaint, which is the exact outcome
  // D38 exists to prevent. `compile()` converts a throw into an `internal`
  // diagnostic at its boundary, so this is loud without being a crash.
  assert.throws(
    () => checkDisplayOverrun(firstDisplay("\\[x\\]"), 500, 345),
    /chunk 40\.4/,
  );
  assert.throws(
    () => setEquationNumber({ source: "x", number: "1", marker: "equation:0", loc: { file: "main.tex", line: 1 } }, 345),
    /chunk 40\.5/,
  );
});
