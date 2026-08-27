import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDocument,
  buildVerticalList,
  compile,
  createBudget,
  createLatinModernProvider,
  createLayoutContext,
  createShaper,
  defaultDesign,
  listSpacing,
} from "../src/index.ts";
import type { CompileResult, GlyphRun, Page, VNode } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Chunk 8: fidelity fixes and three real bugs, found and honestly reported
 * (rather than papered over) by the previous chunk.
 *
 * `test/compile.test.ts` (chunk 7's, not touched here) already covers the
 * acceptance goldens; this file is specifically the four things chunk 8 was
 * asked to close — a silently-unrendered character, a footnote that silently
 * overflows the page, and two `article.cls` fidelity gaps (`\paragraph`'s
 * run-in, and how far the ToC and `description` pull their own text back).
 * The parser-level control-word-gobbling fix (chunk 8's first bug) has its
 * own pinned tests in `parse.test.ts`, right next to the rest of the parse
 * layer's structural coverage — not duplicated here.
 *
 * The section at the foot of the file is review round 2's: the same kind of
 * bug, found by a review of chunks 6–8 rather than by the chunk that caused
 * it, and kept here for the same reason — these are fidelity questions with a
 * right answer in `article.cls`, not unit tests of a module.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());

function encode(text: string): Uint8Array {
  return new Uint8Array(new TextEncoder().encode(text));
}

function project(body: string): { files: Record<string, Uint8Array>; entrypoint: string } {
  return {
    files: { "main.tex": encode(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`) },
    entrypoint: "main.tex",
  };
}

function run(body: string): CompileResult {
  const { files, entrypoint } = project(body);
  return compile(files, entrypoint, { fonts });
}

function glyphRuns(page: Page): GlyphRun[] {
  return page.items.filter((item): item is GlyphRun => item.kind === "glyphrun");
}

// --- an unmapped character is a diagnostic, not a silent blank -------------

test("a character with no glyph in the font is a warning naming the character and the font, not a silent blank", () => {
  const result = run("Hello 中 world");
  assert.ok(result.pdf !== null, "one exotic character should not refuse the whole document a PDF");
  const hits = result.diagnostics.filter((d) => d.code === "missing-font" && d.severity === "warning");
  assert.equal(hits.length, 1, `expected exactly one missing-glyph warning, got: ${JSON.stringify(result.diagnostics)}`);
  const hit = hits[0]!;
  assert.match(hit.message, /中/, "the diagnostic should name the character");
  assert.match(hit.message, /U\+4E2D/, "the diagnostic should name the codepoint");
  assert.match(hit.message, /lmroman10-regular/, "the diagnostic should name the font");
  assert.equal(hit.construct, "中");
});

test("the same missing character reported twice in one document is one diagnostic, not two", () => {
  const result = run("中 and 中 again");
  const hits = result.diagnostics.filter((d) => d.code === "missing-font");
  assert.equal(hits.length, 1);
});

test("a character the font does have is never reported, even one that looks unusual", () => {
  const result = run("na\\\"ive caf\\'e — an em dash and curly quotes ``like this''");
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "missing-font"),
    [],
  );
});

// --- a footnote taller than the page overflows loudly, not silently --------

test("a footnote taller than the page is placed anyway, but reports an overfull-box warning naming it", () => {
  const sentence =
    "This sentence is repeated many times to build an extremely tall footnote that cannot possibly fit on a single page no matter how the page builder tries to place it. ";
  const result = run(`A line with a mark\\footnote{${sentence.repeat(80)}}.`);
  assert.ok(result.pdf !== null, "a page rendering badly is not a reason to refuse the whole document a PDF");
  const hits = result.diagnostics.filter((d) => d.code === "overfull-box" && d.construct === "\\footnote");
  assert.equal(hits.length, 1, `expected exactly one footnote-overflow warning, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hits[0]!.severity, "warning");
  assert.match(hits[0]!.message, /footnote 1/);
  assert.match(hits[0]!.message, /taller than/);
});

test("a footnote that comfortably fits the page is never reported", () => {
  const result = run("A line with a mark\\footnote{A perfectly ordinary, short footnote.}.");
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "overfull-box" && d.construct === "\\footnote"),
    [],
  );
});

// --- ToC weight: only \l@section is \bfseries -------------------------------

test("the ToC bolds section entries but not subsection or subsubsection entries, matching \\@dottedtocline", () => {
  const result = run(
    "\\tableofcontents\n\\section{One}\n\\subsection{Two}\n\\subsubsection{Three}\n" +
      "Some body text so every heading has something to number.",
  );
  const toc = glyphRuns(result.pages[0]!);
  const one = toc.find((g) => g.text === "One");
  const two = toc.find((g) => g.text === "Two");
  const three = toc.find((g) => g.text === "Three");
  assert.ok(one && two && three, "all three ToC entries should be on the first page");
  assert.match(one!.font.id, /bold/, "\\l@section is \\bfseries");
  assert.doesNotMatch(two!.font.id, /bold/, "\\l@subsection goes through \\@dottedtocline, which is \\normalfont");
  assert.doesNotMatch(three!.font.id, /bold/, "\\l@subsubsection is the same \\@dottedtocline, still \\normalfont");
});

test("the ToC draws dotted leaders for subsection and below, but none for section", () => {
  const result = run(
    "\\tableofcontents\n\\section{One}\n\\subsection{Two}\n" + "Some body text so every heading has something to number.",
  );
  const toc = glyphRuns(result.pages[0]!);
  const oneY = toc.find((g) => g.text === "One")!.y;
  const twoY = toc.find((g) => g.text === "Two")!.y;
  const dotsOnSectionLine = toc.filter((g) => g.y === oneY && g.text === ".");
  const dotsOnSubsectionLine = toc.filter((g) => g.y === twoY && g.text === ".");
  assert.equal(dotsOnSectionLine.length, 0, "\\l@section's connector is plain \\hfil — no leaders");
  assert.ok(dotsOnSubsectionLine.length > 5, "\\@dottedtocline should draw a run of period leaders");
});

// --- \paragraph is a run-in heading -----------------------------------------

test("\\paragraph runs its bold title into the very next paragraph's first line, not onto a line of its own", () => {
  const result = run("\\paragraph{Intro} Body text starts right here on the same line.");
  const page = glyphRuns(result.pages[0]!);
  const title = page.find((g) => g.text === "Intro");
  const body = page.find((g) => g.text === "Body");
  assert.ok(title && body, "both the title and the first body word should be on the page");
  assert.equal(title!.y, body!.y, "the bold title and the body text should share one baseline");
  assert.match(title!.font.id, /bold/);
  assert.doesNotMatch(body!.font.id, /bold/);
  assert.ok(title!.x < body!.x, "the title should sit to the left of the body text that runs into it");
});

test("\\paragraph with nothing following it to run into falls back to its own line", () => {
  // No paragraph after it in this (admittedly unusual) document — there is
  // nothing to merge with, so it still gets a line to itself.
  const result = run("\\paragraph{Alone}\n\\begin{itemize}\\item x\\end{itemize}");
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errors, []);
  const page = glyphRuns(result.pages[0]!);
  assert.ok(page.some((g) => g.text === "Alone"));
});

// --- description pulls its term back to the enclosing margin ---------------

test("a description term is pulled back to the enclosing margin, past the item's own indent", () => {
  // `\noindent` so this paragraph is flush at the true left margin, the same
  // reference point `\itemindent -\leftmargin` pulls the term back to — an
  // *ordinary* paragraph gets `\parindent`'s own indent and would not match.
  const result = run(
    "\\noindent Flush body text at the ordinary left margin.\n\n" +
      "\\begin{description}\\item[Term] text follows the term.\\end{description}",
  );
  const page = glyphRuns(result.pages[0]!);
  const bodyWord = page.find((g) => g.text === "Flush")!;
  const term = page.find((g) => g.text === "Term")!;
  const follows = page.find((g) => g.text === "text")!;
  assert.equal(term.x, bodyWord.x, "the term should hang all the way out at the enclosing (ordinary body) margin");
  assert.ok(follows.x > term.x, "the item's own body text should still sit to the right of the hung term");
});

test("a description term long enough to wrap returns wrapped lines to the item's own indent, not the margin", () => {
  const longTerm =
    "A description term written deliberately long so that it and the words after it cannot all fit on the page's first available line no matter how the line breaker tries";
  const result = run(`\\begin{description}\\item[${longTerm}] tail text.\\end{description}`);
  const page = glyphRuns(result.pages[0]!);
  const byY = new Map<number, GlyphRun[]>();
  for (const g of page) {
    const line = byY.get(g.y) ?? [];
    line.push(g);
    byY.set(g.y, line);
  }
  const lines = [...byY.entries()].sort((a, b) => a[0] - b[0]);
  assert.ok(lines.length >= 2, "a term this long should wrap onto at least a second line");
  const firstLineX = Math.min(...(lines[0]![1].map((g) => g.x)));
  const secondLineX = Math.min(...(lines[1]![1].map((g) => g.x)));
  assert.ok(secondLineX > firstLineX, "the wrapped line should sit further right, at the item's ordinary indent");
});

// ---------------------------------------------------------------------------
// Review round 2: four bugs a review of chunks 6–8 found, every one of them
// silent — wrong output, or a diagnostic that said something untrue, with
// nothing in the compile to suggest either. Each test below asserts the
// *corrected* result, not merely the absence of the old symptom.
// ---------------------------------------------------------------------------

/** A document long enough to push a section several pages past the ToC. */
function withTocAndFiller(title: string): string {
  const filler = "Filler sentence carrying this document across several pages. ".repeat(15);
  return [
    "\\tableofcontents",
    ...Array<string>(40).fill(filler),
    `\\section{${title}}`,
    ...Array<string>(40).fill(filler),
    "\\section{Later}",
    "See page \\pageref{tgt} for the target.",
  ].join("\n\n");
}

/** The page the *heading* is set on — its title is \Large, the ToC entry is not. */
function headingPage(result: CompileResult, text: string): number {
  for (const page of result.pages) {
    for (const g of glyphRuns(page)) {
      if (g.text === text && g.size > 12) return page.number;
    }
  }
  throw new Error(`no heading-sized run "${text}" anywhere in the document`);
}

test("a \\label inside a section title resolves \\pageref to the heading's page, not the ToC's", () => {
  const result = run(withTocAndFiller("Target\\label{tgt}"));
  const target = headingPage(result, "Target");
  assert.ok(target > 1, "the fixture must push the heading well past the table of contents");

  // `See page N for the target.` — read the number off the same line as the
  // word before it, so neither the section number nor the folio can stand in.
  const last = result.pages[result.pages.length - 1]!;
  const line = glyphRuns(last);
  const word = line.find((g) => g.text === "page")!;
  assert.ok(word, "the sentence carrying the \\pageref should be on the last page");
  const printed = line
    .filter((g) => g.y === word.y && g.x > word.x)
    .sort((a, b) => a.x - b.x)
    .find((g) => /^\d+$/.test(g.text));
  assert.equal(
    printed?.text,
    String(target),
    "\\pageref must print the page the heading is on; printing the ToC's page was the bug",
  );
});

test("a ToC entry prints the page its heading is set on, several pages later", () => {
  // Not a regression test for the `\label` bug — the entry's folio reads the
  // *heading's* own marker, which was never the duplicated one — but the
  // companion property to it: `\pageref` and the ToC entry must agree about
  // where the section is, and both are read from the same page-number map.
  const result = run(withTocAndFiller("Target\\label{tgt}"));
  const target = headingPage(result, "Target");

  const toc = glyphRuns(result.pages[0]!);
  const entry = toc.find((g) => g.text === "Target" && g.size <= 12);
  assert.ok(entry, "the ToC should list the section at normalsize");
  const folio = toc
    .filter((g) => g.y === entry.y && g.x > entry.x)
    .sort((a, b) => b.x - a.x)[0];
  assert.equal(folio?.text, String(target));
});

test("a \\footnote in a section title is set once, at the heading, and says so", () => {
  const result = run(withTocAndFiller("Target\\footnote{Nightingale}"));
  const target = headingPage(result, "Target");
  const carrying = result.pages.filter((p) => glyphRuns(p).some((g) => g.text === "Nightingale"));
  assert.deepEqual(
    carrying.map((p) => p.number),
    [target],
    "the note belongs at the foot of the heading's page and nowhere else",
  );

  const hits = result.diagnostics.filter((d) => d.construct === "\\footnote");
  assert.equal(hits.length, 1, `expected one footnote diagnostic, got ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hits[0]!.severity, "warning");
  assert.match(hits[0]!.message, /table of contents/, "the diagnostic must say what actually happened");
  assert.doesNotMatch(hits[0]!.message, /inside a footnote/, "there is no nested footnote here");
  assert.doesNotMatch(hits[0]!.message, /dropped/, "nothing was dropped — the note is set at the heading");
});

test("a \\footnote genuinely inside another footnote reports that, and its mark is still set", () => {
  const result = run("Body text\\footnote{Outer note\\footnote{Inner note}.} continues.");
  const hits = result.diagnostics.filter((d) => d.construct === "\\footnote");
  assert.equal(hits.length, 1, `expected one footnote diagnostic, got ${JSON.stringify(result.diagnostics)}`);
  assert.match(hits[0]!.message, /inside another footnote/);
  assert.match(hits[0]!.message, /the mark is set/);
  const page = glyphRuns(result.pages[0]!);
  assert.ok(page.some((g) => g.text === "Outer"), "the outer note is still set at the foot of the page");
  assert.ok(!page.some((g) => g.text === "Inner"), "the nested note's text is not placed, as the diagnostic says");
});

test("an \\item whose body starts with a nested list keeps its own label, on a line of its own", () => {
  const result = run(
    "\\begin{itemize}\n\\item\n  \\begin{itemize}\\item inner\\end{itemize}\n\\item second\n\\end{itemize}",
  );
  const page = glyphRuns(result.pages[0]!);
  const bullets = page.filter((g) => g.text === "\u2022");
  assert.equal(bullets.length, 2, "both first-level items keep their bullet — losing the first one was the bug");

  const dash = page.find((g) => g.text === "\u2013")!;
  const inner = page.find((g) => g.text === "inner")!;
  assert.ok(dash && inner, "the nested item should still be set");
  assert.equal(dash.y, inner.y, "the nested label sits beside the nested item's first line");
  assert.ok(
    bullets[0]!.y < dash.y,
    "LaTeX gives the stranded outer label a line of its own, above the nested list",
  );
  assert.ok(bullets[0]!.x < dash.x, "and it hangs in the outer list's margin");
});

test("list spacing carries size10.clo's stretch and shrink, not just the natural widths", () => {
  const design = defaultDesign();

  // `\@listi`: `\parsep 4pt plus2pt minus1pt`, `\itemsep 4pt plus2pt minus1pt`.
  const one = listSpacing(design, 1);
  assert.deepEqual(
    { par: one.parSep, parPlus: one.parStretch, parMinus: one.parShrink },
    { par: 4, parPlus: 2, parMinus: 1 },
  );
  assert.deepEqual(
    { item: one.itemSep, itemPlus: one.itemStretch, itemMinus: one.itemShrink },
    { item: 4, itemPlus: 2, itemMinus: 1 },
  );

  // `\@listiii`: `\parsep \z@`, but `\itemsep \topsep` = `2pt plus1pt minus1pt`
  // — the two are *not* the same value, which the `parSep / 2` guess assumed.
  const three = listSpacing(design, 3);
  assert.deepEqual(
    { par: three.parSep, parPlus: three.parStretch, parMinus: three.parShrink },
    { par: 0, parPlus: 0, parMinus: 0 },
  );
  assert.deepEqual(
    { item: three.itemSep, itemPlus: three.itemStretch, itemMinus: three.itemShrink },
    { item: 2, itemPlus: 1, itemMinus: 1 },
  );
});

test("the glue between two list items is the \\itemsep the design computed, stretch and shrink included", () => {
  const build = buildDocument(
    { "main.tex": "\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\\item one\\item two\\end{itemize}\n\\end{document}\n" },
    "main.tex",
  );
  const design = defaultDesign();
  const ctx = createLayoutContext(design, fonts, createShaper(), createBudget(1_000_000, null), [], "main.tex", new Map());
  const list = buildVerticalList(build.document, ctx);

  const spacing = listSpacing(design, 1);
  const between = list.filter(
    (node): node is Extract<VNode, { kind: "glue" }> =>
      node.kind === "glue" && node.natural === spacing.itemSep && node.stretch > 0,
  );
  assert.ok(between.length > 0, "the item separation should reach the vertical list as rubber glue");
  for (const g of between) {
    assert.equal(g.stretch, spacing.itemStretch, "`\\itemsep`'s plus component must survive into the column");
    assert.equal(g.shrink, spacing.itemShrink, "and its minus component, which is not the same number");
  }
});
