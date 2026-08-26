/**
 * The font seam. `FontHandle` is what chunk "fonts" implements over `fontkit`
 * and the committed Latin Modern faces; layout and PDF emission only ever see
 * this interface, so nothing above it knows what a `.otf` is.
 *
 * **Two unit systems, one rule.** Raw metrics (`ascent`, `advanceWidth`,
 * `kern`, …) are in *font units* — the font's own integer grid, faithful and
 * size-independent. Layout works in *points*. Convert with exactly one formula:
 *
 * ```
 * points = fontUnits * size / unitsPerEm
 * ```
 *
 * `shape()` does that conversion for you and is what layout should call; the
 * raw accessors exist for the cases that need to reason about the font itself.
 */

/** One glyph, positioned relative to the start of its run, in points. */
export interface PositionedGlyph {
  /** Glyph index in the font — not a Unicode code point. */
  id: number;
  /** Pen advance after drawing this glyph, in points (kerning already folded in). */
  advance: number;
  /** Draw-time offset from the pen position, in points. Usually 0. */
  xOffset: number;
  /** Draw-time offset from the baseline, in points. Positive is *up*. Usually 0. */
  yOffset: number;
  /**
   * Index into the run's source `text` that this glyph came from. Several
   * glyphs may share one cluster (a decomposed accent) and one glyph may cover
   * several (the `fi` ligature); PDF emission needs it to build `/ToUnicode`.
   */
  cluster: number;
}

/** The result of laying a string out in one font at one size. All in points. */
export interface ShapedText {
  glyphs: PositionedGlyph[];
  /** Sum of the advances. */
  width: number;
  /** Extent above the baseline. */
  height: number;
  /** Extent below the baseline, positive downwards (TeX's "depth"). */
  depth: number;
}

/** `points = fontUnits * size / unitsPerEm` — the only scaling rule in the engine. */
export function scaleToPoints(fontUnits: number, size: number, unitsPerEm: number): number {
  return (fontUnits * size) / unitsPerEm;
}

export interface FontHandle {
  /**
   * Stable identifier for this face, e.g. `lmroman10-regular`. Appears verbatim
   * in golden dumps, so it must not change between runs or platforms.
   */
  readonly id: string;
  /** The name PDF embeds the font under. */
  readonly postscriptName: string;

  /** The font's design grid — 1000 for CFF, commonly 2048 for TrueType. */
  readonly unitsPerEm: number;
  /** Font units above the baseline, positive. */
  readonly ascent: number;
  /**
   * Font units below the baseline, **positive downwards**. OpenType stores this
   * as a negative number; handles normalise the sign so layout never has to
   * remember which convention a given face used.
   */
  readonly descent: number;
  /** Extra leading the designer asked for between lines, in font units. */
  readonly lineGap: number;
  /** Height of lowercase `x`, in font units. */
  readonly xHeight: number;
  /** Height of uppercase `H`, in font units. */
  readonly capHeight: number;

  /**
   * The original font file. PDF emission embeds a subset built from these
   * bytes; the engine itself never reads a file, so whoever constructs the
   * handle is responsible for supplying them.
   */
  readonly data: Uint8Array;

  /** Glyph ids for a string, with ligature substitution applied. */
  glyphsForString(text: string): number[];
  /** Advance of one glyph, in font units. */
  advanceWidth(glyphId: number): number;
  /** Kern between an adjacent pair, in font units. `0` when the pair is not kerned. */
  kern(leftGlyphId: number, rightGlyphId: number): number;
  /**
   * Shape a string at a size: ligatures, kerning and scaling to points in one
   * step. This is what layout calls.
   */
  shape(text: string, size: number): ShapedText;
}

export type FontFamily = "serif" | "sans" | "mono";
export type FontWeight = "regular" | "bold";
export type FontSlant = "upright" | "italic";

/** A face request in document terms — `\textbf{\textit{…}}` in a serif document. */
export interface FontRequest {
  family: FontFamily;
  weight: FontWeight;
  slant: FontSlant;
}

/**
 * Where the engine gets faces. Injected through `CompileOptions.fonts` so the
 * engine stays I/O-free: a caller in Node passes the committed Latin Modern
 * set, a caller in a browser passes whatever it fetched.
 */
export interface FontProvider {
  /**
   * `undefined` when the face is unavailable — the caller must then emit a
   * `missing-font` diagnostic rather than quietly substituting another face.
   */
  get(request: FontRequest): FontHandle | undefined;
}
