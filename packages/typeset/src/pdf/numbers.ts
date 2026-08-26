/**
 * Number formatting for the content stream and the font dictionaries.
 *
 * Two things are load-bearing here, and both are about determinism rather than
 * about precision:
 *
 * 1. `JSON`-ish default formatting is not stable enough. `(0.1 + 0.2)` must not
 *    reach the file as `0.30000000000000004` on one run and `0.3` on another
 *    after an unrelated refactor changes the order of an addition. Rounding to
 *    a fixed grid before formatting removes the whole class of difference.
 * 2. `-0` and `0` are the same number and must produce the same bytes.
 *
 * Five decimal places is 1/100000 pt ≈ 3.5 nm. No renderer, and no printer,
 * resolves anything near it; the digits exist so that accumulated positions
 * round-trip, not because anyone can see them.
 */

const GRID = 100_000;

/** The value a renderer will actually see after `formatNumber` writes it. */
export function roundToOutput(value: number): number {
  return Math.round(value * GRID) / GRID;
}

/** Shortest exact decimal for `roundToOutput(value)`; `-0` and `0` both give `"0"`. */
export function formatNumber(value: number): string {
  const rounded = roundToOutput(value);
  // Catches -0 as well, since `-0 === 0`.
  if (rounded === 0) return "0";

  const fixed = rounded.toFixed(5);
  let end = fixed.length;
  while (fixed.charCodeAt(end - 1) === 0x30 /* '0' */) end--;
  if (fixed.charCodeAt(end - 1) === 0x2e /* '.' */) end--;
  return fixed.slice(0, end);
}

/** `points = fontUnits * 1000 / unitsPerEm` — PDF glyph space is always 1/1000 em. */
export function toGlyphSpace(fontUnits: number, unitsPerEm: number): number {
  return (fontUnits * 1000) / unitsPerEm;
}
