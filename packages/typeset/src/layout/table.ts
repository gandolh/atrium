import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { warning } from "../diagnostics.ts";
import type {
  DocumentLength,
  Inline,
  TableBlock,
  TableColumnAlign,
  TableRow,
  TableRule,
} from "../doc/model.ts";
import type { Budget } from "../macro/budget.ts";
import { spend } from "../macro/budget.ts";
import type { FontSize, LengthContext, PageDesign } from "./design.ts";
import { resolveDocumentLength } from "./design.ts";
import { hpack, measure } from "./glue.ts";
import type { Shaper } from "./hlist.ts";
import type { HBox, HList, HNode, RuleNode, VBox, VNode } from "./model.ts";
import { glue, kern } from "./model.ts";

/**
 * **Chunk 39.3.** Column measurement and grid setting for `tabular`.
 *
 * Chunk 39.1 parses a `tabular` all the way into a `TableBlock`: the cell grid
 * from `&` and `\\`, the column specification (`l c r`, `p{width}`, `|` rules),
 * `\hline`, `\cline` and `\multicolumn`. This file does the two passes brief 39
 * asks for: measure every column's width from its content, then set the rows
 * to it.
 *
 * **The numbers.** `\tabcolsep` (6pt), `\arrayrulewidth` (0.4pt) and
 * `\doublerulesep` (2pt) are `latex.ltx`'s own defaults for the kernel
 * `tabular` — not the `array` package's; `tabular` and its rule-drawing are
 * built into the kernel itself, and these three registers are set there.
 * `design.ts` cites `article.cls`/`size10.clo` numbers the same way; these
 * three are cited from the kernel file that actually sets them. There is no
 * per-row vertical padding beyond ordinary interline glue and no
 * `\arraystretch` (out of scope) — a kernel `tabular` genuinely looks this
 * tight without `booktabs`, which is exactly why `booktabs` exists.
 *
 * **How a column's width is decided.** A `p{width}` column's width is
 * whatever `resolveDocumentLength` says and is never touched by content. An
 * `l`/`c`/`r` column's width is the widest natural (unbroken) width among the
 * *plain* cells that sit in it. A `\multicolumn` cell — regardless of its own
 * span — never contributes to a column's width, matching real TeX's `\halign`:
 * a `\multispan` entry (what `\multicolumn` compiles to) is excluded from the
 * column-width computation entirely, so its own content may overflow its slot
 * without ever growing the grid. This is also why measurement is one pass and
 * setting is a second: a multicolumn cell's own slot cannot be known until
 * every plain cell has had its say.
 *
 * **Rules are independent, not paired.** Every rule position — before a
 * column, after the table, before or after a `\multicolumn` cell — is decided
 * solely by what sits at that exact position (the column's own `rulesBefore`,
 * the spec's `rulesAfter`, or the cell's own override), never by suppressing a
 * neighbour. Two adjacent bars can and sometimes do draw a visibly doubled
 * rule this way — e.g. a `\multicolumn{1}{c|}{x}` immediately followed by a
 * plain cell whose column also opens with `|` — which is a genuine,
 * often-reported quirk of real LaTeX and not a bug introduced here;
 * special-casing it away would make this file's rule-placement
 * context-dependent for no documented benefit.
 *
 * **Budget.** `ctx.budget` is spent once per cell in the measurement pass and
 * once per cell in the setting pass, *in addition to* whatever `setInlines`
 * and `breakCell` spend internally for the inlines and lines inside it — a
 * table of only empty `\multicolumn` cells would otherwise cost nothing to
 * measure and could not be stopped by the budget at all.
 *
 * **Determinism.** Nothing here mutates `table`, `Math.random`s, or reads
 * anything but `ctx` and the block — the same two are laid out into the same
 * `VBox` bit-for-bit, which is what lets `compile()`'s up-to-three-pass cycle
 * call this on the same table more than once.
 */

/** What `setTable` needs beyond the block. */
export interface TableContext extends LengthContext {
  design: PageDesign;
  /** The measure a table may occupy: `\linewidth` where the table sits. */
  measure: number;
  /** The type size in force, which is also what `em` in a `p{2em}` column means. */
  bodySize: FontSize;
  shaper: Shaper;
  /** Spend steps for every cell measured and every line broken; stop when it says stop. */
  budget: Budget;
  /** Where diagnostics go. Appended to, never replaced. */
  diagnostics: Diagnostic[];
  /** The entrypoint, for a diagnostic with no better position than the document. */
  file: string;
  /**
   * Set a cell's inlines as one unbroken horizontal list — the measurement
   * pass. Supplied by `layout/vlist.ts`; it resolves faces, reports a missing
   * one once, and applies TeX's sentence spacing, none of which this file
   * should re-implement. Measure the result with `measure(hlist, "h")` from
   * `layout/glue.ts`.
   */
  setInlines(inlines: readonly Inline[], size: number, at: SourceRef): HList;
  /**
   * Break a cell's horizontal list to `width` — the `p{}` column's internal
   * line breaking, which is the reuse of the M1 breaker that makes `p{}`
   * tractable. Returns the set lines, in order; diagnostics (overfull boxes)
   * have already been reported.
   */
  breakCell(hlist: HList, width: number, at: SourceRef): HBox[];
}

/** `\tabcolsep` — `latex.ltx`: `\tabcolsep=6pt`. Half of it pads each side of a column. */
export const TAB_COL_SEP = 6;
/** `\arrayrulewidth` — `latex.ltx`: `\arrayrulewidth=.4pt`. Every rule this file draws. */
export const ARRAY_RULE_WIDTH = 0.4;
/** `\doublerulesep` — `latex.ltx`: `\doublerulesep=2pt`. Gap between stacked `||` rules. */
export const DOUBLE_RULE_SEP = 2;

/** A length of zero, for a `DocumentLength` that turned out not to resolve to one. */
const ZERO_LENGTH: DocumentLength = { kind: "points", value: 0 };

/** `k` rules stacked together — `k=0` is nothing, `k=1` is one line, `k=2` is `\doublerulesep` apart. */
function ruleGroupWidth(count: number): number {
  return count <= 0 ? 0 : count * ARRAY_RULE_WIDTH + (count - 1) * DOUBLE_RULE_SEP;
}

function makeRule(width: number, height: number, depth: number): RuleNode {
  return { kind: "rule", width, height, depth };
}

/** One column's resolved geometry — the output of the measurement pass, shared by every row. */
interface ColumnLayout {
  align: TableColumnAlign;
  /** Content width in points, *not* counting `\tabcolsep`'s padding on either side. */
  contentWidth: number;
  /** Total thickness of the `|` rule(s) drawn immediately before this column. */
  leftRuleWidth: number;
}

/**
 * The measurement pass: one `ColumnLayout` per declared column.
 *
 * A `p{}` column's width is resolved once, up front, from its declared length
 * and never touched again. An `l`/`c`/`r` column starts at zero and grows to
 * the widest natural width among the plain cells that land in it — see this
 * file's header for why a `\multicolumn` cell is skipped entirely here.
 */
function measureColumns(table: TableBlock, ctx: TableContext): ColumnLayout[] {
  const layout: ColumnLayout[] = table.spec.columns.map((col) => ({
    align: col.align,
    contentWidth: col.align === "paragraph" ? resolveDocumentLength(col.width ?? ZERO_LENGTH, ctx) : 0,
    leftRuleWidth: ruleGroupWidth(col.rulesBefore),
  }));

  outer: for (const row of table.rows) {
    let col = 0;
    for (const cell of row.cells) {
      // A row with more cells than columns is already a `doc/build.ts`
      // diagnostic; the extra cells are simply not measured or drawn.
      if (col >= layout.length) continue outer;
      if (!spend(ctx.budget)) break outer;
      const span = Math.max(1, Math.min(cell.span, layout.length - col));
      if (cell.override === null) {
        const entry = layout[col]!;
        if (entry.align !== "paragraph") {
          const hlist = ctx.setInlines(cell.content, ctx.bodySize.size, cell.loc);
          const width = measure(hlist, "h").natural;
          if (width > entry.contentWidth) entry.contentWidth = width;
        }
      }
      col += span;
    }
  }
  return layout;
}

/** The table's own natural width: every column's slot plus every rule, including the trailing one. */
function tableWidth(table: TableBlock, layout: readonly ColumnLayout[]): number {
  let total = ruleGroupWidth(table.spec.rulesAfter);
  for (const col of layout) total += col.leftRuleWidth + TAB_COL_SEP * 2 + col.contentWidth;
  return total;
}

/**
 * TeX's `\vpack`: stack vertical material into one `VBox`. `glue.ts` has no
 * equivalent — nothing before this chunk built a `VBox` at all — so this is
 * the one this file's doc comment (and `layout/float.ts`'s, for chunk 39.4)
 * both point at.
 *
 * The reference point follows TeX's own rule: it coincides with the last box
 * or rule in the content, so `depth` is that item's depth and `height` is
 * everything above it. `minWidth` exists only so a `p{}` cell's wrapper (which
 * knows its declared width even when `breakCell` handed back zero lines) never
 * reports a narrower box than the column it sits in.
 */
function vpack(content: VNode[], minWidth = 0): VBox {
  const extent = measure(content, "v");
  let width = minWidth;
  let depth = 0;
  for (const node of content) {
    switch (node.kind) {
      case "hbox":
      case "vbox":
      case "rule":
        if (node.width > width) width = node.width;
        depth = node.depth;
        break;
      default:
        break;
    }
  }
  return { kind: "vbox", width, height: extent.natural - depth, depth, shift: 0, glueSet: null, content };
}

/** A `p{}` column's broken lines, stacked with the same interline glue a paragraph gets. */
function stackLines(lines: readonly HBox[], baselineSkip: number, design: PageDesign): VBox {
  const content: VNode[] = [];
  let prevDepth: number | null = null;
  for (const line of lines) {
    if (prevDepth !== null) {
      const gap = baselineSkip - prevDepth - line.height;
      content.push(glue(gap < design.lineSkipLimit ? design.lineSkip : gap));
    }
    content.push(line);
    prevDepth = line.depth;
  }
  return vpack(content);
}

/** An `l`/`c`/`r` cell: its content, unbroken, padded to `contentWidth` and aligned within it. */
function buildPlainCell(
  content: readonly Inline[],
  align: TableColumnAlign,
  contentWidth: number,
  at: SourceRef,
  ctx: TableContext,
): HBox {
  const hlist = ctx.setInlines(content, ctx.bodySize.size, at);
  const inner = hpack(hlist, "natural").box;
  // Never negative: a cell wider than its column is `buildRow`'s problem (a
  // `\multicolumn` may legitimately overflow its slot), not this function's —
  // clamping here just stops the padding kerns from going negative.
  const slack = Math.max(0, contentWidth - inner.width);
  let padLeft = TAB_COL_SEP;
  let padRight = TAB_COL_SEP;
  if (align === "right") {
    padLeft += slack;
  } else if (align === "center") {
    padLeft += slack / 2;
    padRight += slack - slack / 2;
  } else {
    // "left". `align` is never "paragraph" here — `buildRow` routes those to
    // `buildParagraphCell` instead.
    padRight += slack;
  }
  return hpack([kern(padLeft), inner, kern(padRight)], "natural").box;
}

/** A `p{width}` cell: its content, line-broken to `width` via `ctx.breakCell`, then padded. */
function buildParagraphCell(content: readonly Inline[], width: number, at: SourceRef, ctx: TableContext): HBox {
  const hlist = ctx.setInlines(content, ctx.bodySize.size, at);
  const lines = ctx.breakCell(hlist, width, at);
  const stacked = stackLines(lines, ctx.bodySize.baselineSkip, ctx.design);
  return hpack([kern(TAB_COL_SEP), stacked, kern(TAB_COL_SEP)], "natural").box;
}

/** One cell, boxed and ready to sit in its row's `HBox`. */
interface CellPlacement {
  /** The rule drawn immediately before this cell — the column's, or a `\multicolumn`'s own. */
  leftRuleWidth: number;
  box: HBox;
  /** A `\multicolumn`'s own trailing rule, drawn right after its box. `null` for a plain cell. */
  rightOverrideWidth: number | null;
}

/**
 * One row, set: every cell boxed to its slot and every rule between them, in
 * one `HBox`.
 *
 * `TableCell.override` — a `\multicolumn`'s own one-column spec — wins over
 * `spec.columns[i]` for everything about the cell: alignment, width and the
 * rules at both of its edges. A spanning cell's width is the columns it covers
 * *plus* the rules that would otherwise have separated them (brief 39's own
 * words for it) — those interior rules are not drawn, but the space they would
 * have taken is still there, which is exactly what real `\halign` does for a
 * `\multispan`.
 */
function buildRow(table: TableBlock, row: TableRow, layout: readonly ColumnLayout[], ctx: TableContext): HBox {
  const placements: CellPlacement[] = [];
  let col = 0;

  for (const cell of row.cells) {
    // More cells than columns: already a `doc/build.ts` diagnostic. The extra
    // cells are dropped rather than drawn past the grid's edge.
    if (col >= layout.length) break;
    if (!spend(ctx.budget)) break;
    const span = Math.max(1, Math.min(cell.span, layout.length - col));

    let slotWidth = 0;
    for (let k = col; k < col + span; k++) {
      const c = layout[k]!;
      slotWidth += TAB_COL_SEP * 2 + c.contentWidth;
      if (k > col) slotWidth += c.leftRuleWidth;
    }

    const override = cell.override;
    const align: TableColumnAlign = override !== null ? override.align : layout[col]!.align;
    const leftRuleWidth = override !== null ? ruleGroupWidth(override.rulesBefore) : layout[col]!.leftRuleWidth;
    const rightOverrideWidth = override !== null ? ruleGroupWidth(cell.overrideRulesAfter) : null;

    const box =
      align === "paragraph"
        ? buildParagraphCell(
            cell.content,
            // A `\multicolumn{n}{p{w}}{...}` breaks to its own declared `w`,
            // independent of the span — the author is responsible for that
            // being sensible. A plain `p{}` column uses the width the
            // measurement pass already resolved.
            override !== null ? resolveDocumentLength(override.width ?? ZERO_LENGTH, ctx) : layout[col]!.contentWidth,
            cell.loc,
            ctx,
          )
        : buildPlainCell(cell.content, align, slotWidth - TAB_COL_SEP * 2, cell.loc, ctx);

    placements.push({ leftRuleWidth, box, rightOverrideWidth });
    col += span;
  }

  let rowHeight = 0;
  let rowDepth = 0;
  for (const p of placements) {
    if (p.box.height > rowHeight) rowHeight = p.box.height;
    if (p.box.depth > rowDepth) rowDepth = p.box.depth;
  }

  const content: HNode[] = [];
  for (const p of placements) {
    if (p.leftRuleWidth > 0) content.push(makeRule(p.leftRuleWidth, rowHeight, rowDepth));
    content.push(p.box);
    if (p.rightOverrideWidth !== null && p.rightOverrideWidth > 0) {
      content.push(makeRule(p.rightOverrideWidth, rowHeight, rowDepth));
    }
  }
  const trailing = ruleGroupWidth(table.spec.rulesAfter);
  if (trailing > 0) content.push(makeRule(trailing, rowHeight, rowDepth));

  return hpack(content, "natural").box;
}

/**
 * One `\hline` or `\cline{from-to}`, as a full-width `HBox` (a leading `kern`
 * positions a `\cline` that does not start at the table's own left edge).
 *
 * An `\hline` (`from`/`to` both null) spans the whole grid *including* the
 * table's own `|` rules; a `\cline` spans only the content of the columns it
 * names, starting after that first column's own left border and ending before
 * the rule that would follow the last one — it never draws across the table's
 * own rules, which is the one thing that distinguishes it from a full `\hline`
 * restricted to the same range.
 */
function buildRuleRow(table: TableBlock, rule: TableRule, layout: readonly ColumnLayout[]): HBox {
  if (rule.from === null || rule.to === null) {
    let width = ruleGroupWidth(table.spec.rulesAfter);
    for (const col of layout) width += col.leftRuleWidth + TAB_COL_SEP * 2 + col.contentWidth;
    return hpack([makeRule(width, ARRAY_RULE_WIDTH, 0)], "natural").box;
  }

  // `doc/build.ts` only ever hands out an in-range `\cline`, but clamp anyway:
  // this file never trusts another module's invariant past the point where
  // trusting it wrong would mean an out-of-bounds array read.
  const from = Math.max(1, Math.min(rule.from, layout.length));
  const to = Math.max(from, Math.min(rule.to, layout.length));

  let offset = 0;
  for (let k = 0; k < from - 1; k++) {
    const col = layout[k]!;
    offset += col.leftRuleWidth + TAB_COL_SEP * 2 + col.contentWidth;
  }
  offset += layout[from - 1]!.leftRuleWidth;

  let width = 0;
  for (let k = from - 1; k < to; k++) {
    const col = layout[k]!;
    width += TAB_COL_SEP * 2 + col.contentWidth;
    if (k > from - 1) width += col.leftRuleWidth;
  }

  const content: HNode[] =
    offset > 0 ? [kern(offset), makeRule(width, ARRAY_RULE_WIDTH, 0)] : [makeRule(width, ARRAY_RULE_WIDTH, 0)];
  return hpack(content, "natural").box;
}

/**
 * **THE SEAM.** One `tabular`, set: a `VBox` whose content is the rows and
 * rules, or `null` when it could not be set at all (no columns were declared —
 * `doc/build.ts` has already reported that).
 *
 * A `VBox` because a table is a column of rows and the vertical list appends
 * it exactly as it appends a paragraph's line — `layout/vlist.ts`'s `pushBox`
 * takes either box kind, so nothing else has to change.
 *
 * An overfull table (its measured columns exceed `ctx.measure`) is a warning,
 * not a refusal: it is still set, at its natural width, so the author sees
 * what overflowed rather than losing the table entirely.
 */
export function setTable(table: TableBlock, ctx: TableContext): VBox | null {
  if (table.spec.columns.length === 0) return null;

  const layout = measureColumns(table, ctx);
  const totalWidth = tableWidth(table, layout);
  if (totalWidth > ctx.measure) {
    ctx.diagnostics.push(
      warning(
        "overfull-box",
        table.loc,
        `this \`${table.construct}\` is ${(totalWidth - ctx.measure).toFixed(2)}pt wider than the ` +
          `${ctx.measure.toFixed(2)}pt available; it is set at its natural width anyway rather than squeezed to fit`,
        table.construct,
      ),
    );
  }

  const content: VNode[] = [];
  let prevDepth: number | null = null;

  const pushRule = (box: HBox): void => {
    content.push(box);
    // A rule touches whatever comes next: real `\hline`/`\cline` add no vskip
    // of their own, which is why a kernel `tabular` looks tight without
    // `booktabs`. `null` is `pushBox`'s own `ignore_depth` convention (see
    // `vlist.ts`) — reused here for exactly the same reason.
    prevDepth = null;
  };
  const pushRow = (box: HBox): void => {
    if (prevDepth !== null) {
      const gap = ctx.bodySize.baselineSkip - prevDepth - box.height;
      content.push(glue(gap < ctx.design.lineSkipLimit ? ctx.design.lineSkip : gap));
    }
    content.push(box);
    prevDepth = box.depth;
  };

  for (const row of table.rows) {
    if (ctx.budget.stopped) break;
    for (const rule of row.rulesAbove) pushRule(buildRuleRow(table, rule, layout));
    pushRow(buildRow(table, row, layout, ctx));
  }
  if (!ctx.budget.stopped) {
    for (const rule of table.rulesBelow) pushRule(buildRuleRow(table, rule, layout));
  }

  return vpack(content, totalWidth);
}
