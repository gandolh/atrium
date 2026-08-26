import type { FontHandle, ShapedText } from "../font/handle.ts";
import type { Discretionary, Glue, GlyphNode, HBox, HList, HNode } from "./model.ts";
import { INFINITE_PENALTY, glue, penalty } from "./model.ts";

/**
 * Building the horizontal list a paragraph is broken from.
 *
 * The line breaker's input contract lives here, in code, so the stage that
 * turns a document into paragraphs has something concrete to meet rather than
 * prose to interpret. Nothing in this file reads an AST — that is the document
 * stage's job; these are the primitives it assembles with.
 */

/**
 * A run of text set in one **resolved** face at one size.
 *
 * Distinct from `doc/model.ts`'s `TextStyle`, which is the *semantic* style a
 * document carries — a `FontSelection` (family/weight/slant) plus underline,
 * and deliberately no size. Resolving one into the other is the layout stage's
 * job: it picks the point size from the block's role and asks the
 * `FontProvider` for the handle. Two names because they are two things.
 */
export interface TextFace {
  font: FontHandle;
  /** Type size in points. */
  size: number;
}

/**
 * Measuring the same word over and over is the shape of line breaking: a
 * Knuth-Plass pass reconsiders every word against several candidate lines, and
 * hyphenation re-measures every fragment of every word. The font layer
 * deliberately has no cache, so this is ours.
 *
 * The cache changes speed and nothing else — the key is the whole input — so it
 * cannot make the output depend on the order calls arrive in.
 */
export interface Shaper {
  (style: TextFace, text: string): ShapedText;
}

export function createShaper(): Shaper {
  const cache = new Map<string, ShapedText>();
  return (style, text) => {
    const key = `${style.font.id} ${style.size} ${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const shaped = style.font.shape(text, style.size);
    cache.set(key, shaped);
    return shaped;
  };
}

/** One shaped run as a `GlyphNode`. `text` should contain no spaces — see below. */
export function shapeRun(style: TextFace, text: string, shaper: Shaper): GlyphNode {
  const shaped = shaper(style, text);
  return {
    kind: "glyphs",
    width: shaped.width,
    height: shaped.height,
    depth: shaped.depth,
    font: style.font,
    size: style.size,
    glyphs: shaped.glyphs,
    text,
  };
}

/**
 * The interword glue for a face, from TeX's `\fontdimen` 2, 3, 4 and 7.
 *
 * Computer Modern — and Latin Modern after it — sets these to exactly
 * `space`, `space/2`, `space/3` and `space/3`. We take `space` by measuring
 * U+0020 in the face itself and derive the rest, because the font layer exposes
 * glyph metrics rather than TeX's `\fontdimen` array.
 *
 * **A space is glue, not a glyph.** `FontHandle.shape` will happily give you a
 * space glyph with a fixed advance and no flex; a paragraph built that way can
 * never be justified. Shape the words, put one of these between them.
 */
export interface FontSpacing {
  /** `\fontdimen2`, the natural interword space. */
  space: number;
  /** `\fontdimen3`, how far it stretches. */
  stretch: number;
  /** `\fontdimen4`, how far it shrinks. */
  shrink: number;
  /** `\fontdimen7`, added after a sentence unless `\frenchspacing`. */
  extraSpace: number;
}

export function fontSpacing(style: TextFace, shaper: Shaper): FontSpacing {
  const space = shaper(style, " ").width;
  return { space, stretch: space / 2, shrink: space / 3, extraSpace: space / 3 };
}

/**
 * TeX's `\sfcode` (tex.web §1034, plain.tex): the space factor a character
 * leaves behind. `0` means "leave the factor alone", which is what makes
 * `(word.)` still end a sentence.
 */
function spaceFactorCode(ch: string): number {
  switch (ch) {
    case ".":
    case "?":
    case "!":
      return 3000;
    case ":":
      return 2000;
    case ";":
      return 1500;
    case ",":
      return 1250;
    case ")":
    case "]":
    case "'":
    case '"':
    case "’":
    case "”":
      return 0;
    default:
      return ch >= "A" && ch <= "Z" ? 999 : 1000;
  }
}

/**
 * The space factor at the end of `word`, TeX §1034.
 *
 * The `< 1000` clause is the rule that stops `U.S.A. and` from getting sentence
 * spacing: an uppercase letter leaves the factor at 999, and a following period
 * then raises it only back to 1000 rather than to 3000.
 */
function spaceFactorAfter(word: string): number {
  let sf = 1000;
  for (const ch of word) {
    const code = spaceFactorCode(ch);
    if (code === 0) continue;
    sf = sf < 1000 && code > 1000 ? 1000 : code;
  }
  return sf;
}

/**
 * Interword glue adjusted by a space factor, TeX §1043: stretch scales by
 * `f/1000`, shrink by `1000/f`, and once `f >= 2000` the extra space is added
 * outright. So a sentence break is wider, stretches more readily and resists
 * compression — which is the whole point of it.
 */
export function spaceGlue(spacing: FontSpacing, spaceFactor = 1000): Glue {
  const natural = spaceFactor >= 2000 ? spacing.space + spacing.extraSpace : spacing.space;
  return glue(natural, (spacing.stretch * spaceFactor) / 1000, (spacing.shrink * 1000) / spaceFactor);
}

export interface TextRunOptions {
  /** `\frenchspacing`: every interword space identical. TeX and LaTeX default to `false`. */
  frenchSpacing?: boolean;
  /**
   * `\exhyphenpenalty` — the cost of breaking after a hyphen that the author
   * typed. TeX inserts an empty discretionary after every such hyphen
   * (tex.web §1117); that is why `well-known` may break after the hyphen even
   * though automatic hyphenation never touches a word that contains one.
   */
  exHyphenPenalty?: number;
  shaper?: Shaper;
}

/**
 * A run of prose as a horizontal list: words shaped into `GlyphNode`s with
 * interword `Glue` between them.
 *
 * Whitespace in `text` is collapsed — a run of spaces, tabs and newlines is one
 * interword space, as in LaTeX. Leading and trailing whitespace produce leading
 * and trailing glue, so runs concatenate without the caller having to think
 * about the seam.
 *
 * This does **not** finish the paragraph; call `finishParagraph` for that.
 */
export function textToHList(text: string, style: TextFace, opts: TextRunOptions = {}): HList {
  const shaper = opts.shaper ?? createShaper();
  const spacing = fontSpacing(style, shaper);
  const exHyphenPenalty = opts.exHyphenPenalty ?? 50;
  const out: HList = [];

  // Split on whitespace, keeping the empty leading/trailing pieces so that the
  // caller's spacing survives concatenation of two runs.
  const pieces = text.split(/[\t\n\r ]+/);
  for (let i = 0; i < pieces.length; i++) {
    const word = pieces[i] as string;
    if (i > 0) {
      const previous = pieces[i - 1] as string;
      const factor = opts.frenchSpacing === true || previous === "" ? 1000 : spaceFactorAfter(previous);
      out.push(spaceGlue(spacing, factor));
    }
    if (word === "") continue;
    appendWord(out, word, style, shaper, exHyphenPenalty);
  }
  return out;
}

/** One word, split at any hyphens the author typed so a break may follow them. */
function appendWord(
  out: HList,
  word: string,
  style: TextFace,
  shaper: Shaper,
  exHyphenPenalty: number,
): void {
  let start = 0;
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== "-") continue;
    // The hyphen stays with the text before it; the discretionary that follows
    // has an empty `pre`, so taking the break adds no second hyphen.
    out.push(shapeRun(style, word.slice(start, i + 1), shaper));
    out.push(emptyDiscretionary(exHyphenPenalty));
    start = i + 1;
  }
  if (start < word.length) out.push(shapeRun(style, word.slice(start), shaper));
}

export function emptyDiscretionary(penaltyValue: number): Discretionary {
  return { kind: "disc", pre: [], post: [], no: [], penalty: penaltyValue };
}

/**
 * `\parindent` as TeX represents it: an empty box, not glue and not a kern. A
 * box is neither a break opportunity nor stretchable, so the indent is exactly
 * as wide as it was asked to be and no line can ever break inside it.
 */
export function paragraphIndent(width: number): HBox {
  return { kind: "hbox", width, height: 0, depth: 0, shift: 0, glueSet: null, content: [] };
}

/** `\parfillskip` — plain TeX's `0pt plus 1fil`, which is what leaves the last line short. */
export function parFillSkip(): Glue {
  return glue(0, 1, 0, 1, 0);
}

/**
 * End a paragraph the way TeX does (§816): drop any trailing glue, forbid a
 * break at the join with `\penalty10000`, then append `\parfillskip`. The
 * infinite stretch is what lets the final line be any length at all without
 * being reported as underfull.
 *
 * Idempotent: a list that already ends this way is returned unchanged, so a
 * caller that finishes its own paragraphs and one that does not both work.
 */
export function finishParagraph(hlist: HList, fill: Glue = parFillSkip()): HList {
  if (isFinished(hlist)) return hlist;
  const out = hlist.slice();
  // TeX removes the glue that would otherwise sit at the end of the last line;
  // without this a trailing space would be stretched across the whole measure.
  while (out.length > 0 && (out[out.length - 1] as HNode).kind === "glue") out.pop();
  out.push(penalty(INFINITE_PENALTY), fill);
  return out;
}

export function isFinished(hlist: HList): boolean {
  if (hlist.length < 2) return false;
  const last = hlist[hlist.length - 1] as HNode;
  const before = hlist[hlist.length - 2] as HNode;
  return (
    last.kind === "glue" &&
    last.stretchOrder > 0 &&
    before.kind === "penalty" &&
    before.penalty >= INFINITE_PENALTY
  );
}
