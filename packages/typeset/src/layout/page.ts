import type { FontHandle, PositionedGlyph } from "../font/handle.ts";

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
