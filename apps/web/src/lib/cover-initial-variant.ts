/**
 * Coverless-tile initial variation (D42, brief 43; **revised 2026-08-29**).
 *
 * D42 asked for two axes so a large collection of coverless items would not
 * render as a wall of identical rectangles: a title initial, plus a second
 * axis to break the ties an initial alone leaves (26 letters repeat quickly
 * across hundreds of items).
 *
 * **The second axis was originally the tile's ground lightness, and that was
 * measured and rejected.** Reading Room's kind tints are near-achromatic warm
 * and cool greys — chroma 0.011–0.017 — so the kind signal D33 rests on is
 * inherently tiny: the closest pair (book vs. music) sits 0.0194 apart in
 * OKLab. A lightness ladder wide enough to tell two tiles apart swamps it. At
 * the 20% mix first built, one kind's own spread came to 0.1871 — nearly *ten
 * times* the distance between two different kinds — so a grid would have read
 * by lightness and not by kind, which is precisely the D33 inversion brief 43
 * exists to prevent. Sweeping the range found no working value: by 4% the
 * spread (0.0374) still beat the kind signal while the per-step difference
 * (0.0094) had already dropped below what anyone can see. The window is empty,
 * and it is empty because of the palette, not the arithmetic.
 *
 * So the second axis moved **off the ground entirely**. The initial's own size
 * and placement vary instead. The tile's background is left exactly as D33 set
 * it, which means the tint test ("strip every badge — the grid still reads by
 * kind") passes by construction here: there is nothing left for this file to
 * weaken.
 *
 * Six variants — three sizes on each of two edges. Enough that a repeated
 * initial rarely repeats its silhouette too, few enough that every variant is
 * a deliberate composition rather than noise.
 */

/**
 * Placement + size classes for the decorative initial, spelled out as full
 * literal class names rather than built with a template literal. Tailwind's
 * compiler only picks up class names it can see literally in source, so
 * `` `text-${size}` `` would silently ship unstyled — the same trap
 * `TINT_CLASS` in `CoverCard.tsx` documents.
 *
 * Every variant bleeds past an edge so the letterform reads as ground texture
 * rather than as a second, competing piece of text; the tile's own
 * `overflow-hidden` does the clipping.
 */
const INITIAL_VARIANTS: readonly string[] = [
  "text-8xl -right-3 -bottom-8",
  "text-9xl -right-5 -bottom-10",
  "text-7xl -right-2 -bottom-6",
  "text-8xl -left-3 -bottom-8",
  "text-9xl -left-5 -bottom-10",
  "text-7xl -left-2 -bottom-6",
];

/**
 * Deterministic string hash (djb2, xor variant) — not a security property,
 * just "the same title always lands on the same variant" across renders,
 * reloads and viewers. Hashes the TITLE rather than the row id: two uploads of
 * the same book should look the same, and the id is server-assigned with no
 * relationship to what a viewer is actually scanning the grid for.
 */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return Math.abs(hash);
}

/** The size + placement classes for this title's decorative initial. */
export function coverInitialVariant(title: string): string {
  return INITIAL_VARIANTS[hashString(title) % INITIAL_VARIANTS.length] as string;
}

/**
 * The initial itself: the title's first **grapheme**, uppercased.
 *
 * `Array.from` rather than `title[0]`/`charAt(0)` because a surrogate-pair
 * character — most emoji, some accented forms — would otherwise split and
 * render as a broken half-glyph. Falls back to `?` for a title that is empty
 * or whitespace-only after trimming.
 */
export function coverInitial(title: string): string {
  return (Array.from(title.trim())[0] ?? "?").toUpperCase();
}
