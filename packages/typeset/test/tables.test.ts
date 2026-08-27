import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompileResult, GlyphRun, Page, PlacedItem } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import { defaultDesign } from "../src/layout/design.ts";
import { ARRAY_RULE_WIDTH, TAB_COL_SEP } from "../src/layout/table.ts";
import { dumpResult } from "./harness.ts";

/**
 * Chunk 39.3: column measurement and grid setting for `tabular`.
 *
 * These tests go through the real `compile()` pipeline — the same seam
 * `layout/vlist.ts`'s `layoutTable` calls in production — rather than hand-
 * building a `TableContext`, so what is exercised here is exactly what a
 * document author gets. `NOTICE-39.3` (`doc/build.ts`) is reserved to the
 * controller and still fires alongside the real output on every one of these
 * documents (see that file's own comment); it is a document-layer diagnostic
 * that has nothing to do with whether the table below it was actually set, so
 * none of these tests assert on the *count* of diagnostics, only on the
 * specific ones each test is about.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const design = defaultDesign();

function project(body: string): { files: Record<string, Uint8Array>; entrypoint: string } {
  const encoder = new TextEncoder();
  return {
    files: { "main.tex": encoder.encode(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`) },
    entrypoint: "main.tex",
  };
}

function run(body: string, opts: Parameters<typeof compile>[2] = {}): CompileResult {
  const { files, entrypoint } = project(body);
  return compile(files, entrypoint, { fonts, ...opts });
}

/**
 * `\ps@plain`'s page-number folio also renders as a `glyphrun`, well below the
 * text body (`design.marginTop + design.textHeight`) — excluded here so a
 * test asserting on "every glyph on the page" never trips on the digit at the
 * foot of it.
 */
function glyphRuns(page: Page): GlyphRun[] {
  return page.items.filter(
    (i): i is GlyphRun => i.kind === "glyphrun" && i.y <= design.marginTop + design.textHeight,
  );
}

function rules(page: Page): Extract<PlacedItem, { kind: "rule" }>[] {
  return page.items.filter((i): i is Extract<PlacedItem, { kind: "rule" }> => i.kind === "rule");
}

/** Round to the golden dump's own precision, so float noise never trips an assertion. */
function r(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// --- column types ------------------------------------------------------------

test("l, c and r columns align their content against a wider row in the same column", () => {
  const result = run(
    "\\begin{tabular}{lcr}\nx & x & x \\\\\nwideword & wideword & wideword\n\\end{tabular}",
  );
  const page = result.pages[0] as Page;
  const runs = glyphRuns(page);
  const short = runs.filter((g) => g.text === "x").sort((a, b) => a.x - b.x);
  const wide = runs.filter((g) => g.text === "wideword").sort((a, b) => a.x - b.x);
  assert.equal(short.length, 3, "three short cells");
  assert.equal(wide.length, 3, "three wide cells");

  // Left column: both rows start at the same x (flush left).
  assert.equal(r(short[0]!.x), r(wide[0]!.x));
  // Right column: both rows end at the same x (flush right).
  assert.equal(r(short[2]!.x + short[2]!.width), r(wide[2]!.x + wide[2]!.width));
  // Centre column: both rows share the same midpoint.
  assert.equal(r(short[1]!.x + short[1]!.width / 2), r(wide[1]!.x + wide[1]!.width / 2));
  // The wide row is what set the column, so it — but not the short row —
  // touches both edges of the column's slot in the left and right columns.
  assert.ok(short[0]!.x > wide[0]!.x - 0.001, "the short cell is not to the left of the column it shares");
});

test("a p{width} column wraps its content across more than one line", () => {
  const result = run(
    "\\begin{tabular}{p{3cm}}\nThis paragraph column cell has enough words in it that it must wrap onto more than a single line at this width.\n\\end{tabular}",
  );
  const page = result.pages[0] as Page;
  const runs = glyphRuns(page);
  const ys = new Set(runs.map((g) => r(g.y)));
  assert.ok(ys.size > 1, `expected more than one line, got y-coordinates: ${[...ys].join(", ")}`);
  // `p{}` is ragged-right: every line starts flush against the same left edge.
  const firstOfEachLine = new Map<number, number>();
  for (const g of runs) {
    const y = r(g.y);
    if (!firstOfEachLine.has(y) || g.x < firstOfEachLine.get(y)!) firstOfEachLine.set(y, g.x);
  }
  const lefts = new Set([...firstOfEachLine.values()].map(r));
  assert.equal(lefts.size, 1, `every line should start at the same x, got: ${[...lefts].join(", ")}`);
});

// --- rules --------------------------------------------------------------------

test("| rules and \\hline draw as rule items, sized from the kernel's own tabcolsep/arrayrulewidth", () => {
  const result = run("\\begin{tabular}{|l|r|}\n\\hline\na & b \\\\\n\\hline\n\\end{tabular}");
  const page = result.pages[0] as Page;
  const rs = rules(page);
  // Two \hline (top and bottom) plus three verticals for the one row
  // (left border, the rule between the two columns, the right border).
  assert.equal(rs.length, 5, `expected 5 rules, got ${JSON.stringify(rs)}`);

  const verticals = rs.filter((rule) => r(rule.width) === r(ARRAY_RULE_WIDTH));
  const horizontals = rs.filter((rule) => r(rule.width) !== r(ARRAY_RULE_WIDTH));
  assert.equal(verticals.length, 3, "left border, the interior rule, and the right border");
  assert.equal(horizontals.length, 2, "\\hline above and below");
  assert.equal(r(horizontals[0]!.width), r(horizontals[1]!.width), "both \\hlines span the same full width");

  // The row's own cell content sits strictly between the left border and the
  // interior rule, and again between the interior rule and the right border.
  const runs = glyphRuns(page).sort((a, b) => a.x - b.x);
  const a = runs.find((g) => g.text === "a")!;
  const b = runs.find((g) => g.text === "b")!;
  const sortedVerticals = verticals.sort((x, y) => x.x - y.x);
  assert.ok(sortedVerticals[0]!.x <= a.x, "left border sits left of \"a\"");
  assert.ok(a.x < sortedVerticals[1]!.x, "\"a\" sits left of the interior rule");
  assert.ok(sortedVerticals[1]!.x < b.x, "interior rule sits left of \"b\"");
  assert.ok(b.x + b.width <= sortedVerticals[2]!.x + 0.01, "\"b\" sits left of the right border");
});

test("\\cline draws only under the columns it names, not across the table's own borders", () => {
  const result = run(
    "\\begin{tabular}{|l|l|l|}\na & b & c \\\\\n\\cline{2-2}\nd & e & f\n\\end{tabular}",
  );
  const page = result.pages[0] as Page;
  const rs = rules(page);
  // 4 verticals per row (left border, two interior rules, right border) for
  // each of the 2 rows, plus the one \cline.
  const verticals = rs.filter((rule) => r(rule.width) === r(ARRAY_RULE_WIDTH));
  const horizontals = rs.filter((rule) => r(rule.width) !== r(ARRAY_RULE_WIDTH));
  assert.equal(verticals.length, 8, `expected 8 verticals, got ${JSON.stringify(rs)}`);
  assert.equal(horizontals.length, 1);

  const cline = horizontals[0]!;
  // One column's content width plus two lots of \tabcolsep, and nothing more
  // (no rule thickness folded in, because \cline starts after column 2's own
  // left border and ends before column 3's).
  const runs = glyphRuns(page);
  const bWidth = runs.find((g) => g.text === "b")!.width;
  const eWidth = runs.find((g) => g.text === "e")!.width;
  const columnContentWidth = Math.max(bWidth, eWidth);
  assert.equal(r(cline.width), r(TAB_COL_SEP * 2 + columnContentWidth));
  // It starts inside the table, after column 1's own border and content —
  // never at the table's own left edge.
  assert.ok(cline.x > design.marginLeft + ARRAY_RULE_WIDTH, "the \\cline does not start at the table's own left edge");
});

// --- \multicolumn --------------------------------------------------------------

test("\\multicolumn's width is its covered columns plus the rule between them, not just their sum", () => {
  // Two unmeasured `l` columns (nothing else in the table gives them a natural
  // width) sit at exactly `2*tabcolsep` each, with one `\arrayrulewidth` rule
  // between them (from the outer `|l|l|` spec) — both known constants, which is
  // what makes this table's exact geometry predictable by hand.
  const result = run("\\begin{tabular}{|l|l|}\n\\multicolumn{2}{c}{X}\n\\end{tabular}");
  const page = result.pages[0] as Page;
  const rs = rules(page);
  // The multicolumn's own spec (`c`, no `|`) has no left or right rule of its
  // own, and it covers both declared columns, so the only rule left standing
  // is the table's own trailing border.
  assert.equal(rs.length, 1, `expected exactly the trailing rule, got ${JSON.stringify(rs)}`);

  const slotWidth = 2 * (TAB_COL_SEP * 2 + 0) + ARRAY_RULE_WIDTH;
  const expectedX = design.marginLeft + slotWidth;
  assert.equal(r(rs[0]!.x), r(expectedX));
});

test("TableCell.override wins over the column spec for a cell's alignment, even without spanning", () => {
  // A single `l` column: `\multicolumn{1}{r}{...}` spans nothing (span 1), but
  // its own one-column spec (`r`) must still win over the column's own `l`.
  // The same text ("ab") appears once under each alignment, in a column wide
  // enough (set by the third row) that left- and right-aligned land far apart.
  const result = run(
    "\\begin{tabular}{l}\n\\multicolumn{1}{r}{ab} \\\\\nab \\\\\nlong-cell-content-one\n\\end{tabular}",
  );
  const page = result.pages[0] as Page;
  const runs = glyphRuns(page)
    .filter((g) => g.text === "ab")
    .sort((a, b) => a.y - b.y);
  assert.equal(runs.length, 2, "one overridden \"ab\" and one plain \"ab\"");
  const [overridden, plain] = runs as [GlyphRun, GlyphRun];
  assert.ok(overridden.x > plain.x + 10, "the \\multicolumn{1}{r}{...} cell is right-aligned, not left like its column");
});

// --- overfull ------------------------------------------------------------------

test("a table wider than the measure is an overfull-box warning and is still set", () => {
  const result = run("\\begin{tabular}{p{10in}}\nstill set\n\\end{tabular}");
  const overfull = result.diagnostics.find((d) => d.code === "overfull-box" && d.construct === "tabular");
  assert.ok(overfull !== undefined, `no overfull-box diagnostic: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(overfull!.severity, "warning");
  const page = result.pages[0] as Page;
  assert.ok(
    glyphRuns(page).some((g) => g.text === "still"),
    "the table's content is still set despite being overfull",
  );
});

test("an overfull table is set at its natural width, not squeezed to the measure", () => {
  // A ragged-right `p{}` cell's own first glyph sits at the same small offset
  // no matter how wide the column is, so the column's *width* has to be read
  // from where the table's own trailing rule lands, not from the glyph.
  const result = run("\\begin{tabular}{|p{10in}|}\nx\n\\end{tabular}");
  const page = result.pages[0] as Page;
  const rightBorder = rules(page).reduce((a, b) => (a.x > b.x ? a : b));
  // 10in (720pt) of content plus tabcolsep and rule thickness on both sides —
  // far past the ~468pt measure a default US-letter body actually offers.
  assert.ok(
    rightBorder.x - design.marginLeft > design.textWidth,
    "the table's right border was not shrunk to fit the measure",
  );
});

// --- determinism -----------------------------------------------------------

test("the same tabular document lays out identically on repeated compiles", () => {
  const source =
    "\\begin{tabular}{|l|c|p{3cm}|}\n\\hline\nName & Count & Notes \\\\\n\\hline\nalpha & 1 & a short note \\\\\nbeta & 22 & \\multicolumn{1}{c|}{a rather longer note that wraps across more than one line} \\\\\n\\hline\n\\end{tabular}";
  const a = run(source);
  const b = run(source);
  assert.equal(dumpResult(a, "main.tex"), dumpResult(b, "main.tex"));
});

// --- the step budget ---------------------------------------------------------

test("a table with many rows never throws and is stopped by the step budget, not a crash", () => {
  const rows = Array.from({ length: 400 }, (_, i) => `r${i}a & r${i}b & r${i}c`).join(" \\\\\n");
  const source = `\\begin{tabular}{lll}\n${rows}\n\\end{tabular}`;
  assert.doesNotThrow(() => run(source, { stepBudget: 400 }));
  const result = run(source, { stepBudget: 400 });
  assert.equal(
    result.diagnostics.some((d) => d.code === "internal"),
    false,
    "no internal error, however tight the budget",
  );
});

test("a malformed tabular (zero declared columns) never throws and sets nothing", () => {
  assert.doesNotThrow(() => run("\\begin{tabular}{|}&&\\\\\\hline\\cline{}\\multicolumn{}{}{}"));
  const result = run("\\begin{tabular}{|}&&\\\\\\hline\\cline{}\\multicolumn{}{}{}");
  assert.equal(
    result.diagnostics.some((d) => d.code === "internal"),
    false,
  );
});
