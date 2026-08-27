import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocument } from "../src/doc/index.ts";
import type { BuildResult } from "../src/doc/index.ts";
import type {
  BibliographyBlock,
  Block,
  CaptionBlock,
  FloatBlock,
  ImageInline,
  Inline,
  ListOfBlock,
  ParagraphBlock,
  TableBlock,
} from "../src/doc/index.ts";
import type { CompileResult, Diagnostic } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Brief 39, chunk 39.1: the LaTeX-facing contract for figures, tables and
 * bibliography. Every construct here **parses, validates and numbers**; none of
 * them is set yet, because measurement, placement, image decode and `.bib`
 * parsing are four seams four later chunks fill in.
 *
 * So the assertions are of two kinds and nothing in between:
 *
 * - on the **document model** — the blocks, the grid, the keys, the numbers —
 *   which is what this chunk actually produces, and
 * - on the **diagnostics** — that every construct reaches a seam that says
 *   loudly it is not implemented yet (D38), exactly once, with a file and a
 *   line.
 *
 * Nothing here asserts on layout geometry. When a seam lands, its chunk's own
 * goldens will; a test that pinned a stub's non-output would only have to be
 * deleted.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();

function build(body: string, preamble = "", files: Record<string, string> = {}): BuildResult {
  const source = `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
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

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code ?? "?");
}

function find(result: BuildResult, construct: string): Diagnostic | undefined {
  return result.diagnostics.find((d) => d.construct === construct);
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

function compileSource(source: string, files: Record<string, Uint8Array> = {}): CompileResult {
  return compile({ "main.tex": encoder.encode(source), ...files }, "main.tex", { fonts });
}

function doc(body: string): string {
  return `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

// --- floats -----------------------------------------------------------------

test("a figure becomes a float block carrying its content and its placement", () => {
  const [block] = blocksOf(build("\\begin{figure}[htbp]\nA plot.\n\\end{figure}"));
  const float = block as FloatBlock;
  assert.equal(float.kind, "float");
  assert.equal(float.floatClass, "figure");
  assert.equal(float.construct, "figure");
  assert.equal(float.spanning, false);
  assert.deepEqual(float.placement.letters, ["h", "t", "b", "p"]);
  assert.equal(float.placement.explicit, true);
  assert.equal(float.placement.override, false);
  assert.equal(float.content.length, 1);
  assert.equal(textOf((float.content[0] as ParagraphBlock).content), "A plot.");
});

test("placement letters keep the order written, drop duplicates, and record `!`", () => {
  const float = blocksOf(build("\\begin{table}[!bt b]\nx\n\\end{table}"))[0] as FloatBlock;
  assert.deepEqual(float.placement.letters, ["b", "t"]);
  assert.equal(float.placement.override, true);
  assert.equal(float.floatClass, "table");
});

test("a float with no [...] gets the class default, marked as not explicit", () => {
  const float = blocksOf(build("\\begin{figure}\nx\n\\end{figure}"))[0] as FloatBlock;
  assert.deepEqual(float.placement.letters, ["t", "b", "p"]);
  assert.equal(float.placement.explicit, false);
});

test("the starred forms are floats that know they span", () => {
  for (const [name, floatClass] of [["figure*", "figure"], ["table*", "table"]] as const) {
    const float = blocksOf(build(`\\begin{${name}}\nx\n\\end{${name}}`))[0] as FloatBlock;
    assert.equal(float.spanning, true, name);
    assert.equal(float.floatClass, floatClass);
    assert.equal(float.construct, name);
  }
});

test("an unknown placement letter is a diagnostic, and the rest still parse", () => {
  const result = build("\\begin{figure}[hz]\nx\n\\end{figure}");
  const hit = find(result, "figure");
  assert.ok(hit !== undefined);
  assert.equal(hit.code, "syntax");
  assert.match(hit.message, /not a float placement letter/);
  assert.deepEqual((result.document.blocks[0] as FloatBlock).placement.letters, ["h"]);
});

test("the float package's [H] is `unsupported`, not a syntax error", () => {
  const result = build("\\begin{figure}[H]\nx\n\\end{figure}");
  const hit = find(result, "figure[H]");
  assert.ok(hit !== undefined);
  assert.equal(hit.code, "unsupported");
});

test("a placement option with no usable letter warns and falls back to the default", () => {
  const result = build("\\begin{figure}[!]\nx\n\\end{figure}");
  const hit = find(result, "figure");
  assert.ok(hit !== undefined);
  assert.equal(hit.severity, "warning");
  assert.deepEqual((result.document.blocks[0] as FloatBlock).placement.letters, ["t", "b", "p"]);
});

test("a nested float is a diagnostic, and neither float is dropped", () => {
  const result = build("\\begin{figure}\n\\begin{table}\nx\n\\end{table}\n\\end{figure}");
  const hit = result.diagnostics.find((d) => d.code === "syntax" && /do not nest/.test(d.message));
  assert.ok(hit !== undefined);
  const outer = result.document.blocks[0] as FloatBlock;
  assert.equal(outer.floatClass, "figure");
  assert.equal((outer.content[0] as FloatBlock).floatClass, "table");
});

test("an empty float warns rather than sets nothing quietly", () => {
  const result = build("\\begin{figure}\n\\end{figure}");
  const hit = find(result, "figure");
  assert.ok(hit !== undefined);
  assert.equal(hit.severity, "warning");
  assert.match(hit.message, /empty/);
});

// --- captions ---------------------------------------------------------------

test("captions number per float class, independently of each other", () => {
  const result = build(
    [
      "\\begin{figure}\\caption{One}\\end{figure}",
      "\\begin{table}\\caption{Two}\\end{table}",
      "\\begin{figure}\\caption{Three}\\end{figure}",
    ].join("\n"),
  );
  assert.deepEqual(
    result.document.floatList.map((e) => [e.floatClass, e.number, textOf(e.title)]),
    [
      ["figure", "1", "One"],
      ["table", "1", "Two"],
      ["figure", "2", "Three"],
    ],
  );
});

test("a caption is a block inside the float, in the position it was written", () => {
  const float = blocksOf(build("\\begin{figure}\nAbove.\n\\caption{Below}\n\\end{figure}"))[0] as FloatBlock;
  assert.deepEqual(float.content.map((b) => b.kind), ["paragraph", "caption"]);
  const caption = float.content[1] as CaptionBlock;
  assert.equal(caption.number, "1");
  assert.equal(caption.floatClass, "figure");
  assert.equal(textOf(caption.content), "Below");
  assert.equal(caption.marker, "caption:0");
});

test("a \\label after a \\caption refers to the caption's number, through the existing pass", () => {
  const result = build(
    "\\begin{figure}\\caption{Cap}\\label{fig:a}\\end{figure}\nSee \\ref{fig:a} and \\ref{fig:missing}.",
  );
  assert.equal(result.document.labels.get("fig:a")?.text, "1");
  const prose = result.document.blocks[1] as ParagraphBlock;
  assert.equal(textOf(prose.content), "See 1 and ??.");
  assert.ok(
    result.diagnostics.some((d) => d.code === "undefined-reference" && /fig:missing/.test(d.message)),
  );
});

test("a \\label inside the caption's own argument gets the caption's number too", () => {
  const result = build("\\begin{table}\\caption{Cap\\label{t}}\\end{table}");
  assert.equal(result.document.labels.get("t")?.text, "1");
});

test("a \\caption outside a float is refused, not numbered", () => {
  const result = build("\\caption{orphan}");
  assert.equal(result.document.blocks.length, 0);
  assert.equal(result.document.floatList.length, 0);
  const syntax = result.diagnostics.find((d) => d.code === "syntax" && d.construct === "\\caption");
  assert.ok(syntax !== undefined);
  assert.match(syntax.message, /only allowed inside a figure or table/);
  // And that is now the *whole* of it. Chunk 39.4 retired the interim
  // `unsupported` notice that used to ride beside this error: a caption with no
  // float to number is wrong forever, not wrong until a capability lands, and
  // saying "not implemented yet" about it was a promise nobody meant to keep.
  assert.equal(
    result.diagnostics.some((d) => d.code === "unsupported" && d.construct === "\\caption"),
    false,
  );
});

test("\\caption[short] and \\caption* are each their own diagnostic", () => {
  assert.ok(find(build("\\begin{figure}\\caption[S]{Long}\\end{figure}"), "\\caption[...]") !== undefined);
  const result = build("\\begin{figure}\\caption*{The text}\\end{figure}");
  const starred = find(result, "\\caption*");
  assert.ok(starred !== undefined);
  assert.equal(starred.code, "unsupported");
  // And the text is still the caption's: `\caption*{X}` parses as `\caption`
  // with the *star* as its argument and `{X}` as a sibling, so leaving it alone
  // set "*" as the caption and "X" as a stray paragraph.
  const caption = (result.document.blocks[0] as FloatBlock).content[0] as CaptionBlock;
  assert.equal(caption.kind, "caption");
  assert.equal(textOf(caption.content), "The text");
});

test("\\listoffigures and \\listoftables become blocks naming their class", () => {
  const blocks = blocksOf(build("\\listoffigures\n\\listoftables"));
  assert.deepEqual(blocks.map((b) => b.kind), ["listof", "listof"]);
  assert.equal((blocks[0] as ListOfBlock).floatClass, "figure");
  assert.equal((blocks[1] as ListOfBlock).floatClass, "table");
});

test("\\listoffigures sets a heading and each caption's number and text", () => {
  const result = compileSource(
    doc("\\listoffigures\n\\begin{figure}\\caption{The plot}\\end{figure}"),
  );
  const text = result.pages
    .flatMap((page) => page.items)
    .filter((item) => item.kind === "glyphrun")
    .map((item) => (item.kind === "glyphrun" ? item.text : ""))
    .join(" ");
  assert.match(text, /List of Figures/);
  assert.match(text, /The plot/);
});

// --- images -----------------------------------------------------------------

function imageOf(body: string): ImageInline {
  const result = build(body);
  const paragraph = result.document.blocks[0] as ParagraphBlock;
  const image = paragraph.content.find((inline) => inline.kind === "image");
  assert.ok(image !== undefined, "no image inline was produced");
  return image as ImageInline;
}

test("\\includegraphics becomes an image inline carrying the file name", () => {
  const image = imageOf("\\includegraphics{figures/plot.png}");
  assert.equal(image.path, "figures/plot.png");
  assert.deepEqual(image.sizing, { width: null, height: null, scale: null });
});

test("width, height and scale are recorded as the source wrote them", () => {
  const image = imageOf("\\includegraphics[width=3cm,height=2in,scale=1]{a}");
  assert.deepEqual(image.sizing.width, { kind: "points", value: 3 * (72 / 2.54) });
  assert.deepEqual(image.sizing.height, { kind: "points", value: 144 });
  assert.equal(image.sizing.scale, 1);
});

test("a \\textwidth-relative width stays relative, unresolved", () => {
  assert.deepEqual(imageOf("\\includegraphics[width=0.5\\textwidth]{a}").sizing.width, {
    kind: "relative",
    factor: 0.5,
    of: "textwidth",
  });
  assert.deepEqual(imageOf("\\includegraphics[width=\\linewidth]{a}").sizing.width, {
    kind: "relative",
    factor: 1,
    of: "linewidth",
  });
  assert.deepEqual(imageOf("\\includegraphics[height=2em]{a}").sizing.height, {
    kind: "font",
    value: 2,
    unit: "em",
  });
});

test("scale beside an explicit size warns, because LaTeX resolves it silently", () => {
  const result = build("\\includegraphics[scale=2,width=1in]{a}");
  const hit = result.diagnostics.find((d) => d.severity === "warning" && /scale=/.test(d.message));
  assert.ok(hit !== undefined);
});

test("an unreadable length and an unknown key are each a diagnostic", () => {
  assert.equal(
    build("\\includegraphics[width=wide]{a}").diagnostics.filter((d) => d.code === "syntax").length,
    1,
  );
  const unknown = find(build("\\includegraphics[angle=90]{a}"), "\\includegraphics[angle=...]");
  assert.ok(unknown !== undefined);
  assert.equal(unknown.code, "unsupported");
});

test("\\includegraphics with no file name is a diagnostic and still reaches the seam", () => {
  // `build()` is the document layer alone, and now that chunk 39.2 has
  // landed, the document layer emits no diagnostic of its own for
  // `\includegraphics` beyond the syntax check on the file name — decoding
  // and placing (or failing to) is `src/image/`'s job at layout time. So the
  // "still reaches a seam" half of this test now needs the full pipeline:
  // an empty file name reaches `placeImage`, which reports it as
  // `missing-file` ("no file name was given") rather than silently vanishing.
  const result = compileSource(doc("\\includegraphics"));
  assert.ok(result.diagnostics.some((d) => d.code === "syntax" && /needs a file name/.test(d.message)));
  assert.ok(result.diagnostics.some((d) => d.code === "missing-file" && d.construct === "\\includegraphics"));
});

test("the engine reads no image bytes: a compile with an unreadable file still returns", () => {
  const result = compileSource(doc("\\includegraphics{broken.png}"), {
    "broken.png": new Uint8Array([0, 1, 2, 3]),
  });
  assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.some((d) => d.construct === "\\includegraphics"));
  assert.ok(result.pages.length >= 1, "the rest of the document is still laid out");
});

// --- tables -----------------------------------------------------------------

function tableOf(body: string, allow: readonly string[] = ["tabular"]): TableBlock {
  const blocks = blocksOf(build(body), allow);
  const table = blocks.find((block) => block.kind === "table");
  assert.ok(table !== undefined, "no table block was produced");
  return table as TableBlock;
}

test("a column specification becomes columns plus the rules between them", () => {
  const table = tableOf("\\begin{tabular}{|l|c|p{3cm}||r|}a\\end{tabular}");
  assert.deepEqual(
    table.spec.columns.map((c) => [c.align, c.rulesBefore, c.width]),
    [
      ["left", 1, null],
      ["center", 1, null],
      ["paragraph", 1, { kind: "points", value: 3 * (72 / 2.54) }],
      ["right", 2, null],
    ],
  );
  assert.equal(table.spec.rulesAfter, 1);
});

test("cells split at & and rows at \\\\, with a trailing \\\\ not making an empty row", () => {
  const table = tableOf("\\begin{tabular}{lll}\na & b & c \\\\\nd & e & f \\\\\n\\end{tabular}");
  assert.deepEqual(
    table.rows.map((row) => row.cells.map((cell) => textOf(cell.content))),
    // Trailing space is trimmed, as it is at the end of any paragraph.
    [
      ["a", "b", "c"],
      ["d", "e", "f"],
    ],
  );
});

test("an escaped ampersand is content, not a cell separator", () => {
  const table = tableOf("\\begin{tabular}{ll}a\\&b & c\\end{tabular}");
  assert.deepEqual(table.rows[0]!.cells.map((cell) => textOf(cell.content)), ["a&b", "c"]);
});

test("\\hline is collected above the row it precedes, and after the last row below the table", () => {
  const table = tableOf("\\begin{tabular}{l}\\hline\\hline\na \\\\\n\\hline\nb \\\\\n\\hline\n\\end{tabular}");
  assert.deepEqual(table.rows.map((row) => row.rulesAbove.length), [2, 1]);
  assert.equal(table.rulesBelow.length, 1);
  assert.deepEqual(table.rulesBelow[0]!.from, null);
});

test("\\cline records the range it spans, whether its argument is attached or a sibling", () => {
  const table = tableOf("\\begin{tabular}{lll}a&b&c\\\\\\cline{2-3}\nd&e&f\\end{tabular}");
  const rule = table.rows[1]!.rulesAbove[0];
  assert.ok(rule !== undefined);
  assert.equal(rule.from, 2);
  assert.equal(rule.to, 3);
});

test("\\multicolumn spans columns and overrides their alignment", () => {
  const table = tableOf("\\begin{tabular}{lll}\\multicolumn{2}{|c|}{wide} & last\\end{tabular}");
  const [first, second] = table.rows[0]!.cells;
  assert.equal(first!.span, 2);
  assert.equal(textOf(first!.content), "wide");
  assert.equal(first!.override?.align, "center");
  assert.equal(first!.override?.rulesBefore, 1);
  assert.equal(first!.overrideRulesAfter, 1);
  assert.equal(second!.span, 1);
  assert.equal(second!.override, null);
});

test("a row with more cells than the spec declares is a diagnostic", () => {
  const result = build("\\begin{tabular}{ll}a & b & c\\end{tabular}");
  const hit = result.diagnostics.find((d) => d.code === "syntax");
  assert.ok(hit !== undefined);
  assert.match(hit.message, /3 cells but the column specification declares 2/);
  // Reported, not dropped: the grid is still in the model.
  assert.equal((result.document.blocks[0] as TableBlock).rows[0]!.cells.length, 3);
});

test("a row with fewer cells than the spec declares is legal LaTeX and stays quiet", () => {
  // Chunk 39.3 landed column measurement and grid setting for `tabular`, so
  // the interim `unsupported` notice that used to fire on every tabular
  // (regardless of this test's actual point) is gone. What is left is the
  // real assertion this test was always trying to make: an underfull row is
  // legal and produces no diagnostic at all.
  const result = build("\\begin{tabular}{ll}a\\end{tabular}");
  assert.deepEqual(codes(result.diagnostics), []);
});

test("a malformed column specification is a diagnostic per problem", () => {
  const unknown = build("\\begin{tabular}{lq}a&b\\end{tabular}");
  assert.ok(
    unknown.diagnostics.some((d) => d.code === "syntax" && /not a column type/.test(d.message)),
  );
  const noWidth = build("\\begin{tabular}{lp}a&b\\end{tabular}");
  assert.ok(noWidth.diagnostics.some((d) => d.code === "syntax" && /needs a width/.test(d.message)));
  const badWidth = build("\\begin{tabular}{p{wide}}a\\end{tabular}");
  assert.ok(badWidth.diagnostics.some((d) => d.code === "syntax" && /not a column width/.test(d.message)));
  const empty = build("\\begin{tabular}{}a\\end{tabular}");
  assert.ok(empty.diagnostics.some((d) => d.code === "syntax" && /no columns/.test(d.message)));
  // With nothing at all after `\begin{tabular}` the parser fills no argument
  // slot, which is the one shape that reaches the "no specification" branch:
  // given any following token it takes *that* as the specification instead, and
  // then reports it as an unknown column type.
  const missing = build("\\begin{tabular}\\end{tabular}");
  assert.ok(
    missing.diagnostics.some((d) => d.code === "syntax" && /needs a column specification/.test(d.message)),
  );
});

test("the array package's column types are `unsupported`, naming themselves", () => {
  for (const spec of ["m{2cm}", "b{2cm}", "X", "@{}l", ">{\\bfseries}l", "*{2}{l}"]) {
    const result = build(`\\begin{tabular}{${spec}}a\\end{tabular}`);
    assert.ok(
      result.diagnostics.some((d) => d.code === "unsupported" && /column/.test(d.construct ?? "")),
      `${spec} did not report an unsupported column: ${JSON.stringify(result.diagnostics)}`,
    );
  }
});

test("a \\cline outside the table's columns, and a malformed one, are diagnostics", () => {
  assert.ok(
    build("\\begin{tabular}{ll}a&b\\\\\\cline{1-9}\nc&d\\end{tabular}").diagnostics.some(
      (d) => d.code === "syntax" && /outside this/.test(d.message),
    ),
  );
  assert.ok(
    build("\\begin{tabular}{ll}a&b\\\\\\cline{oops}\nc&d\\end{tabular}").diagnostics.some(
      (d) => d.code === "syntax" && /not a column range/.test(d.message),
    ),
  );
});

test("a rule or a \\multicolumn in the wrong place is a diagnostic, never a crash", () => {
  assert.ok(
    build("\\begin{tabular}{ll}a\\hline & b\\end{tabular}").diagnostics.some(
      (d) => d.construct === "\\hline" && d.code === "syntax",
    ),
  );
  assert.ok(
    build("\\begin{tabular}{ll}a\\multicolumn{2}{c}{x}\\end{tabular}").diagnostics.some(
      (d) => d.construct === "\\multicolumn" && /first thing in its cell/.test(d.message),
    ),
  );
  assert.ok(
    build("\\begin{tabular}{ll}\\multicolumn{2}{c}\\end{tabular}").diagnostics.some(
      (d) => d.construct === "\\multicolumn" && /three arguments/.test(d.message),
    ),
  );
});

test("row spacing on \\\\ and a tabular's [t] alignment are each `unsupported`", () => {
  assert.ok(find(build("\\begin{tabular}{l}a\\\\[2pt]b\\end{tabular}"), "\\\\[...]") !== undefined);
  assert.ok(find(build("\\begin{tabular}[t]{l}a\\end{tabular}"), "tabular[...]") !== undefined);
});

test("block content in a cell is refused rather than silently relocated", () => {
  const result = build("\\begin{tabular}{l}\\begin{itemize}\\item x\\end{itemize}\\end{tabular}");
  assert.ok(
    result.diagnostics.some((d) => d.code === "syntax" && /cannot appear in a `tabular` cell/.test(d.message)),
  );
});

// --- bibliography -----------------------------------------------------------

test("the \\cite family becomes citation inlines carrying the raw keys", () => {
  const result = build("Text \\cite{a,b} more \\citep{c} more \\citet{d}.\\nocite{*}");
  assert.deepEqual(
    result.citations.map((c) => [c.construct, c.style, c.keys.join("|"), c.text]),
    [
      ["\\cite", "plain", "a|b", "[?]"],
      ["\\citep", "parenthetical", "c", "[?]"],
      ["\\citet", "textual", "d", "[?]"],
      ["\\nocite", "silent", "*", ""],
    ],
  );
  // `\nocite` sets nothing, so it is not in the paragraph — but it is in the
  // list above, so its keys still reach the bibliography.
  const paragraph = result.document.blocks[0] as ParagraphBlock;
  assert.equal(paragraph.content.filter((inline) => inline.kind === "citation").length, 3);
  assert.match(textOf(paragraph.content), /Text \[\?\] more \[\?\] more \[\?\]\./);
});

test("\\citep and \\citet adopt their keys even with no signature in the parser", () => {
  const result = build("\\citep{k} and \\citet{j}");
  assert.deepEqual(result.citations.map((c) => c.keys.join("|")), ["k", "j"]);
  // The keys must not have been typeset as ordinary text.
  assert.doesNotMatch(textOf((result.document.blocks[0] as ParagraphBlock).content), /\bk\b/);
});

test("natbib's optional citation notes are refused rather than set as text", () => {
  const result = build("\\citep[see][p.~2]{k}");
  const hit = find(result, "\\citep[...]");
  assert.ok(hit !== undefined);
  assert.equal(hit.code, "unsupported");
  assert.doesNotMatch(textOf((result.document.blocks[0] as ParagraphBlock).content), /see/);
});

test("a citation with no key is a diagnostic and still reaches the bibliography pass", () => {
  const result = build("\\cite");
  assert.ok(result.diagnostics.some((d) => d.code === "syntax" && /at least one citation key/.test(d.message)));
  assert.ok(result.diagnostics.some((d) => d.code === "unsupported" && d.construct === "\\cite"));
});

test("\\bibliography records its .bib names and the style, wherever the style was written", () => {
  const result = build("\\bibliography{refs,more}\n\\bibliographystyle{plain}");
  const block = result.document.blocks.find((b) => b.kind === "bibliography") as BibliographyBlock;
  assert.equal(block.source, "bibfile");
  assert.equal(block.construct, "\\bibliography");
  assert.deepEqual(block.bibFiles, ["refs", "more"]);
  // Written *after* the \bibliography, and still picked up.
  assert.equal(block.style, "plain");
  assert.deepEqual(block.content, []);
});

test("a style other than the numeric one is `unsupported`, naming it", () => {
  const hit = find(build("\\bibliographystyle{apalike}"), "\\bibliographystyle{apalike}");
  assert.ok(hit !== undefined);
  assert.equal(hit.code, "unsupported");
  assert.match(hit.message, /plain/);
});

test("thebibliography parses its \\bibitem entries, keys and labels", () => {
  const result = build(
    "\\begin{thebibliography}{99}\n\\bibitem{knuth} Knuth, \\emph{The TeXbook}, 1984.\n\\bibitem[GJ79]{gj} Garey and Johnson.\n\\end{thebibliography}",
  );
  const block = result.document.blocks.find((b) => b.kind === "bibliography") as BibliographyBlock;
  assert.equal(block.source, "thebibliography");
  assert.equal(block.widestLabel, "99");
  assert.deepEqual(block.entries.map((e) => e.key), ["knuth", "gj"]);
  assert.equal(textOf((block.entries[0]!.content[0] as ParagraphBlock).content), "Knuth, The TeXbook, 1984.");
  assert.equal(textOf(block.entries[1]!.label ?? []), "GJ79");
});

test("a malformed thebibliography is diagnosed, entry by entry", () => {
  const noWidest = build("\\begin{thebibliography}\n\\bibitem{k} x\n\\end{thebibliography}");
  assert.ok(noWidest.diagnostics.some((d) => /widest-label/.test(d.message)));
  assert.equal(
    (noWidest.document.blocks[0] as BibliographyBlock).widestLabel,
    null,
    "an argument the parser swallowed out of the body is not a label",
  );
  const noItems = build("\\begin{thebibliography}{9}\nloose text\n\\end{thebibliography}");
  assert.ok(noItems.diagnostics.some((d) => /before the first \\bibitem/.test(d.message)));
  assert.ok(noItems.diagnostics.some((d) => /has no \\bibitem/.test(d.message)));
  const noKey = build("\\begin{thebibliography}{9}\n\\bibitem{} x\n\\end{thebibliography}");
  assert.ok(noKey.diagnostics.some((d) => d.construct === "\\bibitem" && /needs a citation key/.test(d.message)));
});

test("\\bibitem outside thebibliography is `unsupported`, and says where it belongs", () => {
  const hit = find(build("\\bibitem{k} x"), "\\bibitem");
  assert.ok(hit !== undefined);
  assert.equal(hit.code, "unsupported");
  assert.match(hit.message, /thebibliography/);
});

// --- the loud-failure contract for every new construct ----------------------

/**
 * One diagnostic per construct, error severity, with the construct named and
 * the line it was written on — for constructs whose *capability* is a seam a
 * later chunk fills in. This is the list that must shrink, one row at a time,
 * as chunks 39.2 to 39.5 land; a row that stops reporting without its
 * capability arriving is the silent-loss regression D38 exists to catch.
 *
 * A row that *does* land keeps its capability's real terminal diagnostic here
 * instead of disappearing outright, as long as that diagnostic is still a
 * one-per-construct, file-and-line-carrying error — `code` names which one,
 * defaulting to `unsupported` for the constructs still waiting on a seam.
 * A row is deleted outright only once its construct, in this exact fixture,
 * produces no diagnostic at all: `\includegraphics{a.png}` and a valid
 * one-cell `tabular` (chunks 39.2 and 39.3) now set for real and are covered
 * by their own suites; `\bibliographystyle{plain}` names the one style this
 * engine implements, so it is no longer even a diagnostic; and a
 * `thebibliography` with one real `\bibitem` is a valid non-empty list that
 * chunk 39.5 formats outright (an *empty* one still reports `unsupported` —
 * see `unsupported.test.ts`'s environment inventory for that shape).
 */
const SEAM_CONSTRUCTS: readonly {
  source: string;
  construct: string;
  line: number;
  code?: string;
  messagePattern?: RegExp;
}[] = [
  // `figure`, `figure*`, `table` and `table*` are deleted rows, by the rule in
  // this table's doc comment: chunk 39.4 places floats, so none of the four
  // produces any diagnostic at all in this fixture. `test/floats.test.ts` is
  // their coverage now.
  // Chunk 39.5 landed: with no `\bibliography` in the fixture, a citation key
  // resolves to nothing, which is `undefined-reference`, not `unsupported`.
  {
    source: "\\cite{k}",
    construct: "\\cite",
    line: 3,
    code: "undefined-reference",
    messagePattern: /no bibliography entry for "k"/,
  },
  {
    source: "\\citep{k}",
    construct: "\\citep",
    line: 3,
    code: "undefined-reference",
    messagePattern: /no bibliography entry for "k"/,
  },
  {
    source: "\\citet{k}",
    construct: "\\citet",
    line: 3,
    code: "undefined-reference",
    messagePattern: /no bibliography entry for "k"/,
  },
  {
    source: "\\nocite{k}",
    construct: "\\nocite",
    line: 3,
    code: "undefined-reference",
    messagePattern: /no bibliography entry for "k"/,
  },
  // The named .bib file does not exist in this fixture's project, which is
  // now `missing-file`, naming the file.
  {
    source: "\\bibliography{refs}",
    construct: "\\bibliography",
    line: 3,
    code: "missing-file",
    messagePattern: /refs/,
  },
  // Chunk 39.4 landed and retired this row's interim notice. A `\caption`
  // outside a float is not a missing capability — it is an authoring error,
  // permanently — so the diagnostic that remains is the plain `syntax` one.
  {
    source: "\\caption{x}",
    construct: "\\caption",
    line: 3,
    code: "syntax",
    messagePattern: /only allowed inside a figure or table/,
  },
];

test("every brief-39 construct reaches a seam that reports it, exactly once", () => {
  for (const { source, construct, line, code, messagePattern } of SEAM_CONSTRUCTS) {
    const result = compileSource(doc(source));
    const wantCode = code ?? "unsupported";
    const hits = result.diagnostics.filter((d) => d.code === wantCode && d.construct === construct);
    assert.equal(
      hits.length,
      1,
      `${construct} reported ${hits.length} times as ${wantCode}: ${JSON.stringify(result.diagnostics)}`,
    );
    assert.equal(hits[0]!.severity, "error", construct);
    assert.equal(hits[0]!.file, "main.tex", construct);
    assert.equal(hits[0]!.line, line, construct);
    assert.match(hits[0]!.message, messagePattern ?? /not implemented yet|not resolved yet/, construct);
    assert.equal(result.pdf, null, `${construct} must not produce a PDF while it sets nothing`);
  }
});

test("brief 39's Out list stays out, and says so", () => {
  for (const name of ["wrapfigure", "tabularx", "longtable"]) {
    const result = compileSource(doc(`\\begin{${name}}{l}\nx\n\\end{${name}}`));
    const hit = result.diagnostics.find((d) => d.code === "unsupported" && d.construct === name);
    assert.ok(hit !== undefined, `${name} did not report unsupported`);
    assert.equal(hit.severity, "error");
  }
});

test("a paper-shaped document compiles to diagnostics rather than a crash", () => {
  const source = `\\documentclass{article}
\\begin{document}
\\tableofcontents
\\listoffigures
\\listoftables
\\section{Results}
\\begin{figure}[htbp]
\\includegraphics[width=0.8\\textwidth]{plot.png}
\\caption{A plot of something}
\\label{fig:plot}
\\end{figure}
As Figure~\\ref{fig:plot} shows, the numbers in Table~\\ref{tab:n} agree with \\cite{knuth}.
\\begin{table}[t]
\\begin{tabular}{|l|r|}
\\hline
Name & Value \\\\
\\hline
alpha & 1 \\\\
beta & 22 \\\\
\\hline
\\end{tabular}
\\caption{Numbers}
\\label{tab:n}
\\end{table}
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
  const result = compileSource(source, {
    "refs.bib": encoder.encode("@misc{knuth,title={The TeXbook}}"),
    "plot.png": encoder.encode("not really a png"),
  });
  assert.ok(result.pages.length >= 1, "the prose is still laid out beside the errors");
  for (const d of result.diagnostics) {
    assert.equal(d.file, "main.tex");
    assert.ok(d.line > 0, `${d.message} has no line`);
    assert.ok(typeof d.construct === "string" && d.construct.length > 0, `${d.message} names no construct`);
  }
  // Both cross-references resolved to their captions' numbers.
  const text = result.pages
    .flatMap((page) => page.items)
    .filter((item) => item.kind === "glyphrun")
    .map((item) => (item.kind === "glyphrun" ? item.text : ""))
    .join(" ");
  assert.match(text, /Figure/);
  assert.equal(result.diagnostics.some((d) => d.code === "internal"), false);
});

test("malformed brief-39 source never throws, whatever shape it is", () => {
  const nasty = [
    "\\begin{figure}",
    "\\begin{tabular}{|}&&\\\\\\hline\\cline{}\\multicolumn{}{}{}",
    "\\includegraphics[width=]{}",
    "\\caption",
    "\\cite{}",
    "\\bibliography{}",
    "\\begin{thebibliography}",
    "\\bibitem",
    // (A `figure` with two `\caption`s used to sit here. It is not malformed —
    // it is two numbered captions in one float, which chunk 39.4 sets and
    // numbers without complaint, so it has no place in a list of sources that
    // must each produce a diagnostic. `test/floats.test.ts` covers it.)
  ];
  for (const source of nasty) {
    const result = compileSource(doc(source));
    assert.ok(result.diagnostics.length > 0, `${source} produced no diagnostic at all`);
    assert.equal(
      result.diagnostics.some((d) => d.code === "internal"),
      false,
      `${source} produced an internal error: ${JSON.stringify(result.diagnostics)}`,
    );
  }
});
