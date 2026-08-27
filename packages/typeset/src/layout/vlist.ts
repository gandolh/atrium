import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, warning } from "../diagnostics.ts";
import type { FontProvider } from "../font/handle.ts";
import type {
  AbstractBlock,
  BibliographyBlock,
  Block,
  FloatBlock,
  FloatClass,
  FloatListEntry,
  FontSelection,
  FootnoteInline,
  HeadingBlock,
  ImageInline,
  Inline,
  LatexDocument,
  ListBlock,
  ListItem,
  ParagraphBlock,
  TableBlock,
  TextStyle,
  TitleBlock,
  TocEntry,
  VerbatimBlock,
} from "../doc/model.ts";
import type { ImageContext, ImageFiles } from "../image/index.ts";
import { placeImage } from "../image/index.ts";
import type { FloatContext, PreparedFloat } from "./float.ts";
import { prepareFloat } from "./float.ts";
import type { TableContext } from "./table.ts";
import { setTable } from "./table.ts";
import type { Budget } from "../macro/budget.ts";
import { spend } from "../macro/budget.ts";
import type { FontSize, PageDesign } from "./design.ts";
import { HEADING_DESIGN, itemizeLabel, listSpacing, parseDimension, tocIndent, TOC_PAGE_NUMBER_WIDTH_EM } from "./design.ts";
import { hpack, measure as measureNodes } from "./glue.ts";
import type { Shaper, TextFace } from "./hlist.ts";
import { fontSpacing, paragraphIndent, shapeRun, spaceGlue, textToHList } from "./hlist.ts";
import type { LineBreakParams } from "./linebreak.ts";
import { breakParagraph } from "./linebreak.ts";
import type { HBox, HList, HNode, VBox, VList, VNode } from "./model.ts";
import { EJECT_PENALTY, INFINITE_PENALTY, glue, kern, penalty } from "./model.ts";

/**
 * Vertical-list assembly: a document model in, a single tall column out.
 *
 * This is where LaTeX's *page design* is applied — sizes, indents, the space
 * above a section, the bullet in front of an `itemize` item. Chunk 6 stopped at
 * meaning on purpose; every number used here comes from `design.ts`, which
 * cites the `article.cls`/`size10.clo` definition it was copied from.
 *
 * The output is one continuous `VList`, not pages: boxes (set lines), glue
 * (interline and inter-block space), penalties (where a break is welcome or
 * forbidden) and markers (where a `\label` or a footnote mark landed).
 * `page.ts` cuts it into pages afterwards, which is the same separation TeX
 * makes between the main vertical list and the page builder — and the reason
 * footnotes can be attached to the *line* that references them and still end up
 * at the foot of whatever page that line reaches.
 *
 * **Nothing here mutates the document model.** It is laid out more than once
 * (see `compile.ts`'s two-pass cycle) and the second pass must read exactly
 * what the first did, apart from the `\pageref` texts the cycle deliberately
 * rewrote.
 */

/** A footnote's material, laid out and waiting for a page to land on. */
export interface PreparedFootnote {
  number: number;
  /** The note's own vertical list, already broken into lines at `\footnotesize`. */
  list: VList;
  /** Natural height of `list`, in points. */
  height: number;
  /** Where the `\footnote` call itself sits, for a diagnostic that names it. */
  loc: SourceRef;
}

export interface LayoutContext {
  design: PageDesign;
  fonts: FontProvider;
  /**
   * One shaper for the whole document — including across layout passes. Line
   * breaking re-measures constantly and the font layer has no cache of its own.
   */
  shaper: Shaper;
  budget: Budget;
  diagnostics: Diagnostic[];
  /** The entrypoint, for diagnostics with no better position. */
  file: string;
  /**
   * `marker name → page`, from the *previous* layout pass. Empty on the first
   * pass, which is why a first-pass table of contents reads `??`.
   */
  pageOf: ReadonlyMap<string, number>;
  /** Footnotes discovered while building, keyed by the marker that carries them. */
  footnotes: Map<string, PreparedFootnote>;
  /**
   * Floats discovered while building, keyed by the marker that rides in the
   * vertical list where the author wrote them — the same mechanism as
   * `footnotes` above, which is why deferring a float needs no new node kind.
   * `layout/page.ts` (chunk 39.4) is what reads this.
   */
  floats: Map<string, PreparedFloat>;
  /**
   * The project's files, for `\includegraphics`. An image is an input like the
   * `.tex` itself (D38): the engine opens nothing, so the bytes have to be
   * handed in. Empty when a caller lays out without them, which every image
   * then reports as a missing file rather than guessing a size.
   */
  files: ImageFiles;
  /** Image paths already reported as unusable, so one bad file is one diagnostic. */
  reportedImages: Set<string>;
  /** Faces already reported as missing, so one absent face is one diagnostic. */
  missingFaces: Set<string>;
  /** `font id + codepoint` pairs already reported missing, so one is one diagnostic. */
  missingGlyphs: Set<string>;
}

export function createLayoutContext(
  design: PageDesign,
  fonts: FontProvider,
  shaper: Shaper,
  budget: Budget,
  diagnostics: Diagnostic[],
  file: string,
  pageOf: ReadonlyMap<string, number>,
  /**
   * The project's files, for `\includegraphics`. Optional so a caller that
   * lays out text alone (`test/fidelity.test.ts` does) needs no file map;
   * `compile()` always passes the real one.
   */
  files: ImageFiles = {},
): LayoutContext {
  const missingGlyphs = new Set<string>();
  return {
    design,
    fonts,
    shaper: withGlyphCoverageCheck(shaper, file, diagnostics, missingGlyphs),
    budget,
    diagnostics,
    file,
    pageOf,
    footnotes: new Map(),
    floats: new Map(),
    files,
    reportedImages: new Set(),
    missingFaces: new Set(),
    missingGlyphs,
  };
}

/**
 * Glyph id `0` is `.notdef` by OpenType construction — not a guess about this
 * particular font, a fact about the format (see `FontkitSubset.includeGlyph`'s
 * doc comment in `pdf/fontkit-types.ts`: "ids are handed out in call order
 * starting at 1; 0 is `.notdef`"). Shaping a character the face has no glyph
 * for silently produces one of these, which renders as nothing: without this
 * check, `"中"` in an otherwise-Latin document compiles to a clean-looking
 * blank with no trace anywhere that anything went wrong — exactly the
 * silently-wrong-output case D38 exists to rule out.
 *
 * Wrapping `Shaper` itself, rather than checking after each of the ten-odd
 * call sites in this file, is deliberate: automatic hyphenation re-shapes
 * syllable fragments from inside `hyphenate.ts`/`linebreak.ts` — files this
 * chunk does not own and cannot instrument at their own call sites — but
 * every one of those re-shapes still goes through this same function, since
 * once wrapped it *is* `ctx.shaper`. This is also why the diagnostic's
 * position is whole-document (`{ file, line: 0 }`, the same fallback
 * `resolveFace` uses below): `Shaper`'s signature is `(style, text) =>
 * ShapedText`, with no source location to attach, and changing that
 * signature would ripple into every module that calls a `Shaper` — squarely
 * the kind of cross-module contract this chunk was told to leave alone.
 *
 * Severity is `warning`, deliberately lighter than `missing-font`'s `error`:
 * a whole face being unavailable can blank out most of a document, but one
 * uncovered character is a narrow, local defect, much closer in kind to
 * `overfull-box`/`underfull-box` (also `warning`) than to losing a face
 * outright. `hasErrors()` gating PDF output on this would refuse an
 * otherwise-fine document over a single exotic character, which is a worse
 * outcome than shipping the document with a loud, precise note about the one
 * character that did not make it in.
 *
 * The diagnostic code is `missing-font`, not a new one: the underlying
 * problem is the same shape ("this face cannot show this text"), just
 * narrowed from a whole face down to one character. `DiagnosticCode` is a
 * closed union in `@ebook-reader/shared`, a different package the API and
 * editor also depend on — widening it is a cross-package contract change,
 * outside what this chunk should decide unilaterally.
 */
function withGlyphCoverageCheck(
  shaper: Shaper,
  file: string,
  diagnostics: Diagnostic[],
  reported: Set<string>,
): Shaper {
  return (style, text) => {
    const shaped = shaper(style, text);
    for (const g of shaped.glyphs) {
      if (g.id !== 0) continue;
      const codePoint = text.codePointAt(g.cluster) ?? text.charCodeAt(g.cluster);
      const key = `${style.font.id} ${codePoint}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const char = String.fromCodePoint(codePoint);
      const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
      diagnostics.push(
        warning(
          "missing-font",
          { file, line: 0 },
          `"${char}" (U+${hex}) has no glyph in ${style.font.id}; it does not appear in the output`,
          char,
        ),
      );
    }
    return shaped;
  };
}

/** The marker emitted beside a footnote's mark; the page builder keys inserts off it. */
export function footnoteMarker(number: number): string {
  return `footnote:${number}`;
}

/**
 * The marker left in the vertical list where a float was written (0-based, in
 * the order the floats were reached). The page builder reads
 * `LayoutContext.floats` under this name to learn what to place and, for `[h]`,
 * where the author wanted it.
 */
export function floatMarker(index: number): string {
  return `float:${index}`;
}

/** What `\pageref` and the table of contents print for a page nobody recorded. */
const UNKNOWN_PAGE = "??";

// --- the column -------------------------------------------------------------

/**
 * A vertical list under construction, plus TeX's `\prevdepth` — the depth of
 * the last box appended, which is what interline glue is computed from.
 */
interface Column {
  list: VNode[];
  /** `null` is TeX's `ignore_depth`: no interline glue before the next box. */
  prevDepth: number | null;
  /**
   * Nodes to splice in front of the next box appended. A list item's label
   * arrives this way, because the label belongs beside whatever line the item's
   * content happens to start with — which may be a nested list's first item.
   */
  pendingPrefix: HNode[] | null;
  /**
   * `\@afterindentfalse`: the next paragraph is set flush left.
   *
   * In LaTeX this is a *class* decision, not a document one — `article.cls`
   * writes `\@startsection`'s beforeskip negative, which is the spelling of
   * "do not indent the paragraph after this heading" — so it is applied here
   * rather than in the document model. A list item's first paragraph is flush
   * for the same reason: its label already occupies the indent.
   */
  suppressIndent: boolean;
  design: PageDesign;
}

function newColumn(design: PageDesign): Column {
  return { list: [], prevDepth: null, pendingPrefix: null, suppressIndent: false, design };
}

/**
 * Append a box, inserting TeX's interline glue first (§679): enough to put this
 * box's baseline `\baselineskip` below the previous one, or `\lineskip` when
 * the two boxes are too tall for that to leave `\lineskiplimit` between them.
 *
 * `left` displaces the box from the text body's left edge. It is expressed as a
 * kern inside a wrapper box rather than as `HBox.shift`, because `shift` means
 * *vertical* displacement in a horizontal list and reusing it for horizontal
 * displacement in a vertical one is exactly the kind of convention that reads
 * fine and places text 25 points off.
 */
function pushBox(col: Column, box: HBox | VBox, baselineSkip: number, left: number): void {
  const prefix = col.pendingPrefix;
  col.pendingPrefix = null;

  // `HBox | VBox` because a `tabular` (chunk 39.3) and a float (chunk 39.4) are
  // vertical boxes appended exactly as a set line is; every field read below is
  // common to both, and `hpack` already takes either as horizontal material.
  let placed: HBox | VBox = box;
  if (prefix !== null) {
    placed = hpack([...prefix, box], "natural").box;
  } else if (left !== 0) {
    placed = hpack([kern(left), box], "natural").box;
  }

  if (col.prevDepth !== null) {
    const gap = baselineSkip - col.prevDepth - placed.height;
    col.list.push(gap < col.design.lineSkipLimit ? glue(col.design.lineSkip) : glue(gap));
  }
  col.list.push(placed);
  col.prevDepth = placed.depth;
}

function pushGlue(col: Column, natural: number, stretch = 0, shrink = 0): void {
  if (natural === 0 && stretch === 0 && shrink === 0) return;
  col.list.push(glue(natural, stretch, shrink));
}

/**
 * LaTeX's `\addvspace`: the space *and* whatever glue already sits at the end
 * of the list collapse to the larger of the two. Without it, a section that
 * follows a list gets the list's closing `\topsep` plus its own `beforeskip`
 * and floats visibly too far down the page.
 */
function addVspace(col: Column, natural: number, stretch = 0, shrink = 0): void {
  const last = col.list[col.list.length - 1];
  if (last !== undefined && last.kind === "glue") {
    if (last.natural >= natural) return;
    col.list.pop();
  }
  pushGlue(col, natural, stretch, shrink);
}

function pushPenalty(col: Column, value: number): void {
  col.list.push(penalty(value));
}

// --- fonts ------------------------------------------------------------------

/**
 * Resolve a document-level face selection at a chosen size.
 *
 * Returns `null` when the provider has no such face, after reporting it once.
 * **Never substitutes**: a document set in the wrong face is a worse outcome
 * than a document that refuses to compile, because nothing downstream can tell
 * the difference (D38).
 */
function resolveFace(ctx: LayoutContext, selection: FontSelection, size: number): TextFace | null {
  const handle = ctx.fonts.get(selection);
  if (handle === undefined) {
    const key = `${selection.family}/${selection.weight}/${selection.slant}`;
    if (!ctx.missingFaces.has(key)) {
      ctx.missingFaces.add(key);
      ctx.diagnostics.push(
        error(
          "missing-font",
          { file: ctx.file, line: 0 },
          `no ${selection.weight} ${selection.slant} ${selection.family} face is available; the text set in it is missing from the output`,
        ),
      );
    }
    return null;
  }
  return { font: handle, size };
}

// --- horizontal material ----------------------------------------------------

interface InlineOptions {
  /** Point size for every run in this list. */
  size: number;
  /** Where this material came from, for diagnostics. */
  at: SourceRef;
  /**
   * `false` where a note's text has nowhere to go: inside another footnote
   * (LaTeX does not nest footnotes either — `\footnote` within `\footnote`
   * needs a package such as `bigfoot`), and inside an `\item[...]` label.
   */
  allowFootnotes: boolean;
  /**
   * The construct that refused, phrased to follow "a `\footnote` …" — read
   * only when `allowFootnotes` is false, so the refusal names the real reason
   * instead of assuming one.
   */
  footnotesRefusedIn?: string;
  /** Nodes placed before the first inline — a footnote's mark, a section number. */
  prefix?: HNode[];
}

/**
 * A flat inline list as a horizontal list.
 *
 * Runs of text and the spaces between them are accumulated into one string per
 * style and handed to `textToHList` in one piece. That is not an optimisation:
 * `textToHList` implements TeX's `\sfcode` sentence spacing, which needs to see
 * the character *before* a space to know how wide the space is, and splitting
 * every word into its own call would set `dog. The` with an ordinary interword
 * space. A style change flushes the run, so `\textbf{Dr.} Who` loses the extra
 * space — as it does in LaTeX, for the same reason.
 */
function inlinesToHList(inlines: readonly Inline[], ctx: LayoutContext, opts: InlineOptions): HList {
  const out: HList = [];
  for (const node of opts.prefix ?? []) out.push(node);

  // A record rather than two `let`s: the accumulator is written from inside the
  // two closures below, and TypeScript's flow analysis would otherwise keep
  // narrowing `style` to `null` from its initialiser and refuse to read it.
  const run: { style: TextStyle | null; text: string } = { style: null, text: "" };

  const flush = (): void => {
    if (run.style !== null && run.text !== "") {
      appendStyledText(out, run.text, run.style, ctx, opts.size);
    }
    run.text = "";
    run.style = null;
  };
  const append = (text: string, style: TextStyle): void => {
    if (run.style !== null && !sameStyle(run.style, style)) flush();
    run.style = style;
    run.text += text;
  };

  for (const inline of inlines) {
    if (!spend(ctx.budget)) break;
    switch (inline.kind) {
      case "text":
        append(inline.text, inline.style);
        break;
      case "reference":
        // Read at shaping time, never captured earlier: the two-pass cycle
        // rewrites `text` in place between passes and the second pass has to
        // see the rewrite.
        append(inline.text, inline.style);
        break;
      case "space": {
        // The space is set in the font *before* it — that is the font TeX
        // would have used and the one whose space factor applies — but it
        // takes its own underlining, so `\underline{a} b` does not draw a rule
        // under the space that follows the group.
        const before = run.style;
        append(" ", before === null ? inline.style : { font: before.font, underline: inline.style.underline });
        break;
      }
      case "tie": {
        flush();
        const face = resolveFace(ctx, inline.style.font, opts.size);
        if (face === null) break;
        // `~` is an ordinary interword space that may not be broken at.
        out.push(penalty(INFINITE_PENALTY));
        out.push(spaceGlue(fontSpacing(face, ctx.shaper)));
        break;
      }
      case "linebreak":
        flush();
        // LaTeX's `\\` is `\newline`, which is `\hfil\break`: without the
        // `\hfil` the line before the break would be justified to the full
        // measure and the spaces stretched across it.
        out.push(glue(0, 1, 0, 1, 0));
        out.push(penalty(EJECT_PENALTY));
        break;
      case "marker":
        flush();
        out.push({ kind: "marker", name: inline.name });
        break;
      case "footnote":
        flush();
        appendFootnote(out, inline, ctx, opts);
        break;
      case "citation":
        // Read at shaping time for the same reason a `\ref` is: the
        // bibliography pass rewrites `text` in place, and `\nocite` leaves it
        // empty on purpose because it sets nothing.
        if (inline.text !== "") append(inline.text, inline.textStyle);
        break;
      case "image":
        flush();
        appendImage(out, inline, ctx, opts);
        break;
    }
  }
  flush();
  return out;
}

/**
 * `\includegraphics`, placed — or not, in which case nothing is added and the
 * seam has said why. An image takes part in line breaking as a single
 * unbreakable box, exactly as `\underline`'s does.
 */
function appendImage(out: HList, image: ImageInline, ctx: LayoutContext, opts: InlineOptions): void {
  const box = placeImage(image, imageContext(ctx, opts.size, ctx.design.textWidth));
  if (box === null) return;
  out.push(box);
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return (
    a.underline === b.underline &&
    a.font.family === b.font.family &&
    a.font.weight === b.font.weight &&
    a.font.slant === b.font.slant
  );
}

/** TeX's default rule thickness; `\underline` draws with it at every size. */
const RULE_THICKNESS = 0.4;

function appendStyledText(
  out: HList,
  text: string,
  style: TextStyle,
  ctx: LayoutContext,
  size: number,
): void {
  const face = resolveFace(ctx, style.font, size);
  if (face === null) return;
  const nodes = textToHList(text, face, { shaper: ctx.shaper });
  if (!style.underline) {
    for (const node of nodes) out.push(node);
    return;
  }
  // `\underline` makes an unbreakable box in LaTeX too, so the rule is drawn
  // once under the whole run and the run cannot be split across lines. The rule
  // is placed by backing the pen up over the text: it has negative height, so
  // it is drawn *below* the baseline (`page.ts` reads a rule's `y` as its top).
  const inner = hpack(nodes, "natural").box;
  const drop = 0.12 * size;
  out.push(
    hpack(
      [
        inner,
        kern(-inner.width),
        { kind: "rule", width: inner.width, height: -drop, depth: drop + RULE_THICKNESS },
      ],
      "natural",
    ).box,
  );
}

/**
 * The footnote's *mark*, plus the marker that tells the page builder which line
 * carries it. The note's own text is laid out here too and parked in
 * `ctx.footnotes`; where it ends up is a page-breaking question.
 *
 * When the surrounding material refuses footnotes (`allowFootnotes: false` —
 * a footnote's own text, or an `\item[...]` label), the mark is still set so
 * the reference does not silently vanish, but nothing is registered: no note
 * to place, and therefore no marker, because the marker's only job is to tell
 * the page builder which line a note has to follow. The refusal is reported
 * with `opts.footnotesRefusedIn` naming the construct that did the refusing,
 * so the diagnostic says something true rather than guessing at the cause.
 */
function appendFootnote(out: HList, note: FootnoteInline, ctx: LayoutContext, opts: InlineOptions): void {
  const name = footnoteMarker(note.number);
  if (opts.allowFootnotes) out.push({ kind: "marker", name });

  const face = resolveFace(ctx, note.style.font, ctx.design.sizes.scriptsize.size);
  if (face !== null) {
    const mark = hpack([shapeRun(face, note.label, ctx.shaper)], "natural").box;
    // `\@makefnmark` sets the mark as a superscript. `HBox.shift` is a raise in
    // a horizontal list, negative upwards.
    mark.shift = -SUPERSCRIPT_RAISE * opts.size;
    out.push(mark);
  }

  if (!opts.allowFootnotes) {
    const where = opts.footnotesRefusedIn ?? "in material that cannot carry one";
    ctx.diagnostics.push(
      warning(
        "unsupported",
        note.loc,
        `a \\footnote ${where}: the mark is set where it stands, but this engine does not place the note's text at the foot of any page`,
        "\\footnote",
      ),
    );
    return;
  }
  if (ctx.footnotes.has(name)) return;
  ctx.footnotes.set(name, prepareFootnote(note, ctx));
}

/**
 * How far a footnote mark is raised, as a fraction of the surrounding type
 * size. LaTeX gets this from the maths superscript parameters of the current
 * family; 0.35em reproduces Computer Modern's text superscript closely enough
 * that the mark clears the x-height without touching the line above.
 */
const SUPERSCRIPT_RAISE = 0.35;

// --- paragraphs -------------------------------------------------------------

/** Everything a block needs to know about the column it is being set into. */
interface BlockEnv {
  /** Line width, in points. */
  measure: number;
  /** Displacement of this material from the text body's left edge. */
  left: number;
  /** The body size in force — `\normalsize` outside anything special. */
  size: FontSize;
  /** `\parindent` in force. */
  parIndent: number;
  /** Vertical space between paragraphs: `\parskip`, or a list's `\parsep`. */
  parSkip: number;
  parSkipStretch: number;
  /**
   * `\parskip` has no shrink component in `latex.ltx` (`0pt plus 1pt`), but a
   * list's `\parsep` does — `4pt plus2pt minus1pt` at depth 1 — so the shrink
   * is carried separately rather than being assumed symmetric with the stretch.
   */
  parSkipShrink: number;
  /** Nesting depth of enclosing lists, for `size10.clo`'s spacing tables. */
  listDepth: number;
  allowFootnotes: boolean;
  /** `InlineOptions.footnotesRefusedIn`, carried down to every inline list. */
  footnotesRefusedIn?: string;
}

function bodyEnv(design: PageDesign): BlockEnv {
  return {
    measure: design.textWidth,
    left: 0,
    size: design.sizes.normalsize,
    parIndent: design.parIndent,
    parSkip: 0,
    parSkipStretch: design.parSkipStretch,
    parSkipShrink: 0,
    listDepth: 0,
    allowFootnotes: true,
  };
}

function breakOptions(ctx: LayoutContext, at: SourceRef, extra: Partial<LineBreakParams> = {}): Partial<LineBreakParams> {
  return {
    at,
    shaper: ctx.shaper,
    // Plain TeX sets `\hyphenchar\tt=-1`: a hyphen inserted into typewriter
    // text reads as part of the code rather than as a line break.
    hyphenateFont: (font) => !font.id.startsWith("lmmono"),
    ...extra,
  };
}

/** Break `hlist` and append the lines, honouring TeX's club and widow penalties. */
function pushParagraph(col: Column, ctx: LayoutContext, hlist: HList, env: BlockEnv, at: SourceRef): void {
  const result = breakParagraph(hlist, env.measure, breakOptions(ctx, at));
  for (const d of result.diagnostics) ctx.diagnostics.push(d);
  spend(ctx.budget, result.steps);

  const { clubPenalty, widowPenalty } = col.design;
  for (let i = 0; i < result.lines.length; i++) {
    const line = result.lines[i] as HBox;
    pushBox(col, line, env.size.baselineSkip, env.left);
    if (result.lines.length <= 2) continue;
    // §890: discourage leaving the first line of a paragraph alone at the foot
    // of a page (club) or its last line alone at the head of the next (widow).
    if (i === 0) pushPenalty(col, clubPenalty);
    else if (i === result.lines.length - 2) pushPenalty(col, widowPenalty);
  }
}

function layoutParagraph(block: ParagraphBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const indent = block.indent && !col.suppressIndent;
  col.suppressIndent = false;
  const prefix: HNode[] = indent ? [paragraphIndent(env.parIndent)] : [];
  const hlist = inlinesToHList(block.content, ctx, {
    size: env.size.size,
    at: block.loc,
    allowFootnotes: env.allowFootnotes,
    footnotesRefusedIn: env.footnotesRefusedIn,
    prefix,
  });
  if (hlist.length === prefix.length) return;
  pushParagraph(col, ctx, hlist, env, block.loc);
}

// --- headings ---------------------------------------------------------------

function layoutHeading(block: HeadingBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const design = ctx.design;
  const spec = HEADING_DESIGN[block.level];
  const size = design.sizes[spec.size];
  const ex = (parseDimension("1ex", design.sizes.normalsize.size) ?? 0);

  pushPenalty(col, design.secPenalty);
  addVspace(col, spec.beforeEx * ex, ex / 2, ex / 5);

  const prefix: HNode[] = [{ kind: "marker", name: block.marker }];
  if (block.number !== null) {
    const numberStyle = block.title[0]?.kind === "text" ? block.title[0].style : null;
    const face = resolveFace(
      ctx,
      numberStyle?.font ?? { family: "serif", weight: "bold", slant: "upright" },
      size.size,
    );
    if (face !== null) {
      prefix.push(shapeRun(face, block.number, ctx.shaper));
      // `\@seccntformat` is `\thesection\quad`; `\quad` is 1em at the heading's
      // own size, which is why a `\Large` section number sits further out.
      prefix.push(kern(size.size));
    }
  }
  const hang = measureNodes(prefix, "h").natural;

  const hlist = inlinesToHList(block.title, ctx, {
    size: size.size,
    at: block.loc,
    allowFootnotes: env.allowFootnotes,
    footnotesRefusedIn: env.footnotesRefusedIn,
    prefix,
  });
  const headingEnv: BlockEnv = { ...env, size };
  // Headings are set ragged right: a two-word `\section` justified to the
  // measure would have a hand's width of space in the middle of it.
  const result = breakParagraph(
    hlist,
    hang > 0 ? [env.measure, env.measure - hang] : env.measure,
    breakOptions(ctx, block.loc, { rightSkip: glue(0, 1, 0, 1, 0) }),
  );
  for (const d of result.diagnostics) ctx.diagnostics.push(d);
  spend(ctx.budget, result.steps);
  for (let i = 0; i < result.lines.length; i++) {
    pushBox(col, result.lines[i] as HBox, headingEnv.size.baselineSkip, env.left + (i === 0 ? 0 : hang));
  }

  // `\@afterheading`'s `\nobreak`: a heading is never the last thing on a page.
  pushPenalty(col, INFINITE_PENALTY);
  addVspace(col, spec.afterEx * ex, ex / 5, 0);
}

/**
 * `\paragraph`'s afterskip is `-1em` in `article.cls` — negative, unlike
 * every other level's. That sign is not a magnitude to negate and use as a
 * vertical skip (which is what this engine did before this fix): in real
 * `\@startsection`'s `\@sect`/`\@xsect` (classes.dtx), a non-positive
 * afterskip takes an entirely different branch. Instead of setting the
 * title on its own line and adding `\vskip`, it stores the title as
 * `\@svsechd` and splices it onto `\everypar`, so it becomes the *leading
 * material of whatever paragraph comes textually next* — a run-in heading,
 * with no line break and no vertical space between title and body. There is
 * no synthetic gap baked into that splice beyond `\@svsechd`'s own
 * `\hskip\parindent` before the title (`\paragraph`'s indent argument is
 * literally `\parindent`) — whatever separates the bold title from the body
 * text is just whatever the author typed there, almost always one space,
 * which is why this merges in a single ordinary interword space rather than
 * a fixed kern.
 *
 * Only called when a `ParagraphBlock` genuinely follows in the block list —
 * the shape a real `\paragraph{...} text...` document produces. `\parindent`
 * is applied unconditionally, matching `\@svsechd`'s unconditional
 * `\hskip\parindent`, not `env`'s usual "is this paragraph indented" logic.
 */
function layoutRunInParagraph(
  heading: HeadingBlock,
  next: ParagraphBlock,
  col: Column,
  ctx: LayoutContext,
  env: BlockEnv,
): void {
  const design = ctx.design;
  const spec = HEADING_DESIGN[heading.level];
  const size = design.sizes[spec.size];
  const ex = parseDimension("1ex", design.sizes.normalsize.size) ?? 0;

  pushPenalty(col, design.secPenalty);
  addVspace(col, spec.beforeEx * ex, ex / 2, ex / 5);

  const prefix: HNode[] = [paragraphIndent(env.parIndent), { kind: "marker", name: heading.marker }];
  if (heading.number !== null) {
    const numberStyle = heading.title[0]?.kind === "text" ? heading.title[0].style : null;
    const face = resolveFace(
      ctx,
      numberStyle?.font ?? { family: "serif", weight: "bold", slant: "upright" },
      size.size,
    );
    if (face !== null) {
      prefix.push(shapeRun(face, heading.number, ctx.shaper));
      prefix.push(kern(size.size));
    }
  }

  // The font this space actually renders in is whatever ran immediately
  // before it (the bold title) — see `inlinesToHList`'s "space" case — so
  // `style.font` here is never read; only `style.underline` is.
  const gap: Inline = {
    kind: "space",
    style: { font: { family: "serif", weight: "regular", slant: "upright" }, underline: false },
    loc: heading.loc,
  };
  const combined: Inline[] = [...heading.title, gap, ...next.content];

  // `paragraph`'s own rung is `normalsize` — the same as the body — so the
  // merged material never needs a size change mid-run, only the weight
  // change each inline's own style already carries.
  const hlist = inlinesToHList(combined, ctx, {
    size: env.size.size,
    at: heading.loc,
    allowFootnotes: env.allowFootnotes,
    footnotesRefusedIn: env.footnotesRefusedIn,
    prefix,
  });
  pushParagraph(col, ctx, hlist, env, heading.loc);
}

// --- lists ------------------------------------------------------------------

/**
 * Emit a label that never found a box to sit beside, on a line of its own.
 *
 * `col.pendingPrefix` holds an `\item`'s label until the first box of the
 * item's body comes along for it to hang beside. Two things can mean that box
 * never arrives: an item with an empty body, and — the case this exists for —
 * an item whose body *starts with a nested list*, whose own first `\item`
 * would otherwise overwrite the outstanding label and lose it silently.
 *
 * Real LaTeX puts the outer label on a line of its own there: `\item` starts
 * a paragraph, the nested `\list` ends it (`\par` inside `\@trivlist`), and
 * that paragraph — the label and nothing else — is set before the inner list's
 * `\topsep` opens. Hence the flush at the top of `layoutList`, ahead of its
 * own vertical space, rather than at the point of overwrite.
 */
function flushPendingPrefix(col: Column, baselineSkip: number): void {
  const prefix = col.pendingPrefix;
  if (prefix === null) return;
  col.pendingPrefix = null;
  pushBox(col, hpack(prefix, "natural").box, baselineSkip, 0);
}

function layoutList(block: ListBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  // `env` is the *enclosing* environment — an outer item's, when this list is
  // nested inside one — so this sets the stranded label at the size and
  // baseline the item it belongs to is being set at.
  flushPendingPrefix(col, env.size.baselineSkip);
  const spacing = listSpacing(ctx.design, block.depth);
  addVspace(col, spacing.topSep, spacing.topStretch, spacing.topShrink);

  const inner: BlockEnv = {
    ...env,
    measure: env.measure - spacing.leftMargin,
    left: env.left + spacing.leftMargin,
    parSkip: spacing.parSep,
    parSkipStretch: spacing.parStretch,
    parSkipShrink: spacing.parShrink,
    listDepth: block.depth,
  };

  for (let i = 0; i < block.items.length; i++) {
    if (!spend(ctx.budget)) break;
    // `\itemsep` with its own stretch and shrink from `size10.clo` — which are
    // asymmetric (`4pt plus2pt minus1pt` at depth 1), so neither is a function
    // of the other or of `\parsep`.
    if (i > 0) addVspace(col, spacing.itemSep, spacing.itemStretch, spacing.itemShrink);
    layoutItem(block, block.items[i] as ListItem, col, ctx, inner, spacing.labelWidth, spacing.labelSep);
  }

  addVspace(col, spacing.topSep, spacing.topStretch, spacing.topShrink);
}

function layoutItem(
  block: ListBlock,
  item: ListItem,
  col: Column,
  ctx: LayoutContext,
  env: BlockEnv,
  labelWidth: number,
  labelSep: number,
): void {
  if (block.variant === "description") {
    col.suppressIndent = true;
    layoutDescriptionItem(item, col, ctx, env, labelWidth + labelSep);
    col.suppressIndent = false;
    return;
  }

  const label = itemLabel(block, item, ctx, env.size.size);
  if (label !== null) {
    // `\makelabel` is `\hbox to\labelwidth{\hss #1}` followed by `\labelsep`:
    // right-aligned in the margin, and `\hss` rather than `\hfil` so an
    // over-wide label sticks out instead of being reported overfull.
    const box = hpack([glue(0, 1, 1, 1, 1), label], labelWidth).box;
    col.pendingPrefix = [kern(env.left - labelWidth - labelSep), box, kern(labelSep)];
  }

  col.suppressIndent = true;
  layoutBlocks(item.content, col, ctx, env);
  col.suppressIndent = false;
  // An item whose body produced nothing would strand the label; emit it alone.
  flushPendingPrefix(col, env.size.baselineSkip);
}

/**
 * `description` in `article.cls`:
 * ```
 * \newenvironment{description}
 *                {\list{}{\labelwidth\z@ \itemindent-\leftmargin
 *                         \let\makelabel\descriptionlabel}}
 *                {\endlist}
 * \newcommand*\descriptionlabel[1]{\hspace\labelsep \normalfont\bfseries #1}
 * ```
 * `\itemindent -\leftmargin` pulls the *whole first line* of the item back
 * by exactly `leftMargin` — to the list's enclosing margin, one full
 * `\leftmargin` left of where the item's own text sits (`env.left`) — while
 * every line the term's paragraph wraps onto returns to `env.left`, same
 * shape as itemize/enumerate's hanging bullet/number. That first line is
 * therefore `leftMargin` *wider* too, so it still ends at the same right
 * margin as every other line: `breakParagraph` gets `env.measure +
 * leftMargin` for line 0 and plain `env.measure` from line 1 on.
 *
 * A previous pass deliberately did not do this — set at `env.left` instead,
 * see the old comment this replaced — reasoning that a long term could then
 * collide with whatever text sits just above the item. That risk is real,
 * but it is `article.cls`'s own risk, not one this engine would be
 * introducing: a long `description` term overrunning into the line above is
 * a known, if unloved, property of real LaTeX's `description` (authors hit
 * it and reach for `\item[Short term:]` or similar). Chunk 8's brief is to
 * match `article.cls` where "verify against the real definition" settles the
 * question, and it settles this one unambiguously — so this now does what
 * `\itemindent -\leftmargin` actually does, warts included, rather than a
 * gentler substitute LaTeX itself does not offer.
 */
function layoutDescriptionItem(
  item: ListItem,
  col: Column,
  ctx: LayoutContext,
  env: BlockEnv,
  leftMargin: number,
): void {
  const merged = runInLabel(item, item.content);
  const first = merged[0];
  const rest = merged.slice(1);

  if (first === undefined || first.kind !== "paragraph") {
    layoutBlocks(merged, col, ctx, env);
    return;
  }

  // `runInLabel` always marks its merged/synthetic paragraph `indent: false`
  // (the run-in term takes the place of any `\parindent` box), so there is
  // never a `paragraphIndent` prefix to add here — `\itemindent` positions
  // the line directly.
  const hlist = inlinesToHList(first.content, ctx, {
    size: env.size.size,
    at: first.loc,
    allowFootnotes: env.allowFootnotes,
    footnotesRefusedIn: env.footnotesRefusedIn,
  });
  if (hlist.length > 0) {
    const result = breakParagraph(hlist, [env.measure + leftMargin, env.measure], breakOptions(ctx, first.loc));
    for (const d of result.diagnostics) ctx.diagnostics.push(d);
    spend(ctx.budget, result.steps);
    for (let i = 0; i < result.lines.length; i++) {
      pushBox(col, result.lines[i] as HBox, env.size.baselineSkip, env.left + (i === 0 ? -leftMargin : 0));
    }
  }
  layoutBlocks(rest, col, ctx, env);
}

function itemLabel(block: ListBlock, item: ListItem, ctx: LayoutContext, size: number): HBox | null {
  if (item.label === null) {
    // `\labelitemi`..`\labelitemiv`, chosen by `variantDepth` because LaTeX's
    // `\@itemdepth` counts only `itemize`s.
    const face = resolveFace(ctx, { family: "serif", weight: "regular", slant: "upright" }, size);
    if (face === null) return null;
    return hpack([shapeRun(face, itemizeLabel(block.variantDepth), ctx.shaper)], "natural").box;
  }
  const nodes = inlinesToHList(item.label, ctx, {
    size,
    at: item.loc,
    allowFootnotes: false,
    footnotesRefusedIn: "in a list item's own \\item[...] label",
  });
  if (nodes.length === 0) return null;
  return hpack(nodes, "natural").box;
}

/** `description`: prepend the term to the item's first paragraph, without mutating it. */
function runInLabel(item: ListItem, content: readonly Block[]): Block[] {
  const label = item.label;
  if (label === null || label.length === 0) return content.slice();
  const first = content[0];
  const gap: Inline = {
    kind: "space",
    style: (label[label.length - 1] as Inline & { style?: TextStyle }).style ?? {
      font: { family: "serif", weight: "bold", slant: "upright" },
      underline: false,
    },
    loc: item.loc,
  };
  if (first === undefined || first.kind !== "paragraph") {
    return [{ kind: "paragraph", content: [...label, gap], indent: false, loc: item.loc }, ...content];
  }
  const merged: ParagraphBlock = {
    ...first,
    content: [...label, gap, ...first.content],
    indent: false,
  };
  return [merged, ...content.slice(1)];
}

// --- verbatim ---------------------------------------------------------------

function layoutVerbatim(block: VerbatimBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const spacing = listSpacing(ctx.design, Math.max(env.listDepth, 1));
  addVspace(col, spacing.topSep, spacing.topStretch, spacing.topShrink);

  const face = resolveFace(ctx, { family: "mono", weight: "regular", slant: "upright" }, env.size.size);
  if (face === null) return;

  for (const line of block.lines) {
    if (!spend(ctx.budget)) break;
    // Shaped whole, spaces included: `verbatim` is the one place where a space
    // really is a glyph with a fixed advance and not stretchable glue.
    const nodes: HNode[] = line === "" ? [strut(env.size)] : [shapeRun(face, line, ctx.shaper)];
    const box = hpack(nodes, "natural").box;
    if (box.width > env.measure + ctx.design.lineSkip) {
      ctx.diagnostics.push(
        warning(
          "overfull-box",
          block.loc,
          `verbatim line overflows the measure by ${(box.width - env.measure).toFixed(2)}pt; verbatim text is never broken`,
          "verbatim",
        ),
      );
    }
    pushBox(col, box, env.size.baselineSkip, env.left);
  }

  addVspace(col, spacing.topSep, spacing.topStretch, spacing.topShrink);
}

/** TeX's `\strut`: an invisible box that gives an empty line its full height. */
function strut(size: FontSize): HBox {
  return {
    kind: "hbox",
    width: 0,
    height: 0.7 * size.baselineSkip,
    depth: 0.3 * size.baselineSkip,
    shift: 0,
    glueSet: null,
    content: [],
  };
}

// --- title, abstract, table of contents -------------------------------------

/** `\centering`: `\leftskip` and `\rightskip` both `0pt plus 1fil`, `\parfillskip` zero. */
function pushCentred(
  col: Column,
  ctx: LayoutContext,
  inlines: readonly Inline[],
  env: BlockEnv,
  size: FontSize,
  at: SourceRef,
): void {
  const hlist = inlinesToHList(inlines, ctx, {
    size: size.size,
    at,
    allowFootnotes: env.allowFootnotes,
    footnotesRefusedIn: env.footnotesRefusedIn,
  });
  while (hlist.length > 0 && (hlist[hlist.length - 1] as HNode).kind === "glue") hlist.pop();
  if (hlist.length === 0) return;
  const fil = glue(0, 1, 0, 1, 0);
  const result = breakParagraph(
    hlist,
    env.measure,
    breakOptions(ctx, at, { leftSkip: fil, rightSkip: fil, finish: false }),
  );
  for (const d of result.diagnostics) ctx.diagnostics.push(d);
  spend(ctx.budget, result.steps);
  for (const line of result.lines) pushBox(col, line, size.baselineSkip, env.left);
}

function layoutTitle(block: TitleBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const sizes = ctx.design.sizes;
  const em = sizes.normalsize.size;
  // `\@maketitle`: `\null\vskip 2em`, `\LARGE` title, `\vskip 1.5em`,
  // `\large` author, `\vskip 1em`, `\large` date, then `\vskip 1.5em`. The
  // `\null` is load-bearing: glue at the very top of a page is discarded, so
  // without a box in front of it the 2em would vanish and the title would sit
  // hard against the top margin.
  pushBox(col, hpack([], "natural").box, env.size.baselineSkip, env.left);
  addVspace(col, 2 * em);
  pushCentred(col, ctx, block.title, env, sizes.LARGE, block.loc);
  pushGlue(col, 1.5 * em);
  pushCentred(col, ctx, block.author, env, sizes.large, block.loc);
  if (block.date !== null) {
    pushGlue(col, 1 * em);
    pushCentred(col, ctx, block.date, env, sizes.large, block.loc);
  }
  pushGlue(col, 1.5 * em);
}

function layoutAbstract(block: AbstractBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const sizes = ctx.design.sizes;
  const em = sizes.normalsize.size;
  addVspace(col, em);
  pushCentred(
    col,
    ctx,
    [
      {
        kind: "text",
        text: "Abstract",
        style: { font: { family: "serif", weight: "bold", slant: "upright" }, underline: false },
        loc: block.loc,
      },
    ],
    { ...env, size: sizes.small },
    sizes.small,
    block.loc,
  );
  pushGlue(col, 0.5 * em);
  // `\quotation`: indented by `\leftmargin` on both sides, set `\small`.
  const quoted = listSpacing(ctx.design, 1).leftMargin;
  layoutBlocks(block.content, col, ctx, {
    ...env,
    size: sizes.small,
    measure: env.measure - 2 * quoted,
    left: env.left + quoted,
    parIndent: 1.5 * em,
  });
  addVspace(col, em);
}

function layoutToc(document: LatexDocument, col: Column, ctx: LayoutContext, env: BlockEnv, at: SourceRef): void {
  const design = ctx.design;
  const em = design.sizes.normalsize.size;

  layoutHeading(
    {
      kind: "heading",
      level: "section",
      number: null,
      title: [
        {
          kind: "text",
          text: "Contents",
          style: { font: { family: "serif", weight: "bold", slant: "upright" }, underline: false },
          loc: at,
        },
      ],
      marker: "toc:contents",
      loc: at,
    },
    col,
    ctx,
    env,
  );

  const pnumWidth = TOC_PAGE_NUMBER_WIDTH_EM * em;
  for (const entry of document.toc) {
    if (!spend(ctx.budget)) break;
    pushTocEntry(entry, col, ctx, env, pnumWidth, at);
  }
}

/**
 * The heading's title as a *table-of-contents entry*.
 *
 * A ToC entry is a **reference to** the heading, not a second occurrence of
 * it, and `entry.title` is the very same `Inline[]` the heading itself is set
 * from (`applySection` in `doc/build.ts` pushes the array, not a copy). So
 * everything in it that is an *occurrence* rather than *text* is dropped here
 * rather than copied through:
 *
 * - a `MarkerInline` — what `\label{k}` inside `\section{...}` leaves behind.
 *   Copied through, the ToC line carried a second `{kind:"marker"}` node, the
 *   page builder saw the name for the first time on the ToC's own page, and
 *   `\pageref{k}` then printed the ToC's page instead of the heading's.
 * - a `FootnoteInline`. It carries the note's number and marker, so copying it
 *   registered *one* note against *two* lines and the note's text was set at
 *   the foot of the ToC's page as well as the heading's. Real LaTeX does
 *   repeat the note in the ToC (a `\footnote` in a moving argument is a known
 *   trap authors reach for `\protect\footnotemark` to avoid); this engine
 *   sets it once, at the heading, and says so.
 *
 * `ReferenceInline`s are kept: `\ref` prints the same text wherever it is set,
 * and passing the very same object through means the resolution pass fills in
 * both appearances at once.
 */
function tocTitle(entry: TocEntry, weight: "bold" | "regular", ctx: LayoutContext): Inline[] {
  const title: Inline[] = [];
  for (const inline of entry.title) {
    if (inline.kind === "marker") continue;
    if (inline.kind === "footnote") {
      ctx.diagnostics.push(
        warning(
          "unsupported",
          inline.loc,
          "a \\footnote in a section title is set at the heading only; this engine does not repeat it in the table of contents",
          "\\footnote",
        ),
      );
      continue;
    }
    title.push(
      inline.kind === "text"
        ? { ...inline, style: { ...inline.style, font: { ...inline.style.font, weight } } }
        : inline,
    );
  }
  return title;
}

function pushTocEntry(
  entry: TocEntry,
  col: Column,
  ctx: LayoutContext,
  env: BlockEnv,
  pnumWidth: number,
  at: SourceRef,
): void {
  const design = ctx.design;
  const size = design.sizes.normalsize;
  const { indent, numberWidth } = tocIndent(design, entry.level);
  // `\l@section` sets its entries in `\bfseries` and puts 1em of space above
  // them; `\l@subsection` and everything below it goes through
  // `\@dottedtocline`, which sets `\normalfont` — plain, not bold. Verified
  // against `article.cls` directly rather than assumed.
  const bold = entry.level === "section";
  if (bold) addVspace(col, design.sizes.normalsize.size, 1, 0);

  const prefix: HNode[] = [];
  if (entry.number !== null) {
    const face = resolveFace(
      ctx,
      { family: "serif", weight: bold ? "bold" : "regular", slant: "upright" },
      size.size,
    );
    if (face !== null) {
      prefix.push(hpack([shapeRun(face, entry.number, ctx.shaper), glue(0, 1, 0, 1, 0)], numberWidth).box);
    }
  }

  // `entry.title` is the very same inline list `applySection` built for the
  // heading itself (doc/build.ts) — and headings are always bold in the body,
  // regardless of level. The ToC's weight rule is different (only `section`
  // is bold), so it must be set *explicitly* here, not merely added when
  // `bold`: a `subsection` entry that only skipped adding bold would still
  // carry the bold weight baked in from the heading it was copied from,
  // which is exactly the bug this fixes (subsection/subsubsection entries
  // rendering bold in the ToC).
  const tocWeight: "bold" | "regular" = bold ? "bold" : "regular";
  const title = tocTitle(entry, tocWeight, ctx);
  // `allowFootnotes` is moot now that `tocTitle` drops footnotes outright, but
  // it stays false: a ToC entry is never the right place for a note's text.
  const hlist = inlinesToHList(title, ctx, { size: size.size, at, allowFootnotes: false, prefix });
  while (hlist.length > 0 && (hlist[hlist.length - 1] as HNode).kind === "glue") hlist.pop();

  const measure = env.measure - indent;
  const page = ctx.pageOf.get(entry.marker);
  const numberFace = resolveFace(ctx, { family: "serif", weight: "regular", slant: "upright" }, size.size);
  if (numberFace !== null) {
    // `\nobreak ⟨connector⟩ \nobreak\hb@xt@\@pnumwidth{\hss #2}`: the folio is
    // pinned to the right edge and never left alone on a line of its own.
    //
    // `\l@section`'s connector is plain `\hfil`. `\@dottedtocline`'s — every
    // level below it — is `\leaders\hbox{...\hbox{.}...}\hfil`: a period
    // repeated to fill whatever the glue resolves to. `buildDotLeader`
    // approximates that (see its own doc comment for why it can only
    // approximate) using the gap computed here on the assumption the entry
    // sets on one line; when a title is too wide for that to hold, or there
    // is no room for even one dot, it falls back to the same plain `\hfil`
    // `\l@section` always uses.
    const titleWidth = measureNodes(hlist, "h").natural;
    const gap = measure - titleWidth - pnumWidth;
    const leader = bold ? null : buildDotLeader(numberFace, ctx.shaper, gap);

    hlist.push(penalty(INFINITE_PENALTY));
    if (leader === null) hlist.push(glue(0, 1, 0, 1, 0));
    else for (const node of leader) hlist.push(node);
    hlist.push(penalty(INFINITE_PENALTY));
    hlist.push(
      hpack(
        [glue(0, 1, 1, 1, 1), shapeRun(numberFace, page === undefined ? UNKNOWN_PAGE : String(page), ctx.shaper)],
        pnumWidth,
      ).box,
    );
  }

  const result = breakParagraph(hlist, measure, breakOptions(ctx, at, { finish: false }));
  for (const d of result.diagnostics) ctx.diagnostics.push(d);
  spend(ctx.budget, result.steps);
  for (const line of result.lines) pushBox(col, line, size.baselineSkip, env.left + indent);
}

/**
 * An approximation of `\@dottedtocline`'s connector — real TeX's
 * `\leaders\hbox{$\m@th\mkern\@dotsep mu\hbox{.}\mkern\@dotsep mu$}\hfil`
 * repeats that little box exactly as many times as fit the glue's *resolved*
 * width, which is only decided during justification, deep inside
 * `glue.ts`/`linebreak.ts` — files outside this chunk. This lays real period
 * glyphs at a fixed spacing instead, as many as comfortably fit under `width`
 * (the caller computes it assuming the entry sets on one line, true for
 * every entry in both golden fixtures) — then, critically, caps the run with
 * genuine order-1 (`\hfil`-strength) stretch, the same as the plain
 * connector this replaces, rather than a kern sized to make the total come
 * out exactly to `width`.
 *
 * That last part is not a style choice: a kern *exactly* filling the
 * estimate leaves the line with no forgiveness for the estimate being even a
 * fraction of a point off from what `breakParagraph` computes independently
 * for the same content, which surfaced as a real regression while building
 * this — a line coming back with nonzero badness made the breaker consider
 * hyphenating the title, and a title whose hyphenation was *considered* (even
 * though never taken) rendered as several adjacent glyph runs instead of one
 * word, in an otherwise unrelated golden line. Order-1 glue absorbs any such
 * slack at zero badness, exactly as `\hfil` always has, so this can only ever
 * add dots to the existing behaviour, never change how a line is chosen.
 *
 * `\@dotsep` is 4.5mu; taking 1mu as this face's `em/18` (`mu`'s usual
 * meaning relative to a text font's own quad, absent a loaded math font to
 * take it from) puts 0.25em of space on each side of a period, which is
 * where the ". . . . ." look comes from.
 *
 * Returns `null` when there is no room for even one dot, or the entry does
 * not fit on one line at all (`width <= 0`) — the caller then falls back to
 * plain glue, same as `\l@section`'s undotted connector.
 */
function buildDotLeader(face: TextFace, shaper: Shaper, width: number): HNode[] | null {
  const dot = shapeRun(face, ".", shaper);
  const pad = 0.25 * face.size;
  const cell = dot.width + 2 * pad;
  if (width <= 0 || cell <= 0) return null;
  const count = Math.floor(width / cell);
  if (count < 1) return null;
  const content: HNode[] = [];
  for (let i = 0; i < count; i++) content.push(kern(pad), dot, kern(pad));
  content.push(glue(0, 1, 0, 1, 0));
  return content;
}

// --- footnotes --------------------------------------------------------------

/** `\@makefnmark` raises the mark in the note itself exactly as it does in the text. */
function footnoteMarkBox(box: HBox, size: number): HBox {
  box.shift = -SUPERSCRIPT_RAISE * size;
  return box;
}

function prepareFootnote(note: FootnoteInline, ctx: LayoutContext): PreparedFootnote {
  const design = ctx.design;
  const size = design.sizes.footnotesize;
  const em = size.size;
  const col = newColumn(design);
  const env: BlockEnv = {
    measure: design.textWidth,
    left: 0,
    size,
    // `\@makefntext` sets `\parindent 1em` inside the note.
    parIndent: em,
    parSkip: 0,
    parSkipStretch: 0,
    parSkipShrink: 0,
    listDepth: 0,
    allowFootnotes: false,
    footnotesRefusedIn: "inside another footnote's text",
  };

  // `\@makefntext` for `article`: `\noindent\hb@xt@1.8em{\hss\@makefnmark}`,
  // so the mark hangs right-aligned in a fixed box and the text starts after it.
  const markFace = resolveFace(ctx, note.style.font, design.sizes.scriptsize.size);
  const markBox: HNode[] =
    markFace === null
      ? []
      : [footnoteMarkBox(hpack([glue(0, 1, 1, 1, 1), shapeRun(markFace, note.label, ctx.shaper)], 1.8 * em).box, em)];

  const blocks = note.content;
  const first = blocks[0];
  if (first !== undefined && first.kind === "paragraph") {
    const hlist = inlinesToHList(first.content, ctx, {
      size: size.size,
      at: note.loc,
      allowFootnotes: env.allowFootnotes,
      footnotesRefusedIn: env.footnotesRefusedIn,
      prefix: markBox,
    });
    pushParagraph(col, ctx, hlist, env, note.loc);
    layoutBlocks(blocks.slice(1), col, ctx, env);
  } else {
    if (markBox.length > 0) pushBox(col, hpack(markBox, "natural").box, size.baselineSkip, 0);
    layoutBlocks(blocks, col, ctx, env);
  }

  return { number: note.number, list: col.list, height: measureNodes(col.list, "v").natural, loc: note.loc };
}

// --- brief 39: floats, tables, images, bibliography ------------------------

/*
 * The vertical list's side of brief 39's syntax half (chunk 39.1). Each of the
 * three capabilities below is a *seam*: this file works out what the material
 * is, how wide it may be and which faces are in force, then hands that to the
 * file whose chunk owns the capability. None of them can be filled in from
 * here, and none of them needs anything from here except through the callbacks
 * these context builders supply — deliberately, because a mutual import
 * between this file and `float.ts`/`table.ts` would be a real cycle.
 */

/** Everything `layout/float.ts` (chunk 39.4) needs, including this file's own setters. */
function floatContext(ctx: LayoutContext, env: BlockEnv): FloatContext {
  return {
    design: ctx.design,
    measure: env.measure,
    size: env.size.size,
    bodySize: env.size,
    shaper: ctx.shaper,
    budget: ctx.budget,
    diagnostics: ctx.diagnostics,
    file: ctx.file,
    setBlocks: (blocks, measure) => setBlocksAsVList(blocks, ctx, env, measure),
    setInlines: (inlines, size, at) =>
      inlinesToHList(inlines, ctx, {
        size,
        at,
        // A `\footnote` inside a float would have to be set at the foot of
        // whatever page the float lands on, which is not known until the float
        // is placed — LaTeX has the same problem and answers it with
        // `\footnotetext` inside the float. Refused rather than misplaced.
        allowFootnotes: false,
        footnotesRefusedIn: "a float",
      }),
  };
}

/** Everything `layout/table.ts` (chunk 39.3) needs, including this file's own setters. */
function tableContext(ctx: LayoutContext, env: BlockEnv): TableContext {
  return {
    design: ctx.design,
    measure: env.measure,
    size: env.size.size,
    bodySize: env.size,
    shaper: ctx.shaper,
    budget: ctx.budget,
    diagnostics: ctx.diagnostics,
    file: ctx.file,
    setInlines: (inlines, size, at) =>
      inlinesToHList(inlines, ctx, {
        size,
        at,
        // Same reason as a float's: a note's text has nowhere to go from inside
        // a cell, and LaTeX needs `\footnotemark`/`\footnotetext` there too.
        allowFootnotes: false,
        footnotesRefusedIn: "a table cell",
      }),
    breakCell: (hlist, width, at) => {
      const result = breakParagraph(hlist, width, breakOptions(ctx, at));
      for (const d of result.diagnostics) ctx.diagnostics.push(d);
      spend(ctx.budget, result.steps);
      return result.lines;
    },
  };
}

/** Everything `src/image/` (chunk 39.2) needs to place one graphic. */
function imageContext(ctx: LayoutContext, size: number, measure: number): ImageContext {
  return {
    design: ctx.design,
    measure,
    size,
    files: ctx.files,
    diagnostics: ctx.diagnostics,
    file: ctx.file,
    reported: ctx.reportedImages,
  };
}

/**
 * A list of blocks as vertical material of its own — a float's content, and
 * whatever else a seam needs set without knowing how this file sets things.
 *
 * A fresh `Column`, not the one being built: the material is going into a box
 * that will be placed somewhere else entirely, so it must not inherit the
 * running `\prevdepth` or contribute interline glue to the main list.
 */
function setBlocksAsVList(
  blocks: readonly Block[],
  ctx: LayoutContext,
  env: BlockEnv,
  measure: number,
): VList {
  const col = newColumn(ctx.design);
  layoutBlocks(blocks, col, ctx, { ...env, measure, left: 0 });
  return col.list;
}

/**
 * A float: prepared, parked under a marker, and left for the page builder.
 *
 * The `Marker` node is the whole mechanism. It costs no height, so a document
 * whose floats are all deferred sets exactly as it would with the floats
 * removed, and it records *where the author wrote the float*, which is what
 * `[h]` means and the line a float must never be placed above.
 */
function layoutFloat(block: FloatBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const prepared = prepareFloat(block, floatContext(ctx, env));
  if (prepared === null) return;
  const marker = floatMarker(ctx.floats.size);
  ctx.floats.set(marker, prepared);
  col.list.push({ kind: "marker", name: marker });
}

function layoutTable(block: TableBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  const box = setTable(block, tableContext(ctx, env));
  if (box === null) return;
  // `\@tabular` puts a table in a box of its own and the surrounding vertical
  // list appends it like any other; the space around it is the paragraph
  // spacing already in force, which is why nothing is added here.
  pushBox(col, box, env.size.baselineSkip, env.left);
}

/**
 * The reference list. `BibliographyBlock.content` is ordinary blocks, produced
 * by `doc/bib.ts` (chunk 39.5) — so there is no bibliography layout here at
 * all, by design: a numbered reference list is paragraphs with a hanging label,
 * and this file already sets those.
 *
 * Empty until that chunk lands. Not a silent nothing: `formatBibliography`
 * reported the gap at the `\bibliography`'s own line while the document was
 * being built, which is where an author can act on it.
 */
function layoutBibliography(block: BibliographyBlock, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  if (block.content.length === 0) return;
  layoutBlocks(block.content, col, ctx, env);
}

/**
 * `\listoffigures` / `\listoftables`, set exactly as the table of contents is.
 *
 * `article.cls` defines `\l@figure` as `\@dottedtocline{1}{1.5em}{2.3em}` —
 * the same indent and number width as `\l@subsection`, and the same dotted
 * connector — so the entries go through the ToC's own entry setter at that
 * level rather than through a second implementation of the same thing. The
 * *heading* is a `\section*`, as `\listoffigures` writes it.
 */
function layoutFloatList(
  document: LatexDocument,
  floatClass: FloatClass,
  col: Column,
  ctx: LayoutContext,
  env: BlockEnv,
  at: SourceRef,
): void {
  layoutHeading(
    {
      kind: "heading",
      level: "section",
      number: null,
      title: [
        {
          kind: "text",
          text: floatClass === "figure" ? "List of Figures" : "List of Tables",
          style: { font: { family: "serif", weight: "bold", slant: "upright" }, underline: false },
          loc: at,
        },
      ],
      marker: `listof:${floatClass}`,
      loc: at,
    },
    col,
    ctx,
    env,
  );

  const pnumWidth = TOC_PAGE_NUMBER_WIDTH_EM * ctx.design.sizes.normalsize.size;
  for (const entry of document.floatList) {
    if (!spend(ctx.budget)) break;
    if (entry.floatClass !== floatClass) continue;
    pushTocEntry(floatListEntry(entry), col, ctx, env, pnumWidth, at);
  }
}

/**
 * A float-list entry as a ToC entry. `subsection` is not a claim that a caption
 * is a subsection: it is the level whose `\@dottedtocline` parameters
 * `\l@figure` shares (see `layoutFloatList`), and the only thing `pushTocEntry`
 * reads the level for.
 */
function floatListEntry(entry: FloatListEntry): TocEntry {
  return { level: "subsection", number: entry.number, title: entry.title, marker: entry.marker };
}

// --- the dispatcher ---------------------------------------------------------

function layoutBlocks(blocks: readonly Block[], col: Column, ctx: LayoutContext, env: BlockEnv): void {
  for (let i = 0; i < blocks.length; i++) {
    if (!spend(ctx.budget)) return;
    const block = blocks[i] as Block;
    if (i > 0 && block.kind === "paragraph" && (blocks[i - 1] as Block).kind === "paragraph") {
      pushGlue(col, env.parSkip, env.parSkipStretch, env.parSkipShrink);
    }
    // `\paragraph` is a run-in heading (see `layoutRunInParagraph`'s doc
    // comment): when a paragraph genuinely follows, the two merge into one
    // set of lines instead of the title getting a line to itself. Anything
    // else following (nothing, a list, another heading) has no paragraph to
    // run into, so `layoutBlock` below falls through to the ordinary,
    // own-line `layoutHeading` — the same rendering used before this fix.
    if (block.kind === "heading" && block.level === "paragraph") {
      const next = blocks[i + 1];
      if (next !== undefined && next.kind === "paragraph") {
        layoutRunInParagraph(block, next, col, ctx, env);
        col.suppressIndent = false;
        i++;
        continue;
      }
    }
    layoutBlock(block, col, ctx, env);
  }
}

/**
 * **Adding a block kind starts here.** Every arm either produces vertical
 * material or reports why it cannot; there is deliberately no `default`, so a
 * new `Block` member in `doc/model.ts` is a typecheck error in this switch
 * rather than content that silently vanishes (D38).
 */
function layoutBlock(block: Block, col: Column, ctx: LayoutContext, env: BlockEnv): void {
  switch (block.kind) {
    case "paragraph":
      layoutParagraph(block, col, ctx, env);
      return;
    case "heading":
      layoutHeading(block, col, ctx, env);
      // `\@afterheading`. A `\label` may sit between the heading and the text
      // it belongs to, which is why the flag rides on the column and is only
      // cleared by material that actually sets something.
      col.suppressIndent = true;
      return;
    case "marker":
      col.list.push({ kind: "marker", name: block.name });
      return;
    case "list":
      col.suppressIndent = false;
      layoutList(block, col, ctx, env);
      return;
    case "verbatim":
      col.suppressIndent = false;
      layoutVerbatim(block, col, ctx, env);
      return;
    case "abstract":
      col.suppressIndent = false;
      layoutAbstract(block, col, ctx, env);
      return;
    case "title":
      col.suppressIndent = false;
      layoutTitle(block, col, ctx, env);
      return;
    case "toc":
      // Only `buildVerticalList` has the document — and therefore `document.toc`
      // — in scope, so it intercepts the top-level case before dispatching here.
      // Anything reaching this arm is a `\tableofcontents` nested inside another
      // block, which is refused rather than dropped (D38).
      ctx.diagnostics.push(
        warning(
          "unsupported",
          block.loc,
          "\\tableofcontents inside another environment is not implemented; it sets nothing here",
          "\\tableofcontents",
        ),
      );
      return;
    case "pagebreak":
      pushPenalty(col, EJECT_PENALTY);
      return;
    case "float":
      col.suppressIndent = false;
      layoutFloat(block, col, ctx, env);
      return;
    case "table":
      col.suppressIndent = false;
      layoutTable(block, col, ctx, env);
      return;
    case "bibliography":
      col.suppressIndent = false;
      layoutBibliography(block, col, ctx, env);
      return;
    case "caption":
      /*
       * A caption is set as part of the float that owns it, so this arm is not
       * the path a well-formed document takes: `doc/build.ts` only ever builds
       * a `CaptionBlock` inside a `FloatBlock.content`, and chunk 39.4's
       * `prepareFloat` sets that content itself. The arm exists because the
       * dispatcher is exhaustive by contract (a new `Block` member must be
       * handled here, not defaulted away) and because `FloatContext.setBlocks`
       * hands float content straight back to this dispatcher.
       *
       * Chunk 39.4 has since landed and took the other of the two designs it
       * was offered: `prepareFloat` sets captions itself and splits the float's
       * content around them, because `\@makecaption` centres a one-line caption
       * and only line-breaks a longer one — a branch that has to be taken after
       * measuring, which a dispatcher handing back a finished vertical list
       * cannot do. So no caption reaches this arm from a well-formed document,
       * and it stays what it always was: the refusal that keeps a stray one
       * from being dropped in silence.
       */
      ctx.diagnostics.push(
        warning(
          "unsupported",
          block.loc,
          "\\caption reached the main vertical list rather than the float that owns it; it sets nothing here",
          "\\caption",
        ),
      );
      return;
    case "listof":
      // Only `buildVerticalList` has `document.floatList` in scope, so it
      // intercepts the top-level case before dispatching here — exactly as it
      // does for `toc`. Anything reaching this arm is nested inside another
      // block, which is refused rather than dropped (D38).
      ctx.diagnostics.push(
        warning(
          "unsupported",
          block.loc,
          `\\listof${block.floatClass === "figure" ? "figures" : "tables"} inside another environment is not implemented; it sets nothing here`,
          `\\listof${block.floatClass === "figure" ? "figures" : "tables"}`,
        ),
      );
      return;
  }
}

/**
 * The document as one vertical list, plus the footnotes its lines carry.
 *
 * Call once per layout pass. `ctx.pageOf` supplies the page numbers a table of
 * contents prints; `\pageref` is handled the other way round, by the document
 * layer rewriting `ReferenceInline.text` between passes.
 */
export function buildVerticalList(document: LatexDocument, ctx: LayoutContext): VList {
  const col = newColumn(ctx.design);
  const env = bodyEnv(ctx.design);
  for (let i = 0; i < document.blocks.length; i++) {
    if (!spend(ctx.budget)) break;
    const block = document.blocks[i] as Block;
    if (block.kind === "toc") {
      layoutToc(document, col, ctx, env, block.loc);
      continue;
    }
    if (block.kind === "listof") {
      layoutFloatList(document, block.floatClass, col, ctx, env, block.loc);
      continue;
    }
    if (i > 0 && block.kind === "paragraph" && (document.blocks[i - 1] as Block).kind === "paragraph") {
      pushGlue(col, env.parSkip, env.parSkipStretch, env.parSkipShrink);
    }
    // Same run-in merge `layoutBlocks` does below — duplicated rather than
    // shared because this loop also owns the `toc` interception `layoutBlocks`
    // does not need (only the top level can see `document.toc`).
    if (block.kind === "heading" && block.level === "paragraph") {
      const next = document.blocks[i + 1];
      if (next !== undefined && next.kind === "paragraph") {
        layoutRunInParagraph(block, next, col, ctx, env);
        col.suppressIndent = false;
        i++;
        continue;
      }
    }
    layoutBlock(block, col, ctx, env);
  }
  return col.list;
}
