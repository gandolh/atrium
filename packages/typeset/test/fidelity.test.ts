import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, createLatinModernProvider } from "../src/index.ts";
import type { CompileResult, GlyphRun, Page } from "../src/index.ts";
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
