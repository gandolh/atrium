/**
 * Local type declarations for `fontkit` 2.0.4, which ships JavaScript only.
 *
 * These are deliberately *not* `@types/fontkit`: that would be a second
 * dependency describing a surface far wider than we use, and its drift would be
 * invisible until it broke. What follows is the exact slice this package calls,
 * written against the fontkit sources it was verified against, so a fontkit
 * upgrade that moves any of it fails the typecheck here rather than at runtime.
 *
 * Nothing in this file may appear in the package's public `.d.ts` output —
 * `tsc` neither emits nor copies declaration files, so a consumer of `dist`
 * would find these types missing. `createFontHandle` therefore returns
 * `FontHandle`, never a fontkit type.
 */
declare module "fontkit" {
  /**
   * A glyph's outline extent in font units, y-up. fontkit yields `null` (or
   * `Infinity`) for a glyph with no outline — `.notdef`, the space — so every
   * reader must guard with `Number.isFinite` rather than trust the annotation.
   */
  export interface FontkitBBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  export interface FontkitGlyph {
    readonly id: number;
    /** Advance in font units, from `hmtx`, before any GPOS adjustment. */
    readonly advanceWidth: number;
    /**
     * The code points this glyph stands for. Only trustworthy for glyph objects
     * that shaping just produced, and even then see the cache caveat in
     * `fontkit-handle.ts`.
     */
    readonly codePoints: number[];
    readonly bbox: FontkitBBox;
  }

  /** One glyph's placement, in font units. */
  export interface FontkitGlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface FontkitGlyphRun {
    glyphs: FontkitGlyph[];
    /** Parallel to `glyphs`. */
    positions: FontkitGlyphPosition[];
    readonly advanceWidth: number;
  }

  export interface FontkitFont {
    readonly postscriptName: string | null;
    readonly familyName: string | null;
    readonly unitsPerEm: number;
    /** `hhea.ascent`, font units, positive. */
    readonly ascent: number;
    /** `hhea.descent`, font units, **negative** in a well-formed font. */
    readonly descent: number;
    readonly lineGap: number;
    /** `OS/2.xHeight`; `0` when the font has no `OS/2` table. */
    readonly xHeight: number;
    /** `OS/2.capHeight`; falls back to `ascent` when there is no `OS/2` table. */
    readonly capHeight: number;
    readonly numGlyphs: number;
    readonly availableFeatures: string[];

    hasGlyphForCodePoint(codePoint: number): boolean;
    glyphForCodePoint(codePoint: number): FontkitGlyph;
    getGlyph(glyphId: number, codePoints?: number[]): FontkitGlyph;

    /**
     * Shape a string, or re-shape an explicit glyph sequence. `features` turns
     * OpenType features on (`true`) or off (`false`); omitting it lets the
     * shaper pick the script's defaults, which includes `liga` and `kern`.
     */
    layout(
      input: string | readonly FontkitGlyph[],
      features?: Readonly<Record<string, boolean>>,
    ): FontkitGlyphRun;
  }

  /** Parses the header only; tables are decoded lazily on first access. */
  export function create(data: Uint8Array, postscriptName?: string): FontkitFont;
}
