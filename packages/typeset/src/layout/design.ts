import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { warning } from "../diagnostics.ts";
import type { HeadingLevel, LatexDocument } from "../doc/model.ts";

/**
 * Page design: the numbers `article.cls` would have supplied.
 *
 * Chunk 6 deliberately left type sizes out of the document model, because a
 * size is a page-design decision rather than a meaning — `\section` is not
 * "14.4pt", it is "a section", and how big a section is set is decided here.
 * Everything in this file is therefore a *citation*: a value copied from
 * `article.cls` or `size10.clo`, with the definition it came from named, so a
 * later change is a decision about LaTeX rather than about taste.
 *
 * **The unit is the PDF point (1/72 inch), as `model.ts` requires.** TeX's own
 * `pt` is 1/72.27 inch, so every dimension quoted from a `.clo` file is 0.37%
 * larger here than in real LaTeX. That is about 0.05 mm across a whole page —
 * three times finer than the thinnest rule anyone prints — and paying it buys
 * a single unit system from layout all the way into the content stream, with
 * no conversion left to get wrong. TeX's `bp` is exactly this unit.
 */

/** One entry of LaTeX's size-changing table: `\fontsize{size}{baselineskip}`. */
export interface FontSize {
  /** Type size, in points. */
  size: number;
  /** `\baselineskip` in force at that size. */
  baselineSkip: number;
}

/**
 * The `\normalsize` … `\Huge` ladder, from `size10.clo` — the file
 * `\documentclass[10pt]{article}` loads. Every number below is `\@setfontsize`'s
 * two arguments, verbatim.
 *
 * Only the 10pt series is implemented; `11pt` and `12pt` load different tables
 * that are not a scaling of this one, so they are reported rather than guessed.
 */
export interface SizeLadder {
  tiny: FontSize;
  scriptsize: FontSize;
  footnotesize: FontSize;
  small: FontSize;
  normalsize: FontSize;
  large: FontSize;
  Large: FontSize;
  LARGE: FontSize;
  huge: FontSize;
  Huge: FontSize;
}

export const SIZE10: SizeLadder = {
  tiny: { size: 5, baselineSkip: 6 },
  scriptsize: { size: 7, baselineSkip: 8 },
  footnotesize: { size: 8, baselineSkip: 9.5 },
  small: { size: 9, baselineSkip: 11 },
  normalsize: { size: 10, baselineSkip: 12 },
  large: { size: 12, baselineSkip: 14 },
  Large: { size: 14.4, baselineSkip: 18 },
  LARGE: { size: 17.28, baselineSkip: 22 },
  huge: { size: 20.74, baselineSkip: 25 },
  Huge: { size: 24.88, baselineSkip: 30 },
};

/**
 * `article.cls`'s `\@startsection` calls, one per level.
 *
 * `before`/`after` are the magnitudes of `\@startsection`'s third and fourth
 * arguments in `ex` units of the *body* size; LaTeX writes them negative to
 * signal "do not indent the paragraph that follows", which chunk 6 has already
 * encoded as `ParagraphBlock.indent === false`, so only the magnitude is
 * needed here.
 */
interface HeadingDesign {
  /** Which rung of the ladder the title is set on. */
  size: keyof SizeLadder;
  /** `\@startsection`'s *beforeskip*, in ex. */
  beforeEx: number;
  /** `\@startsection`'s *afterskip*, in ex. */
  afterEx: number;
}

/**
 * `\section` … `\paragraph` as `article.cls` defines them. The face is already
 * bold in the document model (chunk 6 resolves `\bfseries` into the title's
 * inline styles), so only the size is supplied here.
 *
 * `\paragraph`'s afterskip is negative in `article.cls` — a run-in heading,
 * where the following text continues on the same line. That is not implemented;
 * it is set as a small heading on its own line, and `layoutHeading` says so.
 */
export const HEADING_DESIGN: Readonly<Record<HeadingLevel, HeadingDesign>> = {
  section: { size: "Large", beforeEx: 3.5, afterEx: 2.3 },
  subsection: { size: "large", beforeEx: 3.25, afterEx: 1.5 },
  subsubsection: { size: "normalsize", beforeEx: 3.25, afterEx: 1.5 },
  paragraph: { size: "normalsize", beforeEx: 3.25, afterEx: 1 },
};

/** `\leftmargini` … `\leftmarginvi` from `size10.clo`, in em of the body size. */
const LIST_LEFT_MARGIN_EM = [2.5, 2.2, 1.87, 1.7, 1, 1] as const;

/**
 * `\@listi` … `\@listiii` from `size10.clo`: `\topsep`, `\parsep` and
 * `\itemsep` per nesting depth, in points. Depths past the third reuse the
 * third, as LaTeX's `\@listiii` does.
 */
const LIST_SPACING = [
  { top: 8, topStretch: 2, topShrink: 4, par: 4, parStretch: 2, parShrink: 1, item: 4 },
  { top: 4, topStretch: 2, topShrink: 1, par: 2, parStretch: 1, parShrink: 1, item: 2 },
  { top: 2, topStretch: 1, topShrink: 1, par: 0, parStretch: 0, parShrink: 0, item: 2 },
] as const;

export interface ListSpacing {
  /** Distance into the margin the item bodies are set, in points. */
  leftMargin: number;
  /** `\labelsep`, the gap between a label and the text it labels. */
  labelSep: number;
  /** `\labelwidth` — `\leftmargin` minus `\labelsep`. */
  labelWidth: number;
  topSep: number;
  topStretch: number;
  topShrink: number;
  parSep: number;
  itemSep: number;
}

/**
 * `\labelitemi` … `\labelitemiv` from `latex.ltx`: bullet, en dash, centred
 * asterisk, centred period. Keyed by `ListBlock.variantDepth` — LaTeX's
 * `\@itemdepth` counts only `itemize`s, which is why an `itemize` inside an
 * `enumerate` still gets a bullet.
 */
const ITEMIZE_LABELS = ["•", "–", "∗", "·"] as const;

export function itemizeLabel(variantDepth: number): string {
  const index = Math.min(Math.max(variantDepth, 1), ITEMIZE_LABELS.length) - 1;
  return ITEMIZE_LABELS[index] as string;
}

export interface PageDesign {
  /** Media box, in points. */
  paperWidth: number;
  paperHeight: number;
  /** Left edge of the text body. */
  marginLeft: number;
  /** Top edge of the text body. */
  marginTop: number;
  textWidth: number;
  textHeight: number;
  /** `\footskip`: text body's bottom edge to the folio's baseline. */
  footSkip: number;

  sizes: SizeLadder;
  /** `\parindent`, 15pt in `size10.clo`. */
  parIndent: number;
  /** `\parskip`, `0pt plus 1pt` in `latex.ltx`. */
  parSkipStretch: number;
  /**
   * `\topskip`: the first baseline on a page sits this far below the top of
   * the text body, whatever the first line's height — which is what keeps the
   * first lines of consecutive pages aligned.
   */
  topSkip: number;
  /** `\lineskip` and `\lineskiplimit` (`\normallineskip`, `\normallineskiplimit`). */
  lineSkip: number;
  lineSkipLimit: number;

  /** `\skip\footins`: body to footnote block. `9pt plus 4pt minus 2pt`. */
  footnoteSkip: number;
  /** `\footnoterule`'s `.4\columnwidth` rule and the kerns around it. */
  footnoteRuleWidthFraction: number;
  footnoteRuleThickness: number;
  footnoteRuleAbove: number;
  footnoteRuleBelow: number;

  /** `\clubpenalty` / `\widowpenalty` — both 150 in `latex.ltx`. */
  clubPenalty: number;
  widowPenalty: number;
  /** `\@secpenalty`, the encouragement to break *before* a section. */
  secPenalty: number;
}

/** 8.5in x 11in and ISO A4, in PDF points. */
const LETTER = { width: 612, height: 792 } as const;
const A4 = { width: 595.276, height: 841.89 } as const;

/**
 * The engine's default page.
 *
 * US Letter because `\documentclass{article}` defaults to `letterpaper`, and
 * because Atrium's corpus is US-sourced. One-inch margins rather than
 * `size10.clo`'s 345pt measure: that measure was chosen for a 1986 line printer
 * and leaves a two-inch right margin that every modern reader reads as a bug,
 * and `\usepackage[margin=1in]{geometry}` is what a document written today
 * says. `geometry`'s options override all of it — see `applyGeometry`.
 */
export function defaultDesign(): PageDesign {
  const margin = 72;
  return {
    paperWidth: LETTER.width,
    paperHeight: LETTER.height,
    marginLeft: margin,
    marginTop: margin,
    textWidth: LETTER.width - 2 * margin,
    textHeight: LETTER.height - 2 * margin,
    footSkip: 30,
    sizes: SIZE10,
    parIndent: 15,
    parSkipStretch: 1,
    topSkip: 10,
    lineSkip: 1,
    lineSkipLimit: 0,
    footnoteSkip: 9,
    footnoteRuleWidthFraction: 0.4,
    footnoteRuleThickness: 0.4,
    footnoteRuleAbove: 3,
    footnoteRuleBelow: 2.6,
    clubPenalty: 150,
    widowPenalty: 150,
    secPenalty: -300,
  };
}

/** `\leftmargin` for a list at `depth`, and the label geometry that follows from it. */
export function listSpacing(design: PageDesign, depth: number): ListSpacing {
  const em = design.sizes.normalsize.size;
  const index = Math.min(Math.max(depth, 1), LIST_LEFT_MARGIN_EM.length) - 1;
  const leftMargin = (LIST_LEFT_MARGIN_EM[index] as number) * em;
  // `\labelsep` is 0.5em at every depth in `size10.clo`.
  const labelSep = 0.5 * em;
  const spacing = LIST_SPACING[Math.min(index, LIST_SPACING.length - 1)] as (typeof LIST_SPACING)[number];
  return {
    leftMargin,
    labelSep,
    labelWidth: leftMargin - labelSep,
    topSep: spacing.top,
    topStretch: spacing.topStretch,
    topShrink: spacing.topShrink,
    parSep: spacing.par,
    itemSep: spacing.item,
  };
}

/**
 * `\@dottedtocline`'s indent and number width per level, from `article.cls`,
 * in em of the body size. `\@pnumwidth` is 1.55em and shared by every level.
 */
const TOC_INDENT_EM: Readonly<Record<HeadingLevel, { indent: number; numberWidth: number }>> = {
  section: { indent: 0, numberWidth: 1.5 },
  subsection: { indent: 1.5, numberWidth: 2.3 },
  subsubsection: { indent: 3.8, numberWidth: 3.2 },
  paragraph: { indent: 7, numberWidth: 4.1 },
};

export const TOC_PAGE_NUMBER_WIDTH_EM = 1.55;

export function tocIndent(design: PageDesign, level: HeadingLevel): { indent: number; numberWidth: number } {
  const em = design.sizes.normalsize.size;
  const spec = TOC_INDENT_EM[level];
  return { indent: spec.indent * em, numberWidth: spec.numberWidth * em };
}

// --- reading the document's own opinions ------------------------------------

/**
 * Apply `\documentclass` options and `\usepackage[...]{geometry}` to the
 * default design.
 *
 * Only the options that change geometry are read. Anything else in the option
 * list is reported rather than ignored, because a `geometry` option that
 * silently did nothing would produce a document with the wrong margins and no
 * sign of why (D38).
 */
export function documentDesign(
  document: LatexDocument,
  file: string,
  diagnostics: Diagnostic[],
): PageDesign {
  const design = defaultDesign();
  const at: SourceRef = { file, line: 0 };

  applyPaperOptions(design, splitOptions(document.classOptions));
  for (const option of splitOptions(document.classOptions)) {
    const size = /^(1[012])pt$/.exec(option);
    if (size !== null && size[1] !== "10") {
      diagnostics.push(
        warning(
          "unsupported",
          at,
          `\\documentclass[${option}] — only the 10pt size series (size10.clo) is implemented; the document is set at 10pt`,
          "\\documentclass",
        ),
      );
    }
  }

  for (const pkg of document.packages) {
    if (pkg.name !== "geometry") continue;
    applyGeometry(design, pkg.options, pkg.loc, diagnostics);
  }
  return design;
}

function splitOptions(options: string): string[] {
  return options
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** `letterpaper` / `a4paper`, understood both as a class option and a `geometry` one. */
function applyPaperOptions(design: PageDesign, options: readonly string[]): boolean {
  let matched = false;
  for (const option of options) {
    if (option === "letterpaper") {
      setPaper(design, LETTER.width, LETTER.height);
      matched = true;
    } else if (option === "a4paper" || option === "a4") {
      setPaper(design, A4.width, A4.height);
      matched = true;
    }
  }
  return matched;
}

/** Changing the sheet keeps the margins and re-derives the text block from them. */
function setPaper(design: PageDesign, width: number, height: number): void {
  const right = design.paperWidth - design.marginLeft - design.textWidth;
  const bottom = design.paperHeight - design.marginTop - design.textHeight;
  design.paperWidth = width;
  design.paperHeight = height;
  design.textWidth = width - design.marginLeft - right;
  design.textHeight = height - design.marginTop - bottom;
}

function applyGeometry(
  design: PageDesign,
  options: string,
  loc: SourceRef,
  diagnostics: Diagnostic[],
): void {
  const em = design.sizes.normalsize.size;
  // Collected first and applied together: `margin=2cm,left=3cm` must end up
  // with a 3cm left margin whatever order the two arrive in.
  let left: number | null = null;
  let right: number | null = null;
  let top: number | null = null;
  let bottom: number | null = null;
  let textWidth: number | null = null;
  let textHeight: number | null = null;

  for (const option of splitOptions(options)) {
    if (applyPaperOptions(design, [option])) continue;
    const eq = option.indexOf("=");
    if (eq < 0) {
      diagnostics.push(
        warning("unsupported", loc, `geometry option \`${option}\` is not implemented and was ignored`, "geometry"),
      );
      continue;
    }
    const key = option.slice(0, eq).trim();
    const value = parseDimension(option.slice(eq + 1).trim(), em);
    if (value === null) {
      diagnostics.push(
        warning("unsupported", loc, `geometry option \`${option}\` has no dimension this engine understands`, "geometry"),
      );
      continue;
    }
    switch (key) {
      case "margin":
        left = value;
        right = value;
        top = value;
        bottom = value;
        break;
      case "hmargin":
        left = value;
        right = value;
        break;
      case "vmargin":
        top = value;
        bottom = value;
        break;
      case "left":
      case "lmargin":
      case "inner":
        left = value;
        break;
      case "right":
      case "rmargin":
      case "outer":
        right = value;
        break;
      case "top":
      case "tmargin":
        top = value;
        break;
      case "bottom":
      case "bmargin":
        bottom = value;
        break;
      case "textwidth":
      case "width":
        textWidth = value;
        break;
      case "textheight":
      case "height":
        textHeight = value;
        break;
      case "paperwidth":
        setPaper(design, value, design.paperHeight);
        break;
      case "paperheight":
        setPaper(design, design.paperWidth, value);
        break;
      case "footskip":
        design.footSkip = value;
        break;
      default:
        diagnostics.push(
          warning("unsupported", loc, `geometry option \`${key}\` is not implemented and was ignored`, "geometry"),
        );
    }
  }

  design.marginLeft = left ?? design.marginLeft;
  design.marginTop = top ?? design.marginTop;
  design.textWidth =
    textWidth ?? design.paperWidth - design.marginLeft - (right ?? design.paperWidth - design.marginLeft - design.textWidth);
  design.textHeight =
    textHeight ??
    design.paperHeight - design.marginTop - (bottom ?? design.paperHeight - design.marginTop - design.textHeight);
}

/**
 * A TeX dimension in PDF points. `in` is 72 points here rather than 72.27,
 * for the reason in this file's header: the engine's point *is* the PDF point.
 */
export function parseDimension(text: string, em: number): number | null {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(pt|bp|in|cm|mm|pc|em|ex|sp)?$/.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2] ?? "pt") {
    case "in":
      return value * 72;
    case "cm":
      return (value * 72) / 2.54;
    case "mm":
      return (value * 72) / 25.4;
    case "pc":
      return value * 12;
    case "em":
      return value * em;
    // TeX's `ex` is the x-height of the current font; Latin Modern Roman's is
    // 0.431em, which is what makes `3.5ex` above a section come out at ~15pt.
    case "ex":
      return value * em * 0.431;
    case "sp":
      return value / 65536;
    default:
      return value;
  }
}
