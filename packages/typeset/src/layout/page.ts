import type { Diagnostic } from "@ebook-reader/shared";
import type { FontHandle, FontProvider, PositionedGlyph } from "../font/handle.ts";
// Type-only: a placed image carries its decoded bytes, and nothing here calls
// into `image/`.
import type { DecodedImage } from "../image/index.ts";
// Type-only for the same reason: a placed formula carries its already-parsed
// picture, and nothing here reads it.
import type { SvgDocument } from "../pdf/svg.ts";
import type { SourceRef } from "../diagnostics.ts";
import { error, unsupported, warning, wholeFile } from "../diagnostics.ts";
import type { Budget } from "../macro/budget.ts";
import { spend } from "../macro/budget.ts";
import type { PageDesign } from "./design.ts";
// Type-only: a queued float is prepared entirely by `float.ts`; this file
// only ever asks how tall it is and which positions it will accept.
import type { PreparedFloat } from "./float.ts";
import {
  BOTTOM_FRACTION,
  FLOAT_SEP,
  FP_SEP,
  INTEXT_SEP,
  TEXT_FLOAT_SEP,
  TEXT_FRACTION,
  TOP_FRACTION,
  floatBox,
  onlyPlacement,
  placementOrder,
} from "./float.ts";
import type { Extent } from "./glue.ts";
import { AWFUL_BAD, INF_BAD, addNodeExtent, computeGlueSet, hpack, setWidth, zeroExtent } from "./glue.ts";
import type { Shaper } from "./hlist.ts";
import { shapeRun } from "./hlist.ts";
import type { GlueSet, HBox, HNode, VList, VNode } from "./model.ts";
import { EJECT_PENALTY, INFINITE_PENALTY, kern } from "./model.ts";
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

/**
 * A picture placed on a page — `\includegraphics` (brief 39). `y` is its **top**
 * edge, like a rule's, and `width`/`height` are the size it was placed at, not
 * its pixel grid.
 *
 * The decoded image rides along instead of being fetched at emission time
 * because emission has no file map to fetch from (the engine performs no I/O,
 * D38). `path` is the file-map key, and `pdf/render.ts` embeds one `XObject` per
 * distinct `path` — so a logo on forty pages is forty of these items and one
 * copy of the bytes.
 */
export interface PlacedImage {
  readonly kind: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  path: string;
  image: DecodedImage;
}

/**
 * A set formula placed on a page — `$x^2$` or a display (brief 40). `y` is its
 * **top** edge, like a rule's and an image's, and `height` is the whole box:
 * the formula's height *and* its depth, since a formula hangs below the
 * baseline it was placed on.
 *
 * The picture rides along, already parsed, for the reason `PlacedImage` carries
 * its bytes: emission has nothing to look anything up in (the engine performs no
 * I/O, D38). `pdf/content.ts` maps the SVG's viewBox onto this rectangle and
 * writes path operators straight into the page's content stream — no `XObject`,
 * no resource dictionary, nothing to register.
 */
export interface PlacedMath {
  readonly kind: "math";
  x: number;
  y: number;
  width: number;
  height: number;
  /** The MathJax `<svg>`, parsed during layout so a failure could name a source line. */
  picture: SvgDocument;
  /** The TeX it was set from, for golden dumps. */
  source: string;
  /** Where it was written, so an emission-time complaint still points somewhere useful. */
  loc: SourceRef;
}

export type PlacedItem = GlyphRun | PlacedRule | PlacedImage | PlacedMath;

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
 *
 * **Floats (brief 39, chunk 39.4) reuse that machinery and add one thing to
 * it: they may move forward.** A `figure` rides as a zero-height `Marker` in
 * the vertical list at the point the author wrote it, its material parked on
 * `LayoutContext.floats`; reaching that marker offers the float to the page
 * being built, and accepting it shrinks the goal exactly as a footnote's does.
 * The difference is what happens when it is *not* accepted: a footnote can
 * only drag its own line to the next page, while a float stays in a **queue**
 * and is offered again at the top of every subsequent page until some page
 * takes it. The queue is strictly first-in-first-out and placement always
 * consumes a *prefix* of it, which is why `Figure 2` can never appear before
 * `Figure 1` — the ordering guarantee is a property of the data structure
 * rather than a check anyone has to remember to write.
 *
 * **A document with no floats is byte-for-byte the document this file built
 * before floats existed.** Every addition below is either inside a
 * `node.kind === "marker"` arm that no name matches, or behind a length check
 * on a queue that is empty, or an argument that is an empty array. Brief 37's
 * goldens are the proof and they are checked on every run.
 */

/** TeX's `deplorable` (§1005): worse than any finite badness, better than awful. */
const DEPLORABLE = 100_000;

export interface PageBuildOptions {
  design: PageDesign;
  /** Footnote material, keyed by the marker `vlist.ts` put beside each mark. */
  footnotes: ReadonlyMap<string, PreparedFootnote>;
  /**
   * Float material, keyed by the marker `vlist.ts` put where the float was
   * written. **Iteration order is document order** — `vlist.ts` names them
   * `float:0`, `float:1`, … as it reaches them and a `Map` preserves insertion
   * order — which is the whole basis of the no-reordering guarantee.
   *
   * Optional so that a caller laying out prose alone (and every test that
   * predates floats) needs no empty map; `compile()` always passes the real
   * one. An absent or empty map switches the queue off entirely.
   */
  floats?: ReadonlyMap<string, PreparedFloat>;
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

/** Where on a page a float was accepted. `"page"` floats get a sheet of their own. */
type FloatSlot = "here" | "top" | "bottom";

/** A float accepted onto the page being built, and the position that took it. */
interface PlacedFloat {
  float: PreparedFloat;
  where: FloatSlot;
  /**
   * The vertical-list index that pulled it onto this page — its own marker's
   * position. Exactly `PendingNote.index`'s role, and used for exactly the same
   * thing: when the page fires at an earlier breakpoint, anything whose index
   * fell beyond the cut was never really on this page and goes back.
   */
  index: number;
}

/** Shared by every caller that has no floats, so the no-float path allocates nothing. */
const NO_FLOATS: ReadonlyMap<string, PreparedFloat> = new Map();

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

  // --- the float queue ------------------------------------------------------
  //
  // `queue` is every float in document order and `settled` is how many of them
  // have been committed to a page already, so the queue proper is
  // `queue.slice(settled)` and its head is `queue[settled]`. Floats are only
  // ever taken from that head, and `pageFloats` holds the run taken for the
  // page currently being built — which is what makes the placed floats a
  // *prefix* of document order at every moment, and therefore makes
  // "same-class floats never reorder" true by construction.
  //
  // `markerIndex[k]` is where float `k`'s marker sits in `list`, filled in as
  // the scan reaches it. A float may not be placed before it has been written:
  // that is the difference between a float and a footnote, and the reason
  // "here" means anything at all.
  const floats = opts.floats ?? NO_FLOATS;
  const queue: PreparedFloat[] = [...floats.values()];
  const floatOrdinal = new Map<string, number>();
  for (const name of floats.keys()) floatOrdinal.set(name, floatOrdinal.size);
  const markerIndex: number[] = [];
  let settled = 0;
  let pageFloats: PlacedFloat[] = [];

  const reset = (from: number): void => {
    start = from;
    index = from;
    extent = zeroExtent();
    boxes = 0;
    notes = [];
    insertHeight = 0;
    pageFloats = [];
    best = -1;
    bestCost = AWFUL_BAD;
  };

  /**
   * Offer the head of the queue to the page being built, over and over until
   * one is refused. Stopping at the *first* refusal rather than skipping past
   * it is the ordering guarantee: a float that has to wait holds everything
   * behind it back, exactly as LaTeX's does.
   *
   * `here` is the marker index when the scan is standing on a float's own
   * marker, and `null` otherwise — a float being reconsidered at the top of a
   * later page is no longer anywhere near where it was written, so `[h]` is
   * not on offer to it.
   */
  const offerQueue = (upto: number, here: number | null): void => {
    while (settled + pageFloats.length < queue.length) {
      const k = settled + pageFloats.length;
      const written = markerIndex[k];
      if (written === undefined || written > upto) break;
      const float = queue[k] as PreparedFloat;
      const where = choosePosition(float, here === written, pageFloats, extent.natural + insertHeight, design);
      if (where === null) break;
      insertHeight += reserveFor(float, where, pageFloats);
      pageFloats.push({ float, where, index: written });
    }
  };

  /**
   * A float page: `\@fpsep`-separated floats and nothing else, written out
   * *before* the text page that is currently being opened.
   *
   * Only ever called with `pageFloats` empty, and that is load-bearing. The
   * page it emits comes earlier in the document than the page being opened, so
   * a float on it must be earlier in the queue than anything the opening page
   * has already accepted — which is only guaranteed while the opening page has
   * accepted nothing.
   */
  const emitFloatPage = (before: number, relax: boolean): boolean => {
    if (settled >= queue.length || pages.length >= opts.maxPages) return false;
    const head = queue[settled] as PreparedFloat;
    if (!relax && !placementOrder(head.placement).includes("p")) return false;

    const taken: PreparedFloat[] = [];
    let height = 0;
    while (settled + taken.length < queue.length) {
      const k = settled + taken.length;
      const written = markerIndex[k];
      if (!relax && (written === undefined || written >= before)) break;
      const float = queue[k] as PreparedFloat;
      // Mid-document a float page is only for floats that asked for `p`. At
      // `\clearpage` it is for everything left, bar an `[h]`-only float — which
      // the caller reports and steps over rather than moving somewhere the
      // source forbade.
      const eligible = relax
        ? taken.length === 0 || !onlyPlacement(float.placement, "h")
        : placementOrder(float.placement).includes("p");
      if (!eligible) break;
      const need = float.height + (taken.length === 0 ? 0 : FP_SEP);
      // The first float always goes on, however tall: a float page is the last
      // place left, and a page overflowed by a monstrous figure is a better
      // outcome — and a louder one, see `reportOverflowingFloat` — than a
      // figure that is nowhere in the PDF at all.
      if (taken.length > 0 && height + need > design.textHeight) break;
      taken.push(float);
      height += need;
    }
    if (taken.length === 0) return false;

    for (const float of taken) reportOverflowingFloat(float, design, opts.diagnostics);
    pages.push(placeFloatPage(taken, pages.length + 1, opts, markerPages));
    settled += taken.length;
    return true;
  };

  /**
   * Open a fresh text page: give every float still waiting its chance at the
   * top of it, and hand a whole sheet to any that still cannot go anywhere.
   *
   * The loop alternates because the two feed each other — a float page that
   * clears the head of the queue may expose a float that fits at the top of
   * the text page — and terminates because each turn either accepts a float
   * onto the page (bounded by the queue) or emits a float page (which consumes
   * at least one float) or stops.
   */
  const openPage = (): void => {
    if (queue.length === 0) return;
    for (;;) {
      offerQueue(start, null);
      if (pageFloats.length > 0) return;
      if (!emitFloatPage(start, false)) return;
    }
  };

  const fire = (breakAt: number): void => {
    const cut = breakAt < 0 ? index : breakAt;
    const carried = notes.filter((n) => n.index < cut).map((n) => n.note);
    // The same rule for floats, for the same reason. `pageFloats` is in
    // non-decreasing `index` order — the offers made while opening the page all
    // name markers from *before* it, and every offer after that is made at a
    // scan position that only ever grows — so the filter keeps a prefix and
    // `settled` may simply advance by its length.
    const carriedFloats = pageFloats.filter((f) => f.index < cut);
    settled += carriedFloats.length;
    pages.push(placePage(list.slice(start, cut), pages.length + 1, carried, carriedFloats, start, opts, markerPages));
    reset(skipDiscardable(list, cut));
    openPage();
  };

  openPage();

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

    // A float's marker: the point the author wrote it, and the first moment it
    // may be placed. Re-scanning after a page fires re-runs this with the same
    // values, which is why recording the index is idempotent. `floatOrdinal` is
    // empty for a document with no floats, so this arm is a `Map.get` returning
    // `undefined` and nothing else.
    if (node.kind === "marker") {
      const k = floatOrdinal.get(node.name);
      if (k !== undefined) {
        markerIndex[k] = index;
        offerQueue(index, index);
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
      const carriedFloats = pageFloats.filter((f) => f.index < index);
      settled += carriedFloats.length;
      pages.push(
        placePage(list.slice(start, index), pages.length + 1, carried, carriedFloats, start, opts, markerPages),
      );
    } else {
      truncated = true;
    }
  }

  // A document that set nothing still gets a page: `\documentclass{article}`
  // with an empty body produces one blank sheet in LaTeX too, and a PDF with
  // no pages at all is not a valid file.
  if (pages.length === 0) pages.push(placePage([], 1, [], [], 0, opts, markerPages));

  /*
   * `\end{document}` is a `\clearpage`, and `\clearpage` is the promise that
   * no float is ever lost: whatever is still queued is written out on float
   * pages of its own, in document order, before the run ends.
   *
   * What survives that is genuinely unplaceable, and D38 says so out loud
   * rather than letting a page come up a figure short:
   *
   *  - **`[h]` and nothing else.** The author named exactly one position and
   *    the float did not fit there. Moving it anyway would put it somewhere
   *    the source forbade, so it is refused — `unsupported`, an error, naming
   *    the environment at its own line. This is the one case where a float
   *    really does set nothing, and it is the loudest diagnostic in the file.
   *  - **The page cap.** Nothing more can be emitted; `limit-exceeded` below
   *    already says the document was truncated, and each float still holding
   *    material says so at its own line so the author can see what was lost.
   *
   * A float taller than `\textheight` is *not* in this list. It is placed, on a
   * float page of its own, and warned about where it is placed — see
   * `reportOverflowingFloat`, which follows `reportOverflowingFootnotes`'
   * precedent exactly: overflowing the sheet is visible, and a reader can act
   * on it, in a way that a silently absent figure never is.
   */
  while (settled < queue.length) {
    if (!spend(opts.budget)) break;
    const float = queue[settled] as PreparedFloat;
    if (onlyPlacement(float.placement, "h")) {
      opts.diagnostics.push(
        unsupported(
          float.loc,
          float.construct,
          `this float asks for [h] and nothing else, and it does not fit at the point it was written ` +
            `(${float.height.toFixed(1)}pt of material); there is no other position it is allowed to take, ` +
            `so it sets nothing — give it [ht] or [htbp] to let it move`,
        ),
      );
      settled++;
      continue;
    }
    if (pages.length >= opts.maxPages) {
      truncated = true;
      break;
    }
    // `relax`: past the last text page every remaining float is behind us, and
    // `\clearpage` does not consult `[htbp]` any more — it has run out of
    // alternatives to offer. The one letter it still respects is the `[h]`-only
    // refusal handled above.
    if (!emitFloatPage(list.length + 1, true)) break;
  }
  for (let k = settled; k < queue.length; k++) {
    const float = queue[k] as PreparedFloat;
    opts.diagnostics.push(
      warning(
        "limit-exceeded",
        float.loc,
        `this ${float.construct} was still waiting for a page when the document ran out of them; it is not in the output`,
        float.construct,
      ),
    );
  }

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
 * How tall the footnote block on a page comes out — the rule and its kerns,
 * every note, and a `\footnotesep` gap between each pair.
 *
 * Read twice: `placeFootnotes` anchors the block to the foot of the text body
 * with it, and `placePage` stacks bottom floats directly on top of it. Zero for
 * a page with no notes, which is what makes the second reader a one-line
 * addition rather than a special case.
 */
function footnoteBlockHeight(notes: readonly PreparedFootnote[], design: PageDesign): number {
  if (notes.length === 0) return 0;
  let height = design.footnoteRuleAbove + design.footnoteRuleThickness + design.footnoteRuleBelow;
  for (let i = 0; i < notes.length; i++) {
    height += (notes[i] as PreparedFootnote).height + (i === 0 ? 0 : FOOTNOTE_GAP);
  }
  return height;
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
  /** Floats this page accepted, in queue order. Empty for a document with none. */
  floats: readonly PlacedFloat[],
  /** Index in the whole vertical list that `body[0]` came from, for `[h]` splicing. */
  bodyStart: number,
  opts: PageBuildOptions,
  markerPages: Map<string, number>,
): Page {
  const { design } = opts;
  const items: PlacedItem[] = [];
  // First sighting wins. Every marker name is *placed once* — `\label` emits
  // one marker at its own position and nothing copies it (a ToC entry strips
  // the markers out of the heading title it renders, see `tocTitle` in
  // `vlist.ts`, precisely so that this stays true) — so first-wins and
  // last-wins agree, and the guard exists only so that a marker somehow
  // placed twice cannot make `\pageref` depend on which page was built last.
  const onMarker = (name: string): void => {
    if (!markerPages.has(name)) markerPages.set(name, number);
  };

  const tops = floats.filter((f) => f.where === "top");
  const bottoms = floats.filter((f) => f.where === "bottom");

  // Top floats sit at the very top of the text body, `\textfloatsep` above the
  // text. `\topskip` then belongs to the *float*, not to the first line of
  // prose, which is why the body is placed with none: LaTeX's page box puts the
  // float block first and the text follows it directly.
  let bodyTop = design.marginTop;
  for (let i = 0; i < tops.length; i++) {
    const float = (tops[i] as PlacedFloat).float;
    if (i > 0) bodyTop += FLOAT_SEP;
    placeVertical(float.list, design.marginLeft, bodyTop, items, onMarker, 0);
    bodyTop += float.height;
  }
  if (tops.length > 0) bodyTop += TEXT_FLOAT_SEP;

  placeVertical(
    spliceHereFloats(body, bodyStart, floats),
    design.marginLeft,
    bodyTop,
    items,
    onMarker,
    tops.length > 0 ? 0 : design.topSkip,
  );

  // Bottom floats hug the bottom of the text body, above the footnote block —
  // `\output`'s order is text, bottom floats, `\footnoterule`, notes.
  if (bottoms.length > 0) {
    let height = FLOAT_SEP * (bottoms.length - 1);
    for (const slot of bottoms) height += slot.float.height;
    let y = design.marginTop + design.textHeight - footnoteBlockHeight(notes, design) - height;
    for (let i = 0; i < bottoms.length; i++) {
      const float = (bottoms[i] as PlacedFloat).float;
      if (i > 0) y += FLOAT_SEP;
      placeVertical(float.list, design.marginLeft, y, items, onMarker, 0);
      y += float.height;
    }
  }

  if (notes.length > 0) {
    placeFootnotes(notes, opts, items, onMarker);
  }

  placeFolio(number, opts, items, onMarker);

  return { number, width: design.paperWidth, height: design.paperHeight, items };
}

/**
 * The body of a page with `[h]` floats spliced back into it.
 *
 * A "here" float is the one position whose whole meaning is *the point the
 * author wrote it*, so its material goes into the vertical list at its own
 * marker rather than being anchored to an edge of the page. The marker node is
 * left in place — it costs nothing and `\pageref` to a `\label` beside the
 * float still resolves — and `\intextsep` goes either side of the box, which
 * is what `\@bsphack`'s in-text float branch inserts.
 *
 * **The identity path matters more than the splice.** With no here-floats this
 * returns the caller's own array, untouched and unallocated, so a document with
 * no floats reaches `placeVertical` with byte-identical input.
 */
function spliceHereFloats(body: VList, bodyStart: number, floats: readonly PlacedFloat[]): VList {
  const here = floats.filter((f) => f.where === "here");
  if (here.length === 0) return body;
  const out: VNode[] = [];
  for (let i = 0; i < body.length; i++) {
    out.push(body[i] as VNode);
    for (const slot of here) {
      if (slot.index - bodyStart !== i) continue;
      out.push(kern(INTEXT_SEP), floatBox(slot.float), kern(INTEXT_SEP));
    }
  }
  return out;
}

/** The page number, placed as `\ps@plain` places it. */
function placeFolio(
  number: number,
  opts: PageBuildOptions,
  items: PlacedItem[],
  onMarker: (name: string) => void,
): void {
  const folio = renderFolio(number, opts);
  if (folio === null) return;
  const { design } = opts;
  // `\ps@plain`: the folio is centred in the text measure, on a baseline
  // `\footskip` below the bottom of the text body.
  const x = design.marginLeft + (design.textWidth - folio.width) / 2;
  placeHorizontal(folio, x, design.marginTop + design.textHeight + design.footSkip, items, onMarker);
}

/**
 * A float page: `\@floatpagefraction`'s reward, and the last position LaTeX
 * has to offer. Nothing but floats, `\@fpsep` apart.
 *
 * `\@fptop`, `\@fpsep` and `\@fpbot` are `0pt plus 1fil`, `8pt plus 2fil` and
 * `0pt plus 1fil`: equal infinite stretch above and below, so the block of
 * floats is **vertically centred** in the text body. That is computed here
 * rather than left to glue because `placeVertical` sets vertical glue at its
 * natural size (this engine is `\raggedbottom`), so a `fil` in the list would
 * come out as nothing and every float page would be top-aligned.
 */
function placeFloatPage(
  floats: readonly PreparedFloat[],
  number: number,
  opts: PageBuildOptions,
  markerPages: Map<string, number>,
): Page {
  const { design } = opts;
  const items: PlacedItem[] = [];
  const onMarker = (name: string): void => {
    if (!markerPages.has(name)) markerPages.set(name, number);
  };

  let height = FP_SEP * (floats.length - 1);
  for (const float of floats) height += float.height;
  // `Math.max(…, 0)` for the float too tall to fit at all: it starts at the top
  // of the text body and runs off the foot, rather than off both edges at once.
  let y = design.marginTop + Math.max((design.textHeight - height) / 2, 0);
  for (let i = 0; i < floats.length; i++) {
    const float = floats[i] as PreparedFloat;
    if (i > 0) y += FP_SEP;
    placeVertical(float.list, design.marginLeft, y, items, onMarker, 0);
    y += float.height;
  }

  placeFolio(number, opts, items, onMarker);
  return { number, width: design.paperWidth, height: design.paperHeight, items };
}

// --- choosing a position ----------------------------------------------------

/**
 * `\@addtocurcol`: the first position in h → t → b order that this page can
 * still afford, or `null` for "not on this page" — which is what puts the float
 * back at the head of the queue for the next one.
 *
 * `p` is deliberately absent from the search. A float page is not a position on
 * *this* page; it is a page of its own, and `buildPages` writes it between two
 * text pages once the queue's head has run out of alternatives.
 *
 * Two independent tests have to pass. **Room** — the float plus its separation
 * must fit in what is left of `\textheight` after the body already contributed
 * and after every other insert reserved its share. And **proportion** —
 * `\topfraction`, `\bottomfraction` and `\textfraction`, the class's opinion
 * that a page with a figure on it should still be a page of text. `[!]`
 * (`FloatPlacement.override`) suspends the second and only the second: `!` in
 * LaTeX means "ignore the aesthetic rules", never "ignore the paper size".
 */
function choosePosition(
  float: PreparedFloat,
  atItsOwnMarker: boolean,
  taken: readonly PlacedFloat[],
  used: number,
  design: PageDesign,
): FloatSlot | null {
  for (const letter of placementOrder(float.placement)) {
    if (letter === "p") return null;
    if (letter === "h" && !atItsOwnMarker) continue;
    const where: FloatSlot = letter === "h" ? "here" : letter === "t" ? "top" : "bottom";
    if (used + reserveFor(float, where, taken) > design.textHeight) continue;
    if (!float.placement.override && !withinFractions(float, where, taken, design)) continue;
    return where;
  }
  return null;
}

/**
 * How much of `\textheight` accepting this float costs — its own height plus
 * the separation it brings with it.
 *
 * The separation depends on what is already at that end of the page:
 * `\textfloatsep` between the float block and the text, `\floatsep` between
 * two floats inside the block. Summed over a block of *n* floats this comes to
 * exactly what `placePage` then lays out, which is what keeps a page that the
 * builder said would fit from overflowing when it is placed.
 */
function reserveFor(float: PreparedFloat, where: FloatSlot, taken: readonly PlacedFloat[]): number {
  if (where === "here") return float.height + 2 * INTEXT_SEP;
  const already = taken.some((slot) => slot.where === where);
  return float.height + (already ? FLOAT_SEP : TEXT_FLOAT_SEP);
}

/** `\topfraction` / `\bottomfraction` / `\textfraction`, as `article.cls` sets them. */
function withinFractions(
  float: PreparedFloat,
  where: FloatSlot,
  taken: readonly PlacedFloat[],
  design: PageDesign,
): boolean {
  let atEnd = float.height;
  let anywhere = float.height;
  for (const slot of taken) {
    anywhere += slot.float.height;
    if (slot.where === where) atEnd += slot.float.height;
  }
  if (where === "top" && atEnd > TOP_FRACTION * design.textHeight) return false;
  if (where === "bottom" && atEnd > BOTTOM_FRACTION * design.textHeight) return false;
  // `\textfraction`: at least a fifth of every *text* page stays text. A float
  // placed `[h]` is text-page material like the others, so it counts too.
  return anywhere <= (1 - TEXT_FRACTION) * design.textHeight;
}

/**
 * A float taller than the page it is on — placed anyway, and said so.
 *
 * Identical reasoning to `reportOverflowingFootnotes` below, and deliberately
 * the same `overfull-box` code and `warning` severity: a box that cannot be
 * shrunk to fit its allotted space is what that code means, and one page
 * rendering badly is not a reason to refuse the whole document a PDF. The
 * alternative — dropping it — is the silent loss D38 exists to prevent, and a
 * figure that runs off the foot of its own page is at least a figure the author
 * can see and resize.
 */
function reportOverflowingFloat(float: PreparedFloat, design: PageDesign, diagnostics: Diagnostic[]): void {
  if (float.height <= design.textHeight) return;
  diagnostics.push(
    warning(
      "overfull-box",
      float.loc,
      `this ${float.construct} is ${float.height.toFixed(1)}pt tall, taller than the ` +
        `${design.textHeight.toFixed(1)}pt of a whole page; it is placed on a page of its own anyway and ` +
        `overflows it — floats are never split across pages`,
      float.construct,
    ),
  );
}

function placeFootnotes(
  notes: readonly PreparedFootnote[],
  opts: PageBuildOptions,
  items: PlacedItem[],
  onMarker: (name: string) => void,
): void {
  const { design } = opts;
  const ruleOverhead = design.footnoteRuleAbove + design.footnoteRuleThickness + design.footnoteRuleBelow;
  const height = footnoteBlockHeight(notes, design);

  reportOverflowingFootnotes(notes, design.textHeight - ruleOverhead, opts.diagnostics);

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

/**
 * Footnotes are never split across pages (out of scope for this chunk — see
 * the module doc comment's account of how a note's height shrinks the page
 * goal). A note's whole vbox is placed in one piece, bottom-anchored so its
 * *last* line sits exactly at `design.textHeight`, the same anchor a full
 * page of body text would use. That anchor math does not know or care
 * whether the block actually fits: when a note taller than `maxNoteHeight`
 * (the whole page, minus the rule every footnote block carries) is placed
 * this way, its top edge lands above where the anchor math assumes the page
 * begins — off the sheet, not merely into the text above it — and previously
 * did so with nothing in `diagnostics` to say why. `overfull-box` is the
 * right code, not a new one: a box that cannot be shrunk to fit its
 * allotted space is exactly what that code means, just vertical here and
 * reported once per note rather than once per set line. `warning`, matching
 * that code's own precedent (and `underfull-box`'s): one page rendering
 * badly is not a reason to refuse the whole document a PDF.
 */
function reportOverflowingFootnotes(
  notes: readonly PreparedFootnote[],
  maxNoteHeight: number,
  diagnostics: Diagnostic[],
): void {
  for (const note of notes) {
    if (note.height <= maxNoteHeight) continue;
    diagnostics.push(
      warning(
        "overfull-box",
        note.loc,
        `footnote ${note.number} is ${note.height.toFixed(1)}pt tall, taller than the ${maxNoteHeight.toFixed(1)}pt a footnote can ever have on this page; it is placed anyway and overflows the page — footnotes are never split across pages`,
        "\\footnote",
      ),
    );
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
      // An image sits on the baseline (`ImageNode.depth` is always 0), so its
      // top edge is one height above it. Nothing else about the page builder
      // changes for an image: it is a rigid box in a horizontal list, which is
      // what the line breaker and `addNodeExtent` already handle.
      case "image":
        items.push({
          kind: "image",
          x: pen,
          y: baseline - node.height,
          width: node.width,
          height: node.height,
          path: node.path,
          image: node.image,
        });
        pen += node.width;
        break;
      // A formula sits *across* the baseline: `height` above it, `depth` below.
      // So its top edge is one height up and its rectangle is height+depth tall —
      // the only difference from an image, whose depth is always zero. Nothing
      // else about the page builder changes: a math run is a rigid box in a
      // horizontal list, which the line breaker and `addNodeExtent` already
      // handle, and this arm neither measures it nor knows what is inside it.
      case "math":
        items.push({
          kind: "math",
          x: pen,
          y: baseline - node.height,
          width: node.width,
          height: node.height + node.depth,
          picture: node.picture,
          source: node.source,
          loc: node.loc,
        });
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
      default: {
        // The same `never` guard `vlist.ts` now carries on its two dispatchers,
        // and for the same reason: this switch is where a new `HNode` kind stops
        // being drawn, and without it a new kind is dropped here with nothing
        // said. That is how brief 40's math reached a finished PDF as a blank
        // space (D38).
        const unhandled: never = node;
        throw new Error(`page: unhandled node kind ${String((unhandled as { kind: string }).kind)}`);
      }
    }
  }
  return pen;
}
