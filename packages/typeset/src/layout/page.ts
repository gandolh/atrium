import type { Diagnostic } from "@ebook-reader/shared";
import type { FontHandle, FontProvider, PositionedGlyph } from "../font/handle.ts";
import { error, wholeFile } from "../diagnostics.ts";
import type { Budget } from "../macro/budget.ts";
import { spend } from "../macro/budget.ts";
import type { PageDesign } from "./design.ts";
import type { Extent } from "./glue.ts";
import { AWFUL_BAD, INF_BAD, addNodeExtent, computeGlueSet, hpack, setWidth, zeroExtent } from "./glue.ts";
import type { Shaper } from "./hlist.ts";
import { shapeRun } from "./hlist.ts";
import type { GlueSet, HBox, HNode, VList, VNode } from "./model.ts";
import { EJECT_PENALTY, INFINITE_PENALTY } from "./model.ts";
import type { PreparedFootnote } from "./vlist.ts";

/**
 * Positioned output: the last thing layout produces and the only thing PDF
 * emission reads. A `Page` is flat on purpose — the box tree's nesting has
 * already been resolved into absolute coordinates, so emission is a loop, and
 * a golden dump is a readable transcript of it.
 *
 * **Coordinates are y-down from the page's top-left corner, in points.** That
 * is the opposite of PDF's y-up-from-bottom-left; emission converts with
 * `pdfY = page.height - y` at the single point where it writes bytes. Y-down is
 * chosen here because layout builds a page from the top down and because a
 * golden dump then reads in the order a human reads the page — which is the
 * dump format's whole job.
 */

/** A run of glyphs placed on a page. This is what PDF emission writes. */
export interface GlyphRun {
  readonly kind: "glyphrun";
  /** Left edge of the run. */
  x: number;
  /** The run's **baseline**, not its top. */
  y: number;
  font: FontHandle;
  /** Type size in points. */
  size: number;
  glyphs: PositionedGlyph[];
  /** Sum of the glyph advances — where the next run would start. */
  width: number;
  /** The source characters, for `/ToUnicode` and for golden dumps. */
  text: string;
}

/** A filled rectangle placed on a page. `y` is its **top** edge. */
export interface PlacedRule {
  readonly kind: "rule";
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PlacedItem = GlyphRun | PlacedRule;

export interface Page {
  /** 1-based, in document order. */
  number: number;
  /** Media box, in points. `\documentclass` and `geometry` decide these. */
  width: number;
  height: number;
  /** In paint order: earlier items are drawn first. */
  items: PlacedItem[];
}

// ---------------------------------------------------------------------------
// The page builder
// ---------------------------------------------------------------------------

/**
 * Cutting the document's vertical list into pages, and turning each cut into
 * absolute coordinates.
 *
 * The break itself is TeX's page builder (tex.web §1005–§1017) rather than a
 * height counter: material accumulates, every legal breakpoint is priced, the
 * cheapest so far is remembered, and the page fires when the cost becomes
 * infinite — which is what makes a `\newpage` in the middle of a paragraph and
 * a widow penalty two spellings of the same mechanism.
 *
 * Footnotes are TeX's `\insert` class 'footins'. A footnote does not sit in the
 * vertical list at all; it rides as a `Marker` inside the *line* that carries
 * its mark, and reaching that line on a page shrinks the page's goal by the
 * note's height. That is the whole reason the note lands at the foot of the
 * page its reference reached: if the note no longer fits, the goal shrinks
 * below what has already accumulated, the cost goes infinite, and the page
 * fires at the last break *before* the referencing line — carrying line and
 * note to the next page together.
 */

/** TeX's `deplorable` (§1005): worse than any finite badness, better than awful. */
const DEPLORABLE = 100_000;

export interface PageBuildOptions {
  design: PageDesign;
  /** Footnote material, keyed by the marker `vlist.ts` put beside each mark. */
  footnotes: ReadonlyMap<string, PreparedFootnote>;
  fonts: FontProvider;
  shaper: Shaper;
  budget: Budget;
  diagnostics: Diagnostic[];
  /** The entrypoint, for diagnostics with no better position. */
  file: string;
  maxPages: number;
}

export interface PageBuildResult {
  pages: Page[];
  /** Where every `Marker` landed — the input to the second layout pass. */
  markerPages: Map<string, number>;
}

/** A footnote and the position in the vertical list that pulled it onto a page. */
interface PendingNote {
  index: number;
  note: PreparedFootnote;
}

export function buildPages(list: VList, opts: PageBuildOptions): PageBuildResult {
  const { design } = opts;
  const pages: Page[] = [];
  const markerPages = new Map<string, number>();
  const at = wholeFile(opts.file);

  let start = skipDiscardable(list, 0);
  let index = start;
  let extent = zeroExtent();
  let boxes = 0;
  let notes: PendingNote[] = [];
  let insertHeight = 0;
  let best = -1;
  let bestCost = AWFUL_BAD;
  let truncated = false;

  const reset = (from: number): void => {
    start = from;
    index = from;
    extent = zeroExtent();
    boxes = 0;
    notes = [];
    insertHeight = 0;
    best = -1;
    bestCost = AWFUL_BAD;
  };

  const fire = (breakAt: number): void => {
    const cut = breakAt < 0 ? index : breakAt;
    const carried = notes.filter((n) => n.index < cut).map((n) => n.note);
    pages.push(placePage(list.slice(start, cut), pages.length + 1, carried, opts, markerPages));
    reset(skipDiscardable(list, cut));
  };

  while (index < list.length) {
    if (!spend(opts.budget)) break;
    if (pages.length >= opts.maxPages) {
      truncated = true;
      break;
    }
    const node = list[index] as VNode;

    if (boxes > 0 && isBreakpoint(list, index)) {
      const p = node.kind === "penalty" ? node.penalty : 0;
      const cost = pageCost(extent, design.textHeight - insertHeight, p);
      if (cost <= bestCost) {
        best = index;
        bestCost = cost;
      }
      if (cost === AWFUL_BAD || p <= EJECT_PENALTY) {
        fire(best);
        continue;
      }
    }

    if (node.kind === "hbox" || node.kind === "vbox" || node.kind === "rule") {
      boxes++;
      for (const name of markersIn(node)) {
        const note = opts.footnotes.get(name);
        if (note === undefined || notes.some((n) => n.note === note)) continue;
        insertHeight += note.height + (notes.length === 0 ? footnoteBlockOverhead(design) : FOOTNOTE_GAP);
        notes.push({ index, note });
      }
      // `\topskip` (§1001): the first box on a page has its glue replaced so
      // that its baseline sits `\topskip` below the top of the text body,
      // whatever its own height. That is why the first lines of consecutive
      // pages line up even when one starts with a capital and one with an `x`.
      if (boxes === 1) {
        extent.natural += Math.max(design.topSkip, node.height) + node.depth;
        index++;
        continue;
      }
    }

    addNodeExtent(extent, node, "v");
    index++;
  }

  if (index > start || boxes > 0) {
    const carried = notes.map((n) => n.note);
    if (pages.length < opts.maxPages) {
      pages.push(placePage(list.slice(start, index), pages.length + 1, carried, opts, markerPages));
    } else {
      truncated = true;
    }
  }

  // A document that set nothing still gets a page: `\documentclass{article}`
  // with an empty body produces one blank sheet in LaTeX too, and a PDF with
  // no pages at all is not a valid file.
  if (pages.length === 0) pages.push(placePage([], 1, [], opts, markerPages));

  if (truncated) {
    opts.diagnostics.push(
      error("limit-exceeded", at, `the document reached the ${opts.maxPages}-page cap and was truncated`),
    );
  }
  return { pages, markerPages };
}

/** `\skip\footins` plus `\footnoterule`'s own kerns and the rule itself. */
function footnoteBlockOverhead(design: PageDesign): number {
  return (
    design.footnoteSkip + design.footnoteRuleAbove + design.footnoteRuleThickness + design.footnoteRuleBelow
  );
}

/**
 * Space between two footnotes on one page. LaTeX gets this from `\footnotesep`,
 * a strut at the head of every note; a plain gap is the same thing without
 * having to synthesise the strut.
 */
const FOOTNOTE_GAP = 2;

/**
 * TeX §1000: a break is legal at a penalty below infinity, at glue whose
 * predecessor is a box or a rule, and at a kern followed by glue. The
 * "predecessor is not discardable" rule is what stops a page from breaking
 * inside the run of glue and penalties that separates two paragraphs.
 */
function isBreakpoint(list: VList, index: number): boolean {
  const node = list[index] as VNode;
  if (node.kind === "penalty") return node.penalty < INFINITE_PENALTY;
  if (node.kind === "glue") {
    const previous = list[index - 1];
    return previous !== undefined && !isDiscardable(previous);
  }
  if (node.kind === "kern") return list[index + 1]?.kind === "glue";
  return false;
}

function isDiscardable(node: VNode): boolean {
  return node.kind === "glue" || node.kind === "kern" || node.kind === "penalty";
}

/** After a page break, leading glue, kerns and penalties are dropped (§1000). */
function skipDiscardable(list: VList, from: number): number {
  let index = from;
  while (index < list.length && isDiscardable(list[index] as VNode)) index++;
  return index;
}

/** TeX §1005's page-cost function, without the insertion penalties `q`. */
function pageCost(extent: Extent, goal: number, penaltyValue: number): number {
  const setting = computeGlueSet(extent, goal);
  const b = setting.overfull > 0 ? AWFUL_BAD : setting.badness;
  if (b >= AWFUL_BAD) return AWFUL_BAD;
  if (penaltyValue <= EJECT_PENALTY) return penaltyValue;
  if (b < INF_BAD) return b + penaltyValue;
  return DEPLORABLE;
}

/** Marker names anywhere inside a box, in paint order. */
function markersIn(node: VNode): string[] {
  const found: string[] = [];
  const walk = (nodes: readonly (HNode | VNode)[]): void => {
    for (const child of nodes) {
      if (child.kind === "marker") found.push(child.name);
      else if (child.kind === "hbox" || child.kind === "vbox") walk(child.content);
      else if (child.kind === "disc") walk(child.no);
    }
  };
  if (node.kind === "hbox" || node.kind === "vbox") walk(node.content);
  return found;
}

// --- placement --------------------------------------------------------------

function placePage(
  body: VList,
  number: number,
  notes: readonly PreparedFootnote[],
  opts: PageBuildOptions,
  markerPages: Map<string, number>,
): Page {
  const { design } = opts;
  const items: PlacedItem[] = [];
  const onMarker = (name: string): void => {
    if (!markerPages.has(name)) markerPages.set(name, number);
  };

  placeVertical(body, design.marginLeft, design.marginTop, items, onMarker, design.topSkip);

  if (notes.length > 0) {
    placeFootnotes(notes, opts, items, onMarker);
  }

  const folio = renderFolio(number, opts);
  if (folio !== null) {
    // `\ps@plain`: the folio is centred in the text measure, on a baseline
    // `\footskip` below the bottom of the text body.
    const x = design.marginLeft + (design.textWidth - folio.width) / 2;
    placeHorizontal(folio, x, design.marginTop + design.textHeight + design.footSkip, items, onMarker);
  }

  return { number, width: design.paperWidth, height: design.paperHeight, items };
}

function placeFootnotes(
  notes: readonly PreparedFootnote[],
  opts: PageBuildOptions,
  items: PlacedItem[],
  onMarker: (name: string) => void,
): void {
  const { design } = opts;
  let height = design.footnoteRuleAbove + design.footnoteRuleThickness + design.footnoteRuleBelow;
  for (let i = 0; i < notes.length; i++) {
    height += (notes[i] as PreparedFootnote).height + (i === 0 ? 0 : FOOTNOTE_GAP);
  }

  // The note block hugs the bottom of the text body, which is where a page
  // vpacked to `\pagegoal` puts it.
  let y = design.marginTop + design.textHeight - height;
  y += design.footnoteRuleAbove;
  items.push({
    kind: "rule",
    x: design.marginLeft,
    y,
    width: design.textWidth * design.footnoteRuleWidthFraction,
    height: design.footnoteRuleThickness,
  });
  y += design.footnoteRuleThickness + design.footnoteRuleBelow;

  for (let i = 0; i < notes.length; i++) {
    if (i > 0) y += FOOTNOTE_GAP;
    const note = notes[i] as PreparedFootnote;
    placeVertical(note.list, design.marginLeft, y, items, onMarker, 0);
    y += note.height;
  }
}

/** The page number, as `\ps@plain` sets it. */
function renderFolio(number: number, opts: PageBuildOptions): HBox | null {
  const handle = opts.fonts.get({ family: "serif", weight: "regular", slant: "upright" });
  if (handle === undefined) return null;
  const size = opts.design.sizes.normalsize.size;
  return hpack([shapeRun({ font: handle, size }, String(number), opts.shaper)], "natural").box;
}

/**
 * Place a vertical list with its top edge at `yTop`.
 *
 * `topSkip` non-zero reproduces TeX's `\topskip` for the first box; footnote
 * blocks pass zero, because a footnote's first baseline is measured from the
 * rule above it and not from a page edge.
 *
 * Glue is placed at its **natural** size: this engine sets `\raggedbottom`, so
 * a short page ends short rather than having its interline glue spread to reach
 * the bottom margin. `\flushbottom` would set the page's glue against
 * `\textheight` here instead.
 */
function placeVertical(
  list: VList,
  x: number,
  yTop: number,
  items: PlacedItem[],
  onMarker: (name: string) => void,
  topSkip: number,
): void {
  let y = yTop;
  let first = true;
  for (const node of list) {
    switch (node.kind) {
      case "glue":
        y += node.natural;
        break;
      case "kern":
        y += node.amount;
        break;
      case "penalty":
        break;
      case "marker":
        onMarker(node.name);
        break;
      case "rule":
        items.push({ kind: "rule", x, y, width: node.width, height: node.height + node.depth });
        y += node.height + node.depth;
        first = false;
        break;
      case "hbox": {
        if (first && topSkip > 0) y = yTop + Math.max(topSkip - node.height, 0);
        const baseline = y + node.height;
        placeHorizontal(node, x, baseline, items, onMarker);
        y = baseline + node.depth;
        first = false;
        break;
      }
      case "vbox": {
        if (first && topSkip > 0) y = yTop + Math.max(topSkip - node.height, 0);
        placeVertical(node.content, x + node.shift, y, items, onMarker, 0);
        y += node.height + node.depth;
        first = false;
        break;
      }
    }
  }
}

function placeHorizontal(
  box: HBox,
  x: number,
  baseline: number,
  items: PlacedItem[],
  onMarker: (name: string) => void,
): void {
  placeHNodes(box.content, x, baseline, box.glueSet, items, onMarker);
}

/** Returns the pen position after the run. */
function placeHNodes(
  nodes: readonly HNode[],
  x: number,
  baseline: number,
  glueSet: GlueSet | null,
  items: PlacedItem[],
  onMarker: (name: string) => void,
): number {
  let pen = x;
  for (const node of nodes) {
    switch (node.kind) {
      case "glyphs":
        if (node.glyphs.length > 0) {
          items.push({
            kind: "glyphrun",
            x: pen,
            y: baseline,
            font: node.font,
            size: node.size,
            glyphs: node.glyphs,
            width: node.width,
            text: node.text,
          });
        }
        pen += node.width;
        break;
      // The width a glue node actually came out at, never its natural size: an
      // interword space on a justified line is wider or narrower than natural
      // by exactly the box's glue set (`glue.ts`).
      case "glue":
        pen += setWidth(node, glueSet);
        break;
      case "kern":
        pen += node.amount;
        break;
      case "penalty":
        break;
      case "marker":
        onMarker(node.name);
        break;
      // A discretionary the line did *not* break at still sets its unbroken
      // form; skipping it would drop the text either side of an author's hyphen.
      case "disc":
        pen = placeHNodes(node.no, pen, baseline, glueSet, items, onMarker);
        break;
      case "rule":
        // A rule's `y` is its top edge and it grows downward, so a rule with a
        // negative height (an underline) is drawn below the baseline.
        items.push({ kind: "rule", x: pen, y: baseline - node.height, width: node.width, height: node.height + node.depth });
        pen += node.width;
        break;
      case "hbox":
        // `shift` in a horizontal list is a raise: negative moves up, which is
        // how a footnote's mark is set as a superscript.
        placeHorizontal(node, pen, baseline + node.shift, items, onMarker);
        pen += node.width;
        break;
      case "vbox":
        placeVertical(node.content, pen + node.shift, baseline - node.height, items, onMarker, 0);
        pen += node.width;
        break;
    }
  }
  return pen;
}
