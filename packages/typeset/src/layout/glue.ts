import type { Glue, GlueOrder, GlueSet, HBox, HNode, VNode } from "./model.ts";
import { naturalSize } from "./model.ts";

/**
 * Glue setting — how a list of boxes and glue is packed to a target size, and
 * how badly it fits.
 *
 * This is the half of line breaking that decides what the reader actually sees.
 * The breaker chooses *where* lines end; this file decides how the leftover
 * space is shared out along each line, and records the answer as a `GlueSet` on
 * the packed box so PDF emission can place glyphs without re-solving anything.
 *
 * Everything here is TeX's, and the values are cited where they appear:
 * `hpack` is tex.web §649–§664, `badness` is §108.
 */

/**
 * TeX's `inf_bad` (tex.web §108). A line this bad is unsettable; `\tolerance`
 * is compared against it, so nothing above 10000 is ever acceptable.
 */
export const INF_BAD = 10000;

/**
 * TeX's `awful_bad`, one past the worst real badness (tex.web §833). The line
 * breaker uses it for "this line is overfull", which is not a degree of badness
 * but a different condition: no amount of tolerance makes it settable.
 */
export const AWFUL_BAD = INF_BAD + 1;

/**
 * The size of a list: its natural size plus how far it will flex, separated by
 * glue order.
 *
 * The four slots are indexed by `GlueOrder` — `[0]` is finite points, `[1..3]`
 * are `fil`/`fill`/`filll`. They are kept apart rather than summed because only
 * the *highest* order present participates in setting; that is the whole reason
 * `\hfill` beats `\hfil` and both beat ordinary interword space.
 */
export interface Extent {
  natural: number;
  stretch: [number, number, number, number];
  shrink: [number, number, number, number];
}

export function zeroExtent(): Extent {
  return { natural: 0, stretch: [0, 0, 0, 0], shrink: [0, 0, 0, 0] };
}

export function cloneExtent(e: Extent): Extent {
  return {
    natural: e.natural,
    stretch: [e.stretch[0], e.stretch[1], e.stretch[2], e.stretch[3]],
    shrink: [e.shrink[0], e.shrink[1], e.shrink[2], e.shrink[3]],
  };
}

/** Accumulate one node into `into`. Mutates, because measuring is a hot loop. */
export function addNodeExtent(into: Extent, node: HNode | VNode, direction: "h" | "v"): void {
  if (node.kind === "glue") {
    into.natural += node.natural;
    into.stretch[node.stretchOrder] += node.stretch;
    into.shrink[node.shrinkOrder] += node.shrink;
    return;
  }
  // Every other node is rigid along the list it sits in. A discretionary
  // measures as its *unbroken* form (`naturalSize`'s contract); glue inside a
  // discretionary's `no` list therefore contributes its natural size and no
  // flex, which is what TeX's `replace_count` material does too.
  into.natural += naturalSize(node, direction);
}

export function measure(nodes: readonly (HNode | VNode)[], direction: "h" | "v"): Extent {
  const e = zeroExtent();
  for (const node of nodes) addNodeExtent(e, node, direction);
  return e;
}

/**
 * TeX's `badness(t, s)` (tex.web §108): how bad it is to stretch (or shrink) by
 * `t` when `s` is available. `0` is perfect, `INF_BAD` is unsettable.
 *
 * TeX computes an integer approximation of **100·(t/s)³** using 32-bit scaled
 * arithmetic. We evaluate the same function in floating point and round, which
 * is what `\tolerance`, `\hbadness` and the fitness thresholds below are all
 * calibrated against.
 *
 * Two artefacts of TeX's integer arithmetic are deliberately *not* reproduced,
 * because they are properties of 32-bit Pascal rather than of typography:
 *
 *  - §108 returns `inf_bad` outright once `r = 297·t/s` exceeds 1290 — an
 *    overflow guard on `r³`. It makes TeX's badness jump from 8189 straight to
 *    10000 at a ratio of about 4.34.
 *  - §852 returns `inf_bad` when the shortfall exceeds 7230584sp (110.33pt) and
 *    the available stretch is under 1663497sp (25.38pt), for the same reason.
 *
 * Both only fire at ratios above ~4.3, where a line is visibly broken anyway.
 * They matter only under `\sloppy` (`\tolerance=9999`), where TeX would refuse
 * a ratio-4.5 line that we accept at badness 9112.
 */
export function badness(shortfall: number, available: number): number {
  if (shortfall <= 0) return 0;
  if (available <= 0) return INF_BAD;
  const ratio = shortfall / available;
  const b = Math.round(100 * ratio * ratio * ratio);
  return b > INF_BAD ? INF_BAD : b;
}

/** The highest glue order with anything in it — TeX's `o` loop, §659. */
function highestOrder(flex: readonly [number, number, number, number]): GlueOrder {
  if (flex[3] !== 0) return 3;
  if (flex[2] !== 0) return 2;
  if (flex[1] !== 0) return 1;
  return 0;
}

export interface GlueSetting {
  set: GlueSet;
  /** `0`..`INF_BAD`. Reported against `\hbadness`; never `AWFUL_BAD`. */
  badness: number;
  /** Points the content exceeds `target` by once all finite shrink is spent. */
  overfull: number;
}

/**
 * Set glue so that `extent` fills exactly `target`, TeX's `hpack` §658–§664.
 *
 * The order semantics are the subtle part and the thing PDF emission depends
 * on: only glue whose order equals `set.order` moves at all. Finite glue on a
 * line that also contains `\hfil` gets **nothing** — which is exactly why
 * `\hfil …\hfil` centres its content instead of merely loosening the spaces.
 */
export function computeGlueSet(extent: Extent, target: number): GlueSetting {
  const excess = target - extent.natural;

  if (excess === 0) return { set: { ratio: 0, sign: 0, order: 0 }, badness: 0, overfull: 0 };

  if (excess > 0) {
    const order = highestOrder(extent.stretch);
    const available = extent.stretch[order];
    if (available === 0) {
      // §659: nothing can grow, so the box keeps its natural size and simply
      // fails to reach the target. `glue_sign` is `normal`, and the badness of
      // stretching by anything with nothing available is `inf_bad` by §108.
      return { set: { ratio: 0, sign: 0, order: 0 }, badness: INF_BAD, overfull: 0 };
    }
    return {
      set: { ratio: excess / available, sign: 1, order },
      // §660: an infinitely stretchable box is never underfull, however far it
      // was stretched — `\hfill` is a statement of intent, not a shortfall.
      badness: order === 0 ? badness(excess, available) : 0,
      overfull: 0,
    };
  }

  const shortfall = -excess;
  const order = highestOrder(extent.shrink);
  const available = extent.shrink[order];

  if (available === 0) {
    // Nothing shrinks: the content simply sticks out by the whole shortfall.
    return { set: { ratio: 0, sign: 0, order: 0 }, badness: INF_BAD, overfull: shortfall };
  }
  if (order > 0) {
    // §664: infinite shrinkability absorbs any surplus, so the box is never
    // overfull and its badness is zero.
    return { set: { ratio: shortfall / available, sign: -1, order }, badness: 0, overfull: 0 };
  }
  if (available < shortfall) {
    // §664 exactly: glue is set to *full* shrink (`glue_set := 1.0`) and the
    // surplus is reported as an overfull box. The line is still emitted — a
    // visibly-too-long line that a human can see and fix beats a crash.
    return { set: { ratio: 1, sign: -1, order: 0 }, badness: INF_BAD, overfull: shortfall - available };
  }
  return {
    set: { ratio: shortfall / available, sign: -1, order: 0 },
    badness: badness(shortfall, available),
    overfull: 0,
  };
}

/**
 * The width one glue node actually occupies in a box that was set with
 * `glueSet`. **PDF emission must advance the pen by this, not by
 * `glue.natural`.**
 *
 * Note the order test: a glue node whose order differs from the box's set order
 * stays at its natural size no matter how large `ratio` is.
 */
export function setWidth(g: Glue, glueSet: GlueSet | null): number {
  if (glueSet === null || glueSet.sign === 0) return g.natural;
  if (glueSet.sign === 1) {
    return g.stretchOrder === glueSet.order ? g.natural + glueSet.ratio * g.stretch : g.natural;
  }
  return g.shrinkOrder === glueSet.order ? g.natural - glueSet.ratio * g.shrink : g.natural;
}

export interface PackReport {
  box: HBox;
  /** Natural width of the content, before setting. */
  natural: number;
  /** Points the box overflows `target` by; `0` when it fits. */
  overfull: number;
  /** Badness of the glue as set, `0`..`INF_BAD`. */
  badness: number;
}

/**
 * Pack a horizontal list into an `HBox` of exactly `target` points — TeX's
 * `\hbox to`. `"natural"` packs to whatever the content wants, leaving the glue
 * unset (`sign: 0`).
 *
 * The box's height and depth are the *maxima* over its content, which is why a
 * single parenthesis raises a whole line's height. `HBox.shift` is a raise or
 * lower (see `model.ts`) so it moves the contribution vertically; `VBox.shift`
 * is documented there as horizontal, so it is left out of this calculation.
 */
export function hpack(content: HNode[], target: number | "natural"): PackReport {
  const extent = measure(content, "h");
  const width = target === "natural" ? extent.natural : target;

  let height = 0;
  let depth = 0;
  for (const node of content) {
    switch (node.kind) {
      case "glue":
      case "kern":
      case "penalty":
      case "marker":
        break;
      case "disc": {
        // The unbroken form is what sits in the box, so it is what contributes.
        const inner = hpack(node.no, "natural");
        if (inner.box.height > height) height = inner.box.height;
        if (inner.box.depth > depth) depth = inner.box.depth;
        break;
      }
      case "hbox": {
        const h = node.height - node.shift;
        const d = node.depth + node.shift;
        if (h > height) height = h;
        if (d > depth) depth = d;
        break;
      }
      default: {
        if (node.height > height) height = node.height;
        if (node.depth > depth) depth = node.depth;
        break;
      }
    }
  }

  const setting = computeGlueSet(extent, width);
  const box: HBox = {
    kind: "hbox",
    width,
    height,
    depth,
    shift: 0,
    glueSet: setting.set,
    content,
  };
  return { box, natural: extent.natural, overfull: setting.overfull, badness: setting.badness };
}
