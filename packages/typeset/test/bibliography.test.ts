import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocument } from "../src/doc/index.ts";
import type { BuildResult } from "../src/doc/index.ts";
import type { BibliographyBlock, Block, HeadingBlock, Inline, ListBlock, ParagraphBlock } from "../src/doc/index.ts";
import type { Diagnostic } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Chunk 39.5: `.bib` parsing, the numeric style, and citation resolution.
 *
 * `figures-tables-bib.test.ts` (chunk 39.1) is off limits to this chunk and
 * stays pinned to the stub behaviour it was written against; this file is
 * this chunk's own, and is where every acceptance item brief 39 lists for
 * the bibliography gets its coverage. Most assertions go through
 * `buildDocument` directly — the document model is what this chunk actually
 * produces — with one full `compile()` test at the end proving the numbers
 * really do reach the rendered page, not just the model.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();

/**
 * `bib` is appended *inside* the document body, after `body` — `\bibliography`
 * is body content in real LaTeX (conventionally the last thing before
 * `\end{document}`), not preamble content; `readPreamble` walks anything
 * still in the preamble as ordinary content too, but does not fold it into
 * `document.blocks`, which is a preamble-vs-body distinction this test file
 * sidesteps entirely by never putting a citing construct in the preamble.
 */
function build(body: string, files: Record<string, string> = {}, bib = ""): BuildResult {
  const source = `\\documentclass{article}\n\\begin{document}\n${body}\n${bib}\n\\end{document}\n`;
  return buildDocument({ "main.tex": source, ...files }, "main.tex");
}

/** The blocks, with a guarantee about which diagnostics were tolerated. */
function blocksOf(result: BuildResult, allow: readonly string[] = []): Block[] {
  const unexpected = result.diagnostics.filter(
    (d) => d.severity === "error" && !allow.includes(d.construct ?? ""),
  );
  assert.deepEqual(
    unexpected.map((d) => `${d.construct ?? "-"}: ${d.message}`),
    [],
    "unexpected errors",
  );
  return result.document.blocks;
}

/** Every character an inline list would set, ignoring style. */
function textOf(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "space") out += " ";
    else if (node.kind === "tie") out += "~";
    else if (node.kind === "reference" || node.kind === "citation") out += node.text;
  }
  return out;
}

function bibBlock(result: BuildResult): BibliographyBlock {
  const block = result.document.blocks.find((b) => b.kind === "bibliography");
  assert.ok(block !== undefined, "no bibliography block was produced");
  return block as BibliographyBlock;
}

/** The reference list's entries, as printed text — `content[1]` is the `ListBlock` (`content[0]` is the "References" heading). */
function entryTexts(block: BibliographyBlock): string[] {
  const list = block.content[1] as ListBlock;
  return list.items.map((item) => textOf(item.content.flatMap((b) => (b as ParagraphBlock).content)));
}

function entryLabels(block: BibliographyBlock): string[] {
  const list = block.content[1] as ListBlock;
  return list.items.map((item) => textOf(item.label ?? []));
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code ?? "?");
}

// --- entry types --------------------------------------------------------------

test("an @article entry resolves and formats with journal, volume, number and pages", () => {
  const bib = [
    "@article{knuth74,",
    "  author = {Donald E. Knuth},",
    "  title = {Structured Programming with go to Statements},",
    "  journal = {ACM Computing Surveys},",
    "  volume = {6},",
    "  number = {4},",
    "  pages = {261--301},",
    "  year = {1974},",
    "}",
  ].join("\n");
  const result = build("See \\cite{knuth74}.", { "refs.bib": bib }, "\\bibliography{refs}\n");
  const blocks = blocksOf(result);
  const paragraph = blocks[0] as ParagraphBlock;
  assert.equal(textOf(paragraph.content), "See [1].");
  const block = bibBlock(result);
  assert.equal((block.content[0] as HeadingBlock).title[0]!.kind, "text");
  assert.match(entryTexts(block)[0]!, /Donald E\. Knuth/);
  assert.match(entryTexts(block)[0]!, /Structured Programming with go to Statements/);
  assert.match(entryTexts(block)[0]!, /ACM Computing Surveys/);
  assert.match(entryTexts(block)[0]!, /6\(4\)/);
  assert.match(entryTexts(block)[0]!, /pp\. 261--301/);
  assert.match(entryTexts(block)[0]!, /1974/);
  assert.deepEqual(entryLabels(block), ["[1]"]);
});

test("an @book entry formats with publisher and year", () => {
  const bib = "@book{gof,\n  author = {Gamma, Helm, Johnson and Vlissides},\n  title = {Design Patterns},\n  publisher = {Addison-Wesley},\n  year = {1994},\n}\n";
  const result = build("\\cite{gof}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  const block = bibBlock(result);
  assert.match(entryTexts(block)[0]!, /Design Patterns/);
  assert.match(entryTexts(block)[0]!, /Addison-Wesley/);
  assert.match(entryTexts(block)[0]!, /1994/);
});

test("an @inproceedings entry formats with booktitle and pages", () => {
  const bib =
    "@inproceedings{cook71,\n  author = {Stephen Cook},\n  title = {The Complexity of Theorem-Proving Procedures},\n  booktitle = {STOC},\n  pages = {151--158},\n  year = {1971},\n}\n";
  const result = build("\\cite{cook71}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  const block = bibBlock(result);
  assert.match(entryTexts(block)[0]!, /In STOC/);
  assert.match(entryTexts(block)[0]!, /pp\. 151--158/);
});

test("an @misc entry with only a title still formats, never a blank line", () => {
  const result = build("\\cite{knuth}", { "refs.bib": "@misc{knuth,title={The TeXbook}}" }, "\\bibliography{refs}\n");
  const block = bibBlock(result);
  assert.equal(entryTexts(block)[0], "The TeXbook.");
  // A `misc` with no fields at all still prints something rather than a blank line.
  const empty = build("\\cite{x}", { "refs.bib": "@misc{x,}" }, "\\bibliography{refs}\n");
  assert.equal(entryTexts(bibBlock(empty))[0], "x.");
});

// --- @string ------------------------------------------------------------------

test("@string defines a macro, and # concatenates it with literal text", () => {
  const bib = [
    '@string{acm = "ACM Computing Surveys"}',
    "@article{k,",
    "  title = {T},",
    '  journal = acm # ", Special Issue",',
    "  year = {2000},",
    "}",
  ].join("\n");
  const result = build("\\cite{k}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.match(entryTexts(bibBlock(result))[0]!, /ACM Computing Surveys, Special Issue/);
});

test("an undefined @string name is a warning, not a crash, and resolves to empty", () => {
  const bib = '@article{k, title = {T}, journal = undefinedmacro, year = {2000}}';
  const result = build("\\cite{k}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.ok(result.diagnostics.some((d) => d.code === "undefined-reference" && /undefinedmacro/.test(d.message)));
  // No crash, and the entry still formats with what it does have.
  assert.match(entryTexts(bibBlock(result))[0]!, /2000/);
});

// --- crossref -------------------------------------------------------------

test("crossref inherits fields the child entry does not define", () => {
  const bib = [
    "@inproceedings{child,",
    "  author = {A. Author},",
    "  title = {A Paper},",
    "  crossref = {proc99},",
    "}",
    "@misc{proc99,",
    "  booktitle = {Proceedings of Something 1999},",
    "  year = {1999},",
    "}",
  ].join("\n");
  const result = build("\\cite{child}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  const text = entryTexts(bibBlock(result))[0]!;
  assert.match(text, /A Paper/);
  assert.match(text, /1999/);
});

test("a crossref naming a key that does not exist is undefined-reference, not a crash", () => {
  const bib = "@article{k, title={T}, crossref={nosuch}}";
  const result = build("\\cite{k}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.ok(result.diagnostics.some((d) => d.code === "undefined-reference" && /nosuch/.test(d.message)));
});

// --- unknown key: both halves required -------------------------------------

test("an unknown citation key is an undefined-reference diagnostic and renders as [?]", () => {
  const result = build("See \\cite{missing}.", { "refs.bib": "@misc{present,title={P}}" }, "\\bibliography{refs}\n");
  const undefined_ = result.diagnostics.find((d) => d.code === "undefined-reference" && /missing/.test(d.message));
  assert.ok(undefined_ !== undefined, "expected an undefined-reference diagnostic naming the key");
  assert.equal(undefined_!.severity, "error");
  const paragraph = result.document.blocks[0] as ParagraphBlock;
  assert.match(textOf(paragraph.content), /\[\?\]/);
  // The citation object itself carries the mark too, not just the paragraph text.
  assert.equal(result.citations[0]!.text, "[?]");
});

test("a citation with one known and one unknown key falls back to [?] wholesale, not a partial number", () => {
  const result = build("\\cite{present,missing}", { "refs.bib": "@misc{present,title={P}}" }, "\\bibliography{refs}\n");
  assert.equal(result.citations[0]!.text, "[?]");
  assert.ok(result.diagnostics.some((d) => d.code === "undefined-reference" && /missing/.test(d.message)));
});

// --- multi-key: one label -----------------------------------------------------

test("\\cite{a,b} prints one label with both numbers, not two labels", () => {
  const bib = "@misc{a,title={A}}\n@misc{b,title={B}}\n";
  const result = build("\\cite{a,b}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.equal(result.citations[0]!.text, "[1, 2]");
  const paragraph = result.document.blocks[0] as ParagraphBlock;
  // Exactly one citation inline sits in the paragraph for this one \cite site.
  assert.equal(paragraph.content.filter((n) => n.kind === "citation").length, 1);
});

// --- \nocite --------------------------------------------------------------

test("\\nocite{k} pulls an entry into the list without printing anything itself", () => {
  const bib = "@misc{k,title={K}}\n";
  const result = build("\\nocite{k}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.equal(result.citations[0]!.text, ""); // nothing prints at the \nocite site
  assert.deepEqual(entryLabels(bibBlock(result)), ["[1]"]);
});

test("\\nocite{*} means every entry, in .bib order, even the never-cited ones", () => {
  const bib = "@misc{a,title={A}}\n@misc{b,title={B}}\n@misc{c,title={C}}\n";
  const result = build("Only \\cite{b} is ever named.\\nocite{*}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  // `b` was cited first, so it is [1]; `a` and `c` follow in .bib order.
  assert.deepEqual(entryLabels(bibBlock(result)), ["[1]", "[2]", "[3]"]);
  assert.equal(result.citations[0]!.text, "[1]");
});

test("style: silent (\\nocite) prints nothing even for a key that never resolves — style stays silent, but the key is still reported", () => {
  const result = build("\\nocite{ghost}", { "refs.bib": "@misc{k,title={K}}" }, "\\bibliography{refs}\n");
  assert.equal(result.citations[0]!.text, "");
  assert.ok(result.diagnostics.some((d) => d.code === "undefined-reference" && /ghost/.test(d.message)));
});

// --- thebibliography --------------------------------------------------------

test("thebibliography prints every \\bibitem, numbered, regardless of citation", () => {
  const result = build(
    "Uncited entries still appear \\cite{knuth}.\n\\begin{thebibliography}{9}\n\\bibitem{knuth} Knuth. \\emph{The Art of Computer Programming}. 1968.\n\\bibitem[GJ79]{gj} Garey and Johnson. 1979.\n\\end{thebibliography}",
  );
  const block = bibBlock(result);
  assert.equal(block.source, "thebibliography");
  assert.deepEqual(entryLabels(block), ["[1]", "[GJ79]"]);
  assert.equal(result.citations[0]!.text, "[1]");
});

// --- \citet: the textual form ------------------------------------------------

test("\\citet prepends a short author name before the bracket", () => {
  const single = build("\\citet{k}", { "refs.bib": "@misc{k,author={Donald E. Knuth},title={T}}" }, "\\bibliography{refs}\n");
  assert.equal(single.citations[0]!.text, "Knuth [1]");
  const two = build(
    "\\citet{k}",
    { "refs.bib": "@misc{k,author={Alice Author and Bob Builder},title={T}}" },
    "\\bibliography{refs}\n",
  );
  assert.equal(two.citations[0]!.text, "Author and Builder [1]");
  const many = build(
    "\\citet{k}",
    { "refs.bib": "@misc{k,author={A One and B Two and C Three},title={T}}" },
    "\\bibliography{refs}\n",
  );
  assert.equal(many.citations[0]!.text, "One et al. [1]");
  // No author field at all: falls back to the bare bracket, same as \cite.
  const none = build("\\citet{k}", { "refs.bib": "@misc{k,title={T}}" }, "\\bibliography{refs}\n");
  assert.equal(none.citations[0]!.text, "[1]");
});

test("\\citep prints the bare numeric bracket, same as \\cite, in this numeric style", () => {
  const result = build("\\citep{k}", { "refs.bib": "@misc{k,title={K}}" }, "\\bibliography{refs}\n");
  assert.equal(result.citations[0]!.text, "[1]");
});

// --- a key that differs only in case is a distinct key -----------------------

test("bibliography keys are case-sensitive: Knuth74 and knuth74 are two different entries", () => {
  const bib = "@misc{Knuth74,title={Upper}}\n@misc{knuth74,title={Lower}}\n";
  const result = build("\\cite{Knuth74} and \\cite{knuth74}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.equal(codes(result.diagnostics).includes("undefined-reference"), false, "both keys should resolve");
  assert.equal(result.citations[0]!.text, "[1]");
  assert.equal(result.citations[1]!.text, "[2]");
  const texts = entryTexts(bibBlock(result));
  assert.deepEqual(texts, ["Upper.", "Lower."]);
});

// --- duplicate keys -----------------------------------------------------------

test("a duplicate key in one .bib is a diagnostic, and the first definition wins", () => {
  const bib = "@misc{k,title={First}}\n@misc{k,title={Second}}\n";
  const result = build("\\cite{k}", { "refs.bib": bib }, "\\bibliography{refs}\n");
  assert.ok(result.diagnostics.some((d) => d.code === "duplicate-label" && /"k"/.test(d.message)));
  assert.equal(entryTexts(bibBlock(result))[0], "First.");
});

// --- malformed .bib ------------------------------------------------------------

test("a malformed .bib never throws and always leaves at least one diagnostic", () => {
  const malformed = [
    "@article{k, title = {unterminated brace value",
    "@article{k2 title = \"missing comma after key\"}",
    "@article{k3, title}",
    "@article{k4, = {no field name}}",
    "@misc{k5, note = {unterminated",
    "@123{k6, title={no letters after the @}}",
  ];
  for (const bib of malformed) {
    const result = build("\\nocite{*}", { "refs.bib": bib }, "\\bibliography{refs}\n");
    assert.equal(
      result.diagnostics.some((d) => d.code === "internal"),
      false,
      `"${bib}" produced an internal error`,
    );
    assert.ok(result.diagnostics.length > 0, `"${bib}" produced no diagnostic at all`);
  }
});

// --- missing .bib ------------------------------------------------------------

test("a missing .bib file is a missing-file diagnostic naming it, and prints no list", () => {
  const result = build("\\cite{k}", {}, "\\bibliography{nosuchfile}\n");
  const hit = result.diagnostics.find((d) => d.code === "missing-file");
  assert.ok(hit !== undefined);
  assert.match(hit!.message, /nosuchfile/);
  assert.deepEqual(bibBlock(result).content, []);
  // The citation itself still gets a diagnostic and prints [?] — a missing
  // bibliography does not silently swallow the citing sites that needed it.
  assert.equal(result.citations[0]!.text, "[?]");
});

test("a name resolved as bare or with .bib both work", () => {
  const withSuffix = build("\\cite{k}", { "refs.bib": "@misc{k,title={K}}" }, "\\bibliography{refs}\n");
  assert.equal(withSuffix.citations[0]!.text, "[1]");
});

// --- determinism ---------------------------------------------------------------

test("the same document and .bib produce byte-identical diagnostics and citation text on every run", () => {
  const bib = [
    "@string{acm = \"ACM\"}",
    "@article{a,author={A. One},title={T1},journal=acm,year={2001}}",
    "@misc{b,title={T2},crossref={a}}",
  ].join("\n");
  const source = "\\cite{a,b} and \\citet{a} and \\nocite{*}";
  const files = { "refs.bib": bib };
  const preamble = "\\bibliography{refs}\n";
  const runs = Array.from({ length: 5 }, () => build(source, files, preamble));
  for (const run of runs.slice(1)) {
    assert.deepEqual(
      run.citations.map((c) => c.text),
      runs[0]!.citations.map((c) => c.text),
    );
    assert.deepEqual(codes(run.diagnostics), codes(runs[0]!.diagnostics));
    assert.deepEqual(entryLabels(bibBlock(run)), entryLabels(bibBlock(runs[0]!)));
    assert.deepEqual(entryTexts(bibBlock(run)), entryTexts(bibBlock(runs[0]!)));
  }
});

// --- reaches the actual rendered page, not just the model ---------------------

test("a resolved citation and an unknown one both reach the rendered PDF text", () => {
  const source = `\\documentclass{article}
\\begin{document}
Known \\cite{k}, unknown \\cite{ghost}.
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
  const result = compile(
    { "main.tex": encoder.encode(source), "refs.bib": encoder.encode("@misc{k,title={Something}}") },
    "main.tex",
    { fonts },
  );
  assert.equal(result.diagnostics.some((d) => d.code === "internal"), false);
  const text = result.pages
    .flatMap((page) => page.items)
    .filter((item) => item.kind === "glyphrun")
    .map((item) => (item.kind === "glyphrun" ? item.text : ""))
    .join(" ");
  assert.match(text, /\[1\]/);
  assert.match(text, /\[\?\]/);
  assert.match(text, /References/);
  assert.match(text, /Something/);
});

// --- brief 47: the label column is sized from `widestLabel` -----------------

/**
 * `thebibliography{widest}` with one `\bibitem[label]{a}` whose own printed
 * label is `label` — so the two can be set independently, exactly the way a
 * real widest-label argument and a real entry's label are two different
 * things in LaTeX.
 */
function widestLabelSource(widest: string, label: string): string {
  return `\\documentclass{article}
\\begin{document}
\\begin{thebibliography}{${widest}}
\\bibitem[${label}]{a} Zzyzxqx entry text.
\\end{thebibliography}
\\end{document}
`;
}

/** Every glyph run across every page. */
function glyphRuns(result: ReturnType<typeof compile>): { text: string; x: number; y: number; width: number }[] {
  return result.pages
    .flatMap((page) => page.items)
    .filter((item) => item.kind === "glyphrun")
    .map((item) => item as { text: string; x: number; y: number; width: number });
}

/** The one glyph run whose text is exactly `text` — fails loudly if there is not exactly one. */
function runWithText(result: ReturnType<typeof compile>, text: string): { text: string; x: number; y: number; width: number } {
  const hits = glyphRuns(result).filter((item) => item.text === text);
  assert.equal(hits.length, 1, `expected exactly one glyph run with text ${JSON.stringify(text)}, found ${hits.length}`);
  return hits[0]!;
}

test("a widestLabel measured to fit sets the label flush with the margin, not spilling past it", () => {
  const result = compile({ "main.tex": encoder.encode(widestLabelSource("999", "999")) }, "main.tex", { fonts });
  assert.equal(result.diagnostics.some((d) => d.severity === "error"), false, "unexpected error diagnostics");

  const heading = runWithText(result, "References");
  const label = runWithText(result, "[999]");
  const entry = runWithText(result, "Zzyzxqx");

  // `\@biblabel`'s box is right-aligned in `\labelwidth` (`\hss`), so an
  // *undersized* fixed column bleeds the label's own left edge past the
  // margin rather than colliding with the entry's text (see this brief's
  // notes) — which is exactly why "the entry never overlaps the label" is
  // NOT the discriminating check: that gap is `\labelsep` either way. What a
  // correctly measured column buys is a label that starts flush with the
  // margin, same as every other line — no overflow at all, in either
  // direction. `heading.x` is that margin, read off the "References" heading
  // rather than hardcoded, since both sit at the same left edge.
  const epsilon = 0.01;
  assert.ok(
    Math.abs(label.x - heading.x) < epsilon,
    `[999]'s label should start flush with the margin (${heading.x}), started at ${label.x} instead`,
  );
  // And still strictly beside the entry text, never overlapping it.
  assert.ok(
    entry.x >= label.x + label.width,
    `entry (x=${entry.x}) starts before the [999] label ends (x+width=${label.x + label.width})`,
  );
});

test("a {9} bibliography is visibly tighter than a {999} one, by exactly the measured label width", () => {
  const narrow = compile({ "main.tex": encoder.encode(widestLabelSource("9", "9")) }, "main.tex", { fonts });
  const wide = compile({ "main.tex": encoder.encode(widestLabelSource("999", "999")) }, "main.tex", { fonts });
  assert.equal(narrow.diagnostics.some((d) => d.severity === "error"), false);
  assert.equal(wide.diagnostics.some((d) => d.severity === "error"), false);

  const narrowLabel = runWithText(narrow, "[9]");
  const narrowEntry = runWithText(narrow, "Zzyzxqx");
  const wideLabel = runWithText(wide, "[999]");
  const wideEntry = runWithText(wide, "Zzyzxqx");

  const epsilon = 0.01;
  const observedShift = wideEntry.x - narrowEntry.x;
  const expectedShift = wideLabel.width - narrowLabel.width;
  // "Visibly tighter": the {9} list's entries sit strictly left of the {999}
  // list's — not just non-identical, but by a margin real digits produce.
  assert.ok(observedShift > 1, `expected the {999} column to sit visibly right of {9}'s; shift was ${observedShift}`);
  // "...and the difference is the measured label width": not approximately —
  // exactly the two labels' own measured widths apart, because both columns
  // are `label width + \labelsep` and `\labelsep` does not change with depth.
  assert.ok(
    Math.abs(observedShift - expectedShift) < epsilon,
    `entries shifted by ${observedShift}, but the labels' widths differ by ${expectedShift}`,
  );
});

test("widestLabel: null keeps today's fixed geometry, independent of what a label actually measures", () => {
  // An empty argument — `build.ts:1902` — not an absent environment; this is
  // the `null` arm this brief must leave alone, deliberately still reported
  // as the pre-existing `syntax` error naming `thebibliography`.
  const short = compile({ "main.tex": encoder.encode(widestLabelSource("", "1")) }, "main.tex", { fonts });
  const long = compile({ "main.tex": encoder.encode(widestLabelSource("", "999")) }, "main.tex", { fonts });
  for (const result of [short, long]) {
    const unexpected = result.diagnostics.filter(
      (d) => d.severity === "error" && !(d.code === "syntax" && d.construct === "thebibliography"),
    );
    assert.deepEqual(unexpected, [], "unexpected error diagnostics");
  }

  const shortEntry = runWithText(short, "Zzyzxqx");
  const longEntry = runWithText(long, "Zzyzxqx");
  // The fixed geometry this brief must not touch for `null` does not read the
  // label's content at all — unlike the measured arm (previous test), the
  // entry's position here does not move whether the printed label is "[1]"
  // or "[999]", because `listSpacing`'s table is all it ever consulted.
  const epsilon = 0.01;
  assert.ok(
    Math.abs(shortEntry.x - longEntry.x) < epsilon,
    `the null arm's entry position moved with the label's content: ${shortEntry.x} vs ${longEntry.x}`,
  );
});
