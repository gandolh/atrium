/**
 * The slice of `@pdf-lib/fontkit` this package uses, as real exported types.
 *
 * These live in a normal module rather than in the ambient declaration next to
 * it for one reason: `tsc` neither emits nor copies `.d.ts` files, so a type
 * that only exists in `pdf-lib-fontkit.d.ts` would be *missing* from `dist` and
 * any emitted declaration referring to it would dangle. `FontSubset` names two
 * of them, so they have to be here. The ambient file types the library's
 * default export in terms of this module.
 */

/** Outline extent in font units, y-up. */
export interface FontkitBBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * `restructure`'s `EncodeStream`: a paused Node-style `Readable` that
 * accumulates pushed chunks. `read()` after `end()` returns the whole font in
 * one buffer, with no event loop turn in between — which is what makes
 * synchronous subsetting possible.
 */
export interface SubsetEncodeStream {
  end(): void;
  read(): Uint8Array | null;
}

export interface FontkitSubset {
  /**
   * Truthy when the subset is CFF-flavoured, which decides `FontFile3` +
   * `/CIDFontType0` over `FontFile2` + `/CIDFontType2`. Note this is a property
   * of the *subset*, not of the font: Latin Modern reports `font.cff === false`
   * and `subset.cff` truthy.
   */
  readonly cff: unknown;
  /**
   * Adds a glyph id to the subset, returning its id *within the subset*. Ids
   * are handed out in call order starting at 1; 0 is `.notdef`, included by the
   * constructor.
   */
  includeGlyph(glyphId: number): number;
  /** Writes the subset font into `stream`. Synchronous. */
  encode(stream: SubsetEncodeStream): void;
  /**
   * The documented wrapper around `encode`, which defers it to a `nextTick`.
   * Called here only to obtain the `EncodeStream` constructor — see
   * `subset.ts` for why that is worth doing.
   */
  encodeStream(): SubsetEncodeStream;
}

export interface FontkitFont {
  readonly postscriptName: string | null;
  readonly unitsPerEm: number;
  readonly italicAngle: number;
  readonly bbox: FontkitBBox;
  readonly "OS/2"?: { readonly sFamilyClass: number };
  readonly head: { readonly macStyle: { readonly italic: boolean } };
  readonly post: { readonly isFixedPitch: boolean };
  createSubset(): FontkitSubset;
}
