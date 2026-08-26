import Hypher from "hypher";
import enUsPatterns from "hyphenation.en-us";
import type { FontHandle, PositionedGlyph } from "../font/handle.ts";
import type { Discretionary, GlyphNode, HList, HNode } from "./model.ts";
import type { Shaper, TextFace } from "./hlist.ts";
import { createShaper, shapeRun } from "./hlist.ts";

/**
 * Hyphenation: turning words into break opportunities.
 *
 * Knuth-Plass without hyphenation is a much worse algorithm than Knuth-Plass
 * with it — in a narrow measure the difference between a beautiful paragraph
 * and one full of rivers is almost entirely the hyphens. TeX finds them with
 * Liang's pattern algorithm; `hypher` is a faithful JavaScript implementation
 * of it, and `hyphenation.en-us` carries the very patterns TeX ships.
 *
 * A break point becomes a `Discretionary`: `pre` holds the hyphen that appears
 * only if the break is taken, and `no` is empty because the word's fragments
 * stay in the main list, so the unbroken word measures exactly as it did.
 */

/** Break offsets within a single word, as character indices. Ascending. */
export interface Hyphenator {
  positions(word: string): readonly number[];
}

let sharedEnglish: Hypher | null = null;

/**
 * The en-US hyphenator, TeX's own patterns.
 *
 * The `Hypher` instance is built once and shared: constructing it walks ~4500
 * patterns into a trie, and doing that per paragraph would dominate the cost of
 * setting a document. Sharing is safe because the object is read-only after
 * construction, and it cannot affect output because the trie is a pure function
 * of the pattern file.
 *
 * `\lefthyphenmin` and `\righthyphenmin` come from the pattern file (2 and 3
 * for English, the same values plain TeX uses) and hypher applies them itself.
 */
export function createEnglishHyphenator(): Hyphenator {
  const cache = new Map<string, readonly number[]>();
  return {
    positions(word: string): readonly number[] {
      const hit = cache.get(word);
      if (hit !== undefined) return hit;
      if (sharedEnglish === null) sharedEnglish = new Hypher(enUsPatterns);
      const pieces = sharedEnglish.hyphenate(word);
      const offsets: number[] = [];
      let at = 0;
      for (let i = 0; i < pieces.length - 1; i++) {
        at += (pieces[i] as string).length;
        offsets.push(at);
      }
      cache.set(word, offsets);
      return offsets;
    },
  };
}

export interface HyphenateOptions {
  hyphenator?: Hyphenator;
  /** `\hyphenpenalty`, plain TeX's 50. */
  hyphenPenalty?: number;
  shaper?: Shaper;
  /**
   * Whether a face may be hyphenated at all. TeX asks the same question as
   * `\hyphenchar\font < 0`, and plain.tex answers "no" for typewriter type —
   * a hyphen in `\texttt` reads as part of the code. The engine's font layer
   * has no `\hyphenchar`, so the document stage supplies the predicate.
   */
  hyphenateFont?: (font: FontHandle, size: number) => boolean;
}

/**
 * Insert discretionaries at every hyphenation point in `hlist`.
 *
 * Returns a new list; the input is not touched, because the line breaker runs
 * its first pass on the un-hyphenated list and only reaches for this one when
 * that pass fails (TeX's `second_pass`).
 *
 * **Words are hyphenated within a single `GlyphNode`.** A word split across
 * runs by a font change — `\emph{tele}vision` — is not hyphenated, which is
 * what TeX does too: its hyphenation routine stops at a font change.
 */
export function hyphenateHList(hlist: HList, opts: HyphenateOptions = {}): HList {
  const hyphenator = opts.hyphenator ?? createEnglishHyphenator();
  const shaper = opts.shaper ?? createShaper();
  const hyphenPenalty = opts.hyphenPenalty ?? 50;
  const allow = opts.hyphenateFont;

  let changed = false;
  // TeX §896 skips a whole word that already contains a hyphen the author
  // typed. Such a word arrives here already split — `well-` then an empty
  // discretionary then `established` — so the tail has to be recognised by what
  // precedes it rather than by its own text.
  let afterAuthorsHyphen = false;
  const out: HList = [];
  for (const node of hlist) {
    const skipWord = afterAuthorsHyphen;
    afterAuthorsHyphen = node.kind === "disc" && node.pre.length === 0;
    if (skipWord || node.kind !== "glyphs" || (allow !== undefined && !allow(node.font, node.size))) {
      out.push(node);
      continue;
    }
    const pieces = hyphenateGlyphNode(node, hyphenator, shaper, hyphenPenalty);
    if (pieces === null) {
      out.push(node);
      continue;
    }
    changed = true;
    for (const piece of pieces) out.push(piece);
  }
  return changed ? out : hlist;
}

/** `null` when the run has no usable break, so the caller can keep the original node. */
function hyphenateGlyphNode(
  node: GlyphNode,
  hyphenator: Hyphenator,
  shaper: Shaper,
  hyphenPenalty: number,
): HNode[] | null {
  const cuts = usableCuts(node, hyphenator);
  if (cuts.length === 0) return null;

  const style: TextFace = { font: node.font, size: node.size };
  const starts = clusterStarts(node.glyphs);
  const out: HNode[] = [];
  let from = 0;
  for (const cut of cuts) {
    out.push(fragment(node, style, shaper, starts, from, cut));
    out.push(hyphenDiscretionary(style, shaper, hyphenPenalty));
    from = cut;
  }
  out.push(fragment(node, style, shaper, starts, from, node.text.length));
  return out;
}

/** Maximal runs of letters — TeX's rule, where a character with no `\lccode` ends the word. */
const WORD = /\p{L}+/gu;

/**
 * The break offsets Liang's patterns propose, filtered down to the ones this
 * particular glyph run can actually be cut at.
 *
 * A cut is only usable if some glyph starts exactly there. A break in the
 * middle of a ligature has no glyph boundary to fall on — `fi` is one glyph —
 * so it is dropped rather than approximated.
 */
function usableCuts(node: GlyphNode, hyphenator: Hyphenator): number[] {
  const boundaries = clusterStarts(node.glyphs);
  const text = node.text;
  const cuts: number[] = [];

  WORD.lastIndex = 0;
  for (let match = WORD.exec(text); match !== null; match = WORD.exec(text)) {
    const start = match.index;
    const word = match[0];
    const end = start + word.length;
    // TeX refuses to hyphenate a word that already contains an explicit hyphen
    // (tex.web §896): the author's hyphen is the break, and a second one in the
    // same word reads as a typo.
    if (text[start - 1] === "-" || text[end] === "-") continue;

    for (const offset of hyphenator.positions(word)) {
      const cut = start + offset;
      if (cut <= 0 || cut >= text.length) continue;
      if (!boundaries.has(cut)) continue;
      cuts.push(cut);
    }
  }
  return cuts;
}

/** Character offset → index of the first glyph that starts there. */
function clusterStarts(glyphs: readonly PositionedGlyph[]): Map<number, number> {
  const starts = new Map<number, number>();
  for (let i = 0; i < glyphs.length; i++) {
    const cluster = (glyphs[i] as PositionedGlyph).cluster;
    if (!starts.has(cluster)) starts.set(cluster, i);
  }
  return starts;
}

/**
 * One piece of a split run, `[from, to)` in characters.
 *
 * The glyphs are **sliced, not re-shaped**. `FontHandle.shape` folds a kern
 * into the left glyph's advance and reports a width that is exactly the sum of
 * the advances, so slicing and re-adding is bit-exact: the fragments of an
 * unbroken word measure to the same width the whole word did, down to the last
 * bit. Re-shaping each fragment would silently lose every kern that straddles a
 * hyphenation point and make the *unbroken* word narrower than it should be.
 *
 * Height and depth do come from a re-shape, because they are ink extents rather
 * than sums: `typog-` has no ascender past `t`, and giving it the whole word's
 * height would push the next line down for no reason.
 */
function fragment(
  node: GlyphNode,
  style: TextFace,
  shaper: Shaper,
  starts: ReadonlyMap<number, number>,
  from: number,
  to: number,
): GlyphNode {
  const text = node.text.slice(from, to);
  const firstGlyph = from === 0 ? 0 : (starts.get(from) as number);
  const lastGlyph = to >= node.text.length ? node.glyphs.length : (starts.get(to) as number);

  let width = 0;
  const glyphs: PositionedGlyph[] = [];
  for (let i = firstGlyph; i < lastGlyph; i++) {
    const g = node.glyphs[i] as PositionedGlyph;
    width += g.advance;
    // Clusters are rebased so `/ToUnicode` still indexes into this node's own
    // `text` rather than into the word it was cut out of.
    glyphs.push({ id: g.id, advance: g.advance, xOffset: g.xOffset, yOffset: g.yOffset, cluster: g.cluster - from });
  }

  const ink = shaper(style, text);
  return {
    kind: "glyphs",
    width,
    height: ink.height,
    depth: ink.depth,
    font: node.font,
    size: node.size,
    glyphs,
    text,
  };
}

/**
 * `\discretionary{-}{}{}`: a hyphen that exists only when the break is taken.
 *
 * `no` is empty on purpose. The word's fragments are ordinary nodes in the main
 * list, so the unbroken form is already there; putting it in `no` as well would
 * measure the word twice.
 */
function hyphenDiscretionary(style: TextFace, shaper: Shaper, hyphenPenalty: number): Discretionary {
  return { kind: "disc", pre: [shapeRun(style, "-", shaper)], post: [], no: [], penalty: hyphenPenalty };
}
