import type { FontHandle, PositionedGlyph } from "../font/handle.ts";

/**
 * The box-and-glue model — the engine's core vocabulary, and TeX's.
 *
 * Everything a document becomes is a list of three kinds of thing: **boxes**
 * (fixed-size content), **glue** (space that can stretch and shrink), and
 * **penalties** (places a break may happen, priced). A *horizontal list* is a
 * paragraph waiting to be line-broken; a *vertical list* is a column of
 * material waiting to be page-broken. Line breaking turns an HList into VList
 * entries; page breaking cuts a VList into pages. Same three nouns both times,
 * which is why one model serves both.
 *
 * **Units.** Every dimension in this file is a floating-point **PDF point**
 * (1/72 inch). TeX uses integer scaled points to make its arithmetic exactly
 * reproducible; we use doubles because the output format is points anyway and
 * a double carries ~15 significant digits, far more than a page needs. Golden
 * dumps round to 3 decimals (see the harness) so the last bits never matter.
 *
 * **Coordinates.** Boxes here are unpositioned — they carry size, not place.
 * Placement happens in `page.ts`, which uses y-down from the page's top-left.
 */

/**
 * Glue order: `0` is ordinary finite space measured in points; `1`/`2`/`3` are
 * TeX's `fil`/`fill`/`filll` infinities. Any glue of a higher order absorbs all
 * the flex, which is how `\hfil` centres and `\vfill` pushes to the bottom.
 */
export type GlueOrder = 0 | 1 | 2 | 3;

/** Stretchable, shrinkable, breakable space. */
export interface Glue {
  readonly kind: "glue";
  /** The size it wants to be. */
  natural: number;
  /** How much it will grow, in units of `stretchOrder`. */
  stretch: number;
  stretchOrder: GlueOrder;
  /** How much it will compress. Shrink is a hard limit; stretch is not. */
  shrink: number;
  shrinkOrder: GlueOrder;
}

/**
 * Fixed space that is *not* a break opportunity — an italic correction, a thin
 * math space, the indentation of a list item. Distinct from zero-flex glue
 * precisely because line breaking may not break here.
 */
export interface Kern {
  readonly kind: "kern";
  amount: number;
}

/**
 * A priced break opportunity. `<= -INFINITE_PENALTY` forces a break,
 * `>= INFINITE_PENALTY` forbids one, and everything between is a cost the
 * breaker weighs against badness.
 */
export interface Penalty {
  readonly kind: "penalty";
  penalty: number;
  /**
   * TeX's "flag": breaking here leaves a visible mark, so two in a row (two
   * hyphenated lines) earn an extra demerit. Set on hyphenation breaks.
   */
  flagged: boolean;
}

export const INFINITE_PENALTY = 10000;
/** Forces a break wherever it appears — `\newpage`, `\\`. */
export const EJECT_PENALTY = -10000;

/**
 * A hyphenation point, or any break where the material differs depending on
 * whether the break is taken: `pre` is appended to the line before the break,
 * `post` starts the line after it, `no` is used when the break is *not* taken.
 * Knuth–Plass needs this — a hyphen only exists in the broken case.
 */
export interface Discretionary {
  readonly kind: "disc";
  pre: HNode[];
  post: HNode[];
  no: HNode[];
  /** Cost of breaking here — TeX's `\hyphenpenalty`. */
  penalty: number;
}

/**
 * How a box's glue was set when it was packed to a target size. Line breaking
 * computes this once per line; placement then knows how wide each glue actually
 * came out without re-solving. TeX's `glue_set` / `glue_sign` / `glue_order`.
 */
export interface GlueSet {
  /** Multiplier applied to each glue's stretch (or shrink) component. */
  ratio: number;
  /** `1` stretching, `-1` shrinking, `0` glue at natural size. */
  sign: -1 | 0 | 1;
  /** Only glue of this order participates; lower orders are frozen at natural. */
  order: GlueOrder;
}

/** A run of glyphs from one font at one size — the atom of set text. */
export interface GlyphNode {
  readonly kind: "glyphs";
  width: number;
  height: number;
  /** Below the baseline, positive downwards. */
  depth: number;
  font: FontHandle;
  /** Type size in points. */
  size: number;
  glyphs: PositionedGlyph[];
  /** The source characters, kept for `/ToUnicode` and for golden dumps. */
  text: string;
}

/** A horizontal list packed into a single box — a set line, a `\hbox`. */
export interface HBox {
  readonly kind: "hbox";
  width: number;
  height: number;
  depth: number;
  /** Raised (negative) or lowered (positive) relative to its baseline. */
  shift: number;
  /** `null` until the box is packed to a target width. */
  glueSet: GlueSet | null;
  content: HNode[];
}

/** A vertical list packed into a single box — a page body, a boxed float. */
export interface VBox {
  readonly kind: "vbox";
  width: number;
  height: number;
  depth: number;
  /** Shifted right (positive) when it sits inside a horizontal list. */
  shift: number;
  glueSet: GlueSet | null;
  content: VNode[];
}

/** A filled rectangle — `\rule`, `\underline`, a table line, the footnote rule. */
export interface RuleNode {
  readonly kind: "rule";
  width: number;
  height: number;
  depth: number;
}

/**
 * A zero-size tag that rides through layout so the page builder can report
 * where it landed. This is how `\pageref` works: `\label` drops a marker, and
 * the page it ends up on is the answer the second pass needs.
 */
export interface Marker {
  readonly kind: "marker";
  name: string;
}

/** What may appear in a paragraph. */
export type HNode = GlyphNode | HBox | VBox | RuleNode | Glue | Kern | Penalty | Discretionary | Marker;
/** What may appear in a column. No discretionaries: nothing hyphenates vertically. */
export type VNode = HBox | VBox | RuleNode | Glue | Kern | Penalty | Marker;

/** A paragraph, before line breaking. */
export type HList = HNode[];
/** A column, before page breaking. */
export type VList = VNode[];

/**
 * A node's size along the list it sits in: width horizontally, height plus
 * depth vertically. Both breakers measure with this, which is the concrete
 * payoff of sharing one model.
 */
export function naturalSize(node: HNode | VNode, direction: "h" | "v"): number {
  switch (node.kind) {
    case "glue":
      return node.natural;
    case "kern":
      return node.amount;
    case "penalty":
    case "marker":
      return 0;
    case "disc":
      // The *unbroken* size, which is what measuring a list means. A breaker
      // that takes this break must measure `pre` and `post` itself — returning
      // 0 here would quietly under-measure every hyphenated word.
      return node.no.reduce((sum, child) => sum + naturalSize(child, direction), 0);
    default:
      return direction === "h" ? node.width : node.height + node.depth;
  }
}

export function glue(
  natural: number,
  stretch = 0,
  shrink = 0,
  stretchOrder: GlueOrder = 0,
  shrinkOrder: GlueOrder = 0,
): Glue {
  return { kind: "glue", natural, stretch, stretchOrder, shrink, shrinkOrder };
}

export function kern(amount: number): Kern {
  return { kind: "kern", amount };
}

export function penalty(value: number, flagged = false): Penalty {
  return { kind: "penalty", penalty: value, flagged };
}
