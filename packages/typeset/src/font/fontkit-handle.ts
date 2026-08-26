import * as fontkit from "fontkit";
import type { FontkitFont, FontkitGlyph } from "fontkit";
import { scaleToPoints } from "./handle.ts";
import type { FontHandle, PositionedGlyph, ShapedText } from "./handle.ts";

/**
 * A `FontHandle` over fontkit. This is the only file in the engine that knows
 * what an OpenType table is.
 *
 * It takes **bytes, not a path**. The engine does no I/O (D38), so acquiring
 * the bytes is the caller's problem: in Node that is
 * `@ebook-reader/typeset/fonts/node`, in a browser it would be `fetch()`.
 *
 * fontkit is the same library pdfkit embeds and subsets with, so the handle a
 * layout run measures with and the font PDF emission writes out are parsed by
 * identical code — the width in the layout cannot disagree with the width in
 * the file.
 */

/**
 * Features for the pairwise `kern()` query. Substitutions must be off or
 * `kern(f, i)` would silently answer for the `fi` ligature instead of the pair
 * it was asked about; `kern` must be on explicitly because the shaper only
 * turns it on by default when it is inferring features from a script, which it
 * cannot do for a bare two-glyph sequence carrying no code points.
 */
const KERN_ONLY: Readonly<Record<string, boolean>> = {
  kern: true,
  liga: false,
  rlig: false,
  clig: false,
  dlig: false,
  hlig: false,
  calt: false,
};

class FontkitHandle implements FontHandle {
  readonly id: string;
  readonly postscriptName: string;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly xHeight: number;
  readonly capHeight: number;
  readonly data: Uint8Array;

  /**
   * The instance every `shape()` goes through. It is kept apart from
   * `glyphFont` because fontkit caches `Glyph` objects by id together with the
   * code points of whichever lookup created them first: one `getGlyph(id)` call
   * from `advanceWidth()` would poison that id with an empty code-point list
   * and quietly corrupt every later cluster index for the same glyph.
   */
  private readonly shapingFont: FontkitFont;
  /** Lazily parsed twin for the id-addressed queries, for the reason above. */
  private glyphFontCache: FontkitFont | null = null;

  constructor(id: string, data: Uint8Array) {
    const font = fontkit.create(data);
    this.id = id;
    this.data = data;
    this.shapingFont = font;
    this.postscriptName = font.postscriptName ?? id;
    this.unitsPerEm = font.unitsPerEm;
    this.ascent = font.ascent;
    // OpenType stores the descender below the baseline as a negative number;
    // the interface promises positive-downwards, so normalise here once and
    // nothing above the font layer has to remember which way a face pointed.
    this.descent = Math.abs(font.descent);
    this.lineGap = font.lineGap;
    // `OS/2` versions below 2 carry neither value and fontkit reports 0. A zero
    // x-height would put every accent and every `\vcenter` in the wrong place,
    // so fall back to measuring the letter the metric is defined as.
    this.xHeight = font.xHeight || outlineTop(font, 0x78);
    this.capHeight = font.capHeight || outlineTop(font, 0x48);
  }

  private get glyphFont(): FontkitFont {
    return (this.glyphFontCache ??= fontkit.create(this.data));
  }

  glyphsForString(text: string): number[] {
    return this.shapingFont.layout(text).glyphs.map((glyph) => glyph.id);
  }

  advanceWidth(glyphId: number): number {
    return this.glyphFont.getGlyph(glyphId).advanceWidth;
  }

  kern(leftGlyphId: number, rightGlyphId: number): number {
    const font = this.glyphFont;
    const left = font.getGlyph(leftGlyphId);
    const run = font.layout([left, font.getGlyph(rightGlyphId)], KERN_ONLY);
    // A GPOS lookup that substituted or reordered is answering a different
    // question than the one asked; report "not kerned" rather than a number
    // whose meaning we cannot vouch for.
    if (run.glyphs.length !== 2) return 0;
    if (run.glyphs[0]?.id !== leftGlyphId || run.glyphs[1]?.id !== rightGlyphId) return 0;
    return (run.positions[0]?.xAdvance ?? left.advanceWidth) - left.advanceWidth;
  }

  shape(text: string, size: number): ShapedText {
    let run = this.shapingFont.layout(text);
    let clusters = clustersFor(text, run.glyphs);

    if (clusters === null) {
      // The code-point counts did not add up, which means at least one glyph
      // object came back from fontkit's cache carrying the code points of an
      // *earlier* lookup for the same id — a document that set "ﬁ" (U+FB01)
      // before it set "fi" is enough to trigger it. Dropping the cache and
      // shaping again rebuilds the glyphs from this run's own code points.
      clearGlyphCache(this.shapingFont);
      run = this.shapingFont.layout(text);
      clusters = clustersFor(text, run.glyphs) ?? spreadClusters(text, run.glyphs.length);
    }

    const upem = this.unitsPerEm;
    const glyphs: PositionedGlyph[] = [];
    let width = 0;
    let height = 0;
    let depth = 0;

    for (let i = 0; i < run.glyphs.length; i++) {
      const glyph = run.glyphs[i]!;
      const position = run.positions[i]!;
      const advance = scaleToPoints(position.xAdvance, size, upem);
      const yOffset = scaleToPoints(position.yOffset, size, upem);

      glyphs.push({
        id: glyph.id,
        advance,
        xOffset: scaleToPoints(position.xOffset, size, upem),
        yOffset,
        cluster: clusters[i]!,
      });

      // Summing the points rather than the font units keeps `width` literally
      // equal to the sum of the advances the caller can see, so a line breaker
      // that adds them up itself never disagrees with us in the last bit.
      width += advance;

      // TeX's height and depth are the *ink's* extent, not the font's: a line
      // of "xxx" is shallower than a line of "gpqy", and that is exactly what
      // makes \baselineskip's interline glue come out right. Glyphs with no
      // outline (the space, .notdef) report a non-finite box and contribute
      // nothing, which is also correct — a space has no height.
      //
      // These come from the outlines, so a round letter's ~1% optical overshoot
      // below the baseline counts as depth where TeX's TFM files rounded it to
      // zero. That is a tenth of a point at 10 pt: more faithful than TeX, and
      // far below anything a reader or a golden dump can see.
      const { minY, maxY } = glyph.bbox;
      if (Number.isFinite(maxY)) height = Math.max(height, scaleToPoints(maxY, size, upem) + yOffset);
      if (Number.isFinite(minY)) depth = Math.max(depth, -(scaleToPoints(minY, size, upem) + yOffset));
    }

    return { glyphs, width, height, depth };
  }
}

/**
 * Build a handle over already-loaded font bytes.
 *
 * `id` is *chosen by the caller and printed verbatim into golden dumps*, so it
 * must be stable across runs, platforms and font refreshes. `latin-modern.ts`
 * uses the upstream filename stem for exactly that reason.
 *
 * `data` is retained by reference and handed back through `handle.data` for PDF
 * embedding; do not mutate it afterwards.
 */
export function createFontHandle(id: string, data: Uint8Array): FontHandle {
  return new FontkitHandle(id, data);
}

/** Top of one character's outline in font units, or 0 if the font lacks it. */
function outlineTop(font: FontkitFont, codePoint: number): number {
  if (!font.hasGlyphForCodePoint(codePoint)) return 0;
  const { maxY } = font.glyphForCodePoint(codePoint).bbox;
  return Number.isFinite(maxY) ? maxY : 0;
}

/**
 * Map each shaped glyph back to the UTF-16 index in `text` it came from.
 *
 * fontkit reports which code points a glyph covers but not where they were, so
 * the mapping is a walk: glyphs come out in source order for the left-to-right
 * scripts this engine supports, and each consumes as many code points as it
 * covers — one for a plain letter, three for the `ffi` in "office".
 *
 * Returns `null` when the walk does not consume the string exactly. That is a
 * signal, not a formality: it is how a stale cached code-point list is caught.
 */
function clustersFor(text: string, glyphs: readonly FontkitGlyph[]): number[] | null {
  const starts = codePointStarts(text);
  const clusters: number[] = [];
  let consumed = 0;

  for (const glyph of glyphs) {
    if (consumed >= starts.length) return null;
    clusters.push(starts[consumed]!);
    // A glyph that covers nothing (an inserted mark) still has to advance the
    // run somewhere sane; charge it one code point so the walk stays monotone.
    consumed += Math.max(1, glyph.codePoints.length);
  }

  return consumed === starts.length ? clusters : null;
}

/** UTF-16 index of each code point, so astral characters count once. */
function codePointStarts(text: string): number[] {
  const starts: number[] = [];
  for (let i = 0; i < text.length; ) {
    starts.push(i);
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  }
  return starts;
}

/**
 * Last resort when even a re-shape will not line up: spread the glyphs evenly
 * over the source. The result is wrong in detail but monotone and in range, so
 * `/ToUnicode` degrades to approximate text extraction instead of throwing or
 * pointing outside the string.
 */
function spreadClusters(text: string, count: number): number[] {
  const starts = codePointStarts(text);
  if (starts.length === 0 || count === 0) return new Array<number>(count).fill(0);
  return Array.from({ length: count }, (_, i) =>
    starts[Math.min(starts.length - 1, Math.floor((i * starts.length) / count))]!,
  );
}

/**
 * Empty fontkit's per-id `Glyph` cache. Reaching into `_glyphs` is reaching
 * past the public API, so it is guarded and confined to this one recovery path:
 * fontkit exposes no supported way to invalidate it, and the alternative is
 * shipping wrong `/ToUnicode` data.
 */
function clearGlyphCache(font: FontkitFont): void {
  const internals = font as unknown as { _glyphs?: unknown };
  if (typeof internals._glyphs === "object" && internals._glyphs !== null) {
    internals._glyphs = {};
  }
}
