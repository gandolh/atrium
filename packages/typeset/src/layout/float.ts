import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import type {
  Block,
  CaptionBlock,
  FloatBlock,
  FloatClass,
  FloatPlacement,
  FloatPlacementLetter,
  Inline,
  ParagraphBlock,
} from "../doc/model.ts";
import { DEFAULT_FLOAT_PLACEMENT, DEFAULT_TEXT_STYLE } from "../doc/model.ts";
import type { Budget } from "../macro/budget.ts";
import type { FontSize, LengthContext, PageDesign } from "./design.ts";
import { hpack, measure as measureNodes } from "./glue.ts";
import type { Shaper } from "./hlist.ts";
import type { HList, VBox, VList, VNode } from "./model.ts";
import { glue } from "./model.ts";

/**
 * Floats: boxing a `figure`/`table` and telling the page builder where it may
 * go. **Chunk 39.4** — this file and `layout/page.ts` together.
 *
 * The division of labour between the two is deliberate and worth stating up
 * front, because it is what keeps a page-builder change from reflowing plain
 * prose:
 *
 * - **Here** the float's material is *set* — content and caption, at the
 *   float's own measure — and its placement preference is normalised into
 *   LaTeX's fixed h/t/b/p order. Nothing here knows about pages.
 * - **`page.ts`** owns the *queue*: which page a prepared float lands on, in
 *   which of the four positions, and what happens to one that does not fit.
 *
 * `PreparedFloat` is the only thing that crosses, and it is deliberately the
 * same shape as `PreparedFootnote` (`vlist.ts`) — a vertical list, its natural
 * height, and where the source wrote it — because the page builder already
 * knows how to carry material that is not in the vertical list to the page a
 * `Marker` reached. Chunk 39.1 built the seam that way on purpose: deferring a
 * float needs no new node kind in `layout/model.ts`, and a document with no
 * floats takes byte-for-byte the path it took before this chunk existed.
 *
 * **The one thing a float may never be is quiet.** Brief 39 names it and D38's
 * failure contract demands it: a float that cannot be placed is a diagnostic,
 * reported at the float's own `loc`, never a page that silently comes up one
 * figure short. See `page.ts`'s end-of-document sweep for the other half.
 */

/**
 * A float's material, boxed and waiting for a page to accept it. Deliberately
 * the same shape as `PreparedFootnote` in `vlist.ts`: a vertical list, its
 * natural height, and where the source wrote it.
 */
export interface PreparedFloat {
  floatClass: FloatClass;
  /** The environment as written (`figure`, `table*`) — the `construct` for diagnostics. */
  construct: string;
  /** The `*` form: spans both columns. One-column `article` sets it like the plain form. */
  spanning: boolean;
  placement: FloatPlacement;
  /** The float's own vertical list — content and caption, already set to `measure`. */
  list: VList;
  /** Natural height of `list`, in points. */
  height: number;
  /** The measure the list was set to — the width of the box the page builder places. */
  width: number;
  /** Where `\begin{figure}` sits, for a diagnostic that names it. */
  loc: SourceRef;
}

/**
 * What `prepareFloat` needs beyond the block. The two callbacks hand over
 * `vlist.ts`'s block and inline setting as capabilities, so this file needs
 * none of its internals — see `TableContext` in `table.ts` for the same shape
 * and the same reason (a mutual import would be a real cycle).
 */
export interface FloatContext extends LengthContext {
  design: PageDesign;
  /** The measure a float's content may occupy — `\textwidth` for a full-width float. */
  measure: number;
  /** The type size in force. A caption is set at `\normalsize` in `article`. */
  bodySize: FontSize;
  shaper: Shaper;
  budget: Budget;
  /** Where diagnostics go. Appended to, never replaced. */
  diagnostics: Diagnostic[];
  /** The entrypoint, for a diagnostic with no better position than the document. */
  file: string;
  /**
   * Set a list of blocks as vertical material at `measure`, using the vertical
   * list's own block layout — the way a float's content (paragraphs, a
   * `tabular`, an `\includegraphics`) gets set without this file re-deriving
   * page design.
   *
   * `CaptionBlock`s never reach it: `prepareFloat` sets captions itself and
   * splits the float's content around them (see `setCaption`), which is the
   * second of the two designs chunk 39.1 offered. It was chosen because
   * `\@makecaption` centres a one-line caption and only line-breaks a longer
   * one — a decision that has to be taken *after* measuring the caption, which
   * is a thing this file can do with `setInlines` and a thing the block
   * dispatcher, which only ever hands back a finished vertical list, cannot.
   * Filling in `vlist.ts`'s `case "caption"` arm would have meant either
   * losing the centring or growing a second capability on this context.
   */
  setBlocks(blocks: readonly Block[], measure: number): VList;
  /** Set inlines as one horizontal list — a caption's text, for setting it by hand. */
  setInlines(inlines: readonly Inline[], size: number, at: SourceRef): HList;
}

/**
 * `\figurename` / `\tablename` — the word in front of a caption's number.
 *
 * From `article.cls` (`\figurename{Figure}`, `\tablename{Table}`). Redefining
 * either is refused rather than honoured: both names are in `FORMATTING_HOOKS`
 * (`macro/builtins.ts`), so a `\renewcommand` of one is already a diagnostic.
 */
export const FLOAT_NAME: Readonly<Record<FloatClass, string>> = {
  figure: "Figure",
  table: "Table",
};

// --- the separations a placed float carries (`article` / `size10.clo`) ------

/*
 * LaTeX's float separations, natural sizes only. Every one of them is rubber
 * in the class file (`\floatsep 12\p@ \@plus 2\p@ \@minus 2\p@`, and so on),
 * but this engine sets `\raggedbottom` and `page.ts` places vertical glue at
 * its natural size, so the stretch and shrink components would never be read.
 * They are recorded in the comments rather than in the numbers so that a
 * future `\flushbottom` knows what to reach for.
 */

/** `\floatsep`: between two floats stacked at the same end of a page. `12pt plus 2pt minus 2pt`. */
export const FLOAT_SEP = 12;
/** `\textfloatsep`: between a top/bottom float block and the body text. `20pt plus 2pt minus 4pt`. */
export const TEXT_FLOAT_SEP = 20;
/** `\intextsep`: above and below a float placed `[h]`, in the flow. `12pt plus 2pt minus 2pt`. */
export const INTEXT_SEP = 12;
/** `\@fpsep`: between two floats on a float page. `8pt plus 2fil` — the fil is what centres them. */
export const FP_SEP = 8;

/**
 * `\topfraction` (0.7), `\bottomfraction` (0.3) and `\textfraction` (0.2) from
 * `article.cls`: how much of a *text* page floats may take, so that a page with
 * a figure on it is still a page of text. `[!ht]` — `FloatPlacement.override` —
 * is precisely the instruction to ignore them, which is what the placer does.
 */
export const TOP_FRACTION = 0.7;
export const BOTTOM_FRACTION = 0.3;
export const TEXT_FRACTION = 0.2;

/** `\abovecaptionskip` / `\belowcaptionskip`: `10pt` and `0pt` in `article.cls`. */
const ABOVE_CAPTION_SKIP = 10;
const BELOW_CAPTION_SKIP = 0;

// --- placement preference ---------------------------------------------------

/**
 * The order LaTeX *tries* positions in — here, top, bottom, page — which is
 * not the order the letters were written in.
 *
 * `\@xfloat` reads `[htbp]` into a set of flags and `\@addtocurcol` then tests
 * them in this fixed sequence, so `[bt]` and `[tb]` are the same document.
 * `FloatBlock.placement.letters` keeps the source order because a diagnostic
 * wants to quote what the author actually asked for (see its doc comment in
 * `doc/model.ts`); this is the other half of that decision.
 */
const PLACEMENT_ORDER: readonly FloatPlacementLetter[] = ["h", "t", "b", "p"];

/**
 * The positions a float will accept, in LaTeX's preference order.
 *
 * `placement.explicit` false means no `[...]` was written at all, so the class
 * default (`\fps@figure`, `tbp`) applies — read from `DEFAULT_FLOAT_PLACEMENT`
 * rather than from `letters`, which merely happens to hold the same thing, so
 * that the rule is stated where it is enforced.
 *
 * An explicit option that survives parsing with no usable letter falls back to
 * the default too. `doc/build.ts` already warns about that source (`[!]` is its
 * test case) and has itself substituted the default; the guard here is so that
 * no future parse can turn a float into an unplaceable one by accident, which
 * would silently cost the document a figure.
 */
export function placementOrder(placement: FloatPlacement): readonly FloatPlacementLetter[] {
  const letters = placement.explicit ? placement.letters : DEFAULT_FLOAT_PLACEMENT.letters;
  const chosen = PLACEMENT_ORDER.filter((letter) => letters.includes(letter));
  return chosen.length > 0 ? chosen : DEFAULT_FLOAT_PLACEMENT.letters;
}

/** True when `letter` is the only position this float will accept. */
export function onlyPlacement(placement: FloatPlacement, letter: FloatPlacementLetter): boolean {
  const order = placementOrder(placement);
  return order.length === 1 && order[0] === letter;
}

/**
 * A prepared float as one box, for the page builder to place with the same
 * `placeVertical` it uses for everything else.
 *
 * `depth` is zero and the whole of the material is `height`: a float is
 * measured as a rectangle from its top edge downwards (`PreparedFloat.height`
 * is the natural size of the list, last box's depth included), and the page
 * builder's arithmetic — reserve this much, advance by that much — is written
 * against exactly that convention.
 */
export function floatBox(float: PreparedFloat): VBox {
  return {
    kind: "vbox",
    width: float.width,
    height: float.height,
    depth: 0,
    shift: 0,
    glueSet: null,
    content: float.list,
  };
}

// --- setting one float ------------------------------------------------------

/**
 * **THE SEAM.** One float, boxed and handed to the queue: `PreparedFloat` for
 * `layout/page.ts` to place, or `null` when there is nothing to place.
 *
 * `layout/vlist.ts` parks the result on `LayoutContext.floats` under
 * `floatMarker(n)` and pushes that marker into the main vertical list, so the
 * page builder learns both *what* to place and *where the author wrote it* —
 * which is what "here" in `[h]` means, and the line a float must never be
 * placed above.
 *
 * `null` is returned only for a float whose material comes to nothing —
 * `\begin{figure}\end{figure}`, which `doc/build.ts` has already warned about
 * at its own line. It is not a silent drop: there is nothing to drop.
 */
export function prepareFloat(block: FloatBlock, ctx: FloatContext): PreparedFloat | null {
  const list: VNode[] = [];
  /*
   * The float's content in source order, with the caption set where the author
   * wrote it — a caption above the figure and a caption below it are different
   * documents, and `doc/model.ts` says so ("a caption's position is content").
   *
   * Runs of non-caption blocks go through `setBlocks` in one call so that the
   * ordinary inter-paragraph spacing between them is the vertical list's own;
   * each caption interrupts the run and is set here. The seam between a run and
   * a caption is `\abovecaptionskip`/`\belowcaptionskip`, which is exactly what
   * `\@makecaption` puts there, so nothing is lost by the split.
   */
  let run: Block[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    for (const node of ctx.setBlocks(run, ctx.measure)) list.push(node);
    run = [];
  };

  for (const child of block.content) {
    if (child.kind !== "caption") {
      run.push(child);
      continue;
    }
    flushRun();
    if (list.length > 0) list.push(glue(ABOVE_CAPTION_SKIP));
    for (const node of setCaption(child, ctx)) list.push(node);
    if (BELOW_CAPTION_SKIP > 0) list.push(glue(BELOW_CAPTION_SKIP));
  }
  flushRun();

  if (list.length === 0) return null;

  return {
    floatClass: block.floatClass,
    construct: block.construct,
    // `article` is one-column, so `figure*` and `figure` place identically.
    // The flag is carried anyway: it is the source's meaning, and a two-column
    // class would place a spanning float only at `t`/`p` of a full page.
    spanning: block.spanning,
    placement: block.placement,
    list,
    height: measureNodes(list, "v").natural,
    width: ctx.measure,
    loc: block.loc,
  };
}

/**
 * `\@makecaption`, as `article.cls` writes it:
 *
 * ```
 * \long\def\@makecaption#1#2{%
 *   \vskip\abovecaptionskip
 *   \sbox\@tempboxa{#1: #2}%
 *   \ifdim \wd\@tempboxa >\hsize
 *     #1: #2\par
 *   \else
 *     \hb@xt@\hsize{\hfil\box\@tempboxa\hfil}%
 *   \fi
 *   \vskip\belowcaptionskip}
 * ```
 *
 * The `\ifdim` is the whole of it: a caption that fits on one line is
 * **centred**, and one that does not is set as an ordinary justified paragraph.
 * Both branches are here because both are visible — a two-line caption set
 * centred, or a one-line caption set flush left, is wrong in a way a reader
 * notices immediately.
 *
 * `#1` is `\fnum@figure`, i.e. `\figurename\nobreakspace\thefigure` — the tie
 * is why "Figure" and its number never end up on different lines.
 *
 * **The caption's own marker is emitted here, inside the float's material.**
 * That is what makes `\pageref` and `\listoffigures` name the page the float
 * actually landed on rather than the page its source happened to sit on: the
 * marker travels with the box, and `page.ts` records it wherever the box is
 * placed.
 */
function setCaption(caption: CaptionBlock, ctx: FloatContext): VList {
  const size = ctx.design.sizes.normalsize;
  const inlines = captionInlines(caption);

  // The `\sbox` measurement. Setting the inlines twice in the paragraph branch
  // is the price of asking the question `\@makecaption` asks; a caption is a
  // sentence, and the second setting is far cheaper than a wrong branch.
  const oneLine = ctx.setInlines(inlines, size.size, caption.loc);
  if (measureNodes(oneLine, "h").natural <= ctx.measure) {
    const fil = (): ReturnType<typeof glue> => glue(0, 1, 0, 1, 0);
    return [hpack([fil(), ...oneLine, fil()], ctx.measure).box];
  }

  const paragraph: ParagraphBlock = {
    kind: "paragraph",
    content: inlines,
    // `\@makecaption`'s long branch is `#1: #2\par` in vertical mode with
    // `\parindent` still in force — but a caption is a label, and LaTeX's own
    // `\caption` starts it flush because `\@makecaption` is entered from
    // `\par`-ended vertical material inside the float box. Flush left reads
    // correctly and is what every caption package assumes.
    indent: false,
    loc: caption.loc,
  };
  return ctx.setBlocks([paragraph], ctx.measure);
}

/**
 * `#1: #2` — the caption's marker, `Figure~3`, a colon, and the author's text.
 *
 * A **new array**: `CaptionBlock.content` is the very same `Inline[]` that
 * `document.floatList` carries as an entry title (`doc/model.ts` says so, and
 * a `\ref` inside a caption resolving in both places at once depends on it).
 * Layout never mutates the document model — this file included.
 */
function captionInlines(caption: CaptionBlock): Inline[] {
  const at = caption.loc;
  const name = FLOAT_NAME[caption.floatClass];
  const style = DEFAULT_TEXT_STYLE;
  const out: Inline[] = [{ kind: "marker", name: caption.marker, loc: at }];
  if (caption.number === null) {
    // No number to print: the float class could not be established, which
    // `doc/build.ts` has already reported. The name and the text still set, so
    // the caption is not lost along with its number.
    out.push({ kind: "text", text: `${name}:`, style, loc: at });
  } else {
    out.push({ kind: "text", text: name, style, loc: at });
    out.push({ kind: "tie", style, loc: at });
    out.push({ kind: "text", text: `${caption.number}:`, style, loc: at });
  }
  out.push({ kind: "space", style, loc: at });
  for (const inline of caption.content) out.push(inline);
  return out;
}
