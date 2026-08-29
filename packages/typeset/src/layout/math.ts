import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, warning } from "../diagnostics.ts";
import type { DisplayMathBlock, Inline, MathLine } from "../doc/model.ts";
import { checkDisplayOverrun, setEquationNumber } from "../doc/model.ts";
import { scaleToPoints } from "../font/handle.ts";
// Type-only, and it must stay that way: `math/bridge.ts` keeps MathJax behind a
// dynamic `import()` so `src/index.ts`'s static graph never pulls ~70 MB, and a
// value import of the renderer here would be the first step towards undoing it.
// Layout never *builds* a renderer — one is handed in, exactly as fonts are.
import type { MathRenderer } from "../math/index.ts";
import { parseSvg } from "../pdf/svg.ts";
import type { HBox, HList, HNode, MathNode } from "./model.ts";
import { kern } from "./model.ts";
import { hpack } from "./glue.ts";
import type { TextFace } from "./hlist.ts";

/**
 * Placing mathematics: a rendered run becomes a box, and a display becomes a
 * centred line with a number at the margin (brief 40, chunk 40.4).
 *
 * This file is the seam between two subsystems that deliberately know nothing
 * about each other. `src/math/` turns TeX into an SVG and reports its geometry
 * **in `ex`**, because an `ex` is a property of the surrounding text font at the
 * surrounding size and a renderer knows neither. `src/layout/` knows both and
 * knows nothing about MathJax. The multiplication happens here, once, and it is
 * the arithmetic brief 40 says betrays a bad implementation:
 *
 * ```
 * ex     = xHeight(surrounding face) · size / unitsPerEm
 * depth  = -verticalAlignEx · ex        // `vertical-align` is negative when it hangs
 * height =  heightEx · ex - depth       // MathJax's height is ascent + descent
 * width  =  widthEx · ex
 * ```
 *
 * Cross-checked against MathJax's own numbers: `\frac{a}{b}` comes back with a
 * viewBox 1815 units tall of which 697 sit below `y = 0`, a total height of
 * 4.106ex, and `vertical-align: -1.577ex` — and 697/1815 × 4.106 = 1.577. The
 * SVG's `y = 0` *is* the baseline, so aligning the box by its depth aligns the
 * formula's baseline with the text's, which is the whole requirement.
 *
 * **Nothing here throws and nothing here is silently skipped.** Every way a run
 * can fail to be set — no renderer supplied, MathJax refused it, the SVG will
 * not parse — leaves a diagnostic and returns `null`, and the caller adds no
 * box. That is D38 applied to the one construct that was, until this chunk,
 * dropping out of the document with no trace at all.
 */

/**
 * `\abovedisplayskip` / `\belowdisplayskip`, from `size10.clo`:
 *
 * ```
 * \abovedisplayskip 10\p@ \@plus2\p@ \@minus5\p@
 * \belowdisplayskip \abovedisplayskip
 * ```
 *
 * The *short* skips (`\abovedisplayshortskip`, `\belowdisplayshortskip`) are
 * deliberately not implemented. TeX chooses between the two by comparing the
 * width of the line immediately above the display against the display's own
 * left edge — a decision that needs the previous line's *set* width, which the
 * vertical list has already discarded by the time a block is appended. Using
 * the long skip everywhere is what LaTeX does when the preceding line is long,
 * which is the common case; the difference is 10pt against 0pt above a short
 * partial line. Recorded rather than guessed at.
 */
export const ABOVE_DISPLAY_SKIP = { natural: 10, stretch: 2, shrink: 5 } as const;
export const BELOW_DISPLAY_SKIP = ABOVE_DISPLAY_SKIP;

/** Minimum gap between a display and the `(1)` set beside it. LaTeX's `\@eqnnum` sits flush right. */
const EQUATION_NUMBER_GAP = 5;

/** What placing one math run needs. Assembled by `vlist.ts`, which owns every field. */
export interface MathContext {
  /**
   * The renderer, injected the way `CompileOptions.fonts` is and for the same
   * reason: `createMathRenderer()` is async and `compile()` is not, so
   * construction happens outside the engine. `null` when the caller supplied
   * none — which is a diagnostic the moment a document actually contains math,
   * and costs a math-free document nothing.
   */
  renderer: MathRenderer | null;
  /**
   * The surrounding **text** face, resolved. Math is set in MathJax's own faces;
   * this one is here only to supply the x-height and the size that turn `ex`
   * into points.
   */
  face: TextFace;
  diagnostics: Diagnostic[];
  /**
   * Latched so a document with two hundred formulas and no renderer produces
   * one diagnostic rather than two hundred identical ones — the same mechanism
   * `LayoutContext.missingFaces` uses for an absent font.
   */
  reported: Set<string>;
}

/** One `ex` of the surrounding face, in points. */
export function exHeight(face: TextFace): number {
  return scaleToPoints(face.font.xHeight, face.size, face.font.unitsPerEm);
}

/**
 * Render one run and turn it into a box, or report why not.
 *
 * `construct` is the LaTeX that wrote it (`$...$`, `equation`), carried so a
 * refusal names something the author can find rather than "a math run".
 */
export function setMathRun(
  source: string,
  display: boolean,
  loc: SourceRef,
  construct: string,
  ctx: MathContext,
): MathNode | null {
  const renderer = ctx.renderer;
  if (renderer === null) {
    /*
     * Not a silent drop, and not a different contract from any other missing
     * input. `missing-font` is the code because it is the one this fixed set
     * (`packages/shared/src/latex.ts`, deliberately closed) has for "something
     * the engine needed in order to set this material was not handed to it" —
     * the same code, and the same wording, `compile()` already uses when no
     * `fonts` provider is supplied. It is not `unsupported`: `$x^2$` *is* in
     * the subset, and telling an author their LaTeX is unimplemented when the
     * real problem is the caller's configuration would send them to fix the
     * wrong thing.
     */
    if (!ctx.reported.has("renderer")) {
      ctx.reported.add("renderer");
      ctx.diagnostics.push(
        error(
          "missing-font",
          loc,
          "no math renderer was supplied — pass `math` to compile() (see `createMathRenderer`); " +
            "the mathematics in this document is not set without one",
          construct,
        ),
      );
    }
    return null;
  }

  const rendered = renderer.render({ tex: source, display, at: loc });
  for (const d of rendered.diagnostics) ctx.diagnostics.push(d);
  // `run` is non-null exactly when `diagnostics` is empty (`src/math/index.ts`).
  // There is no partial result to salvage and deliberately no attempt to make
  // one: half a formula in a published PDF is the outcome D38 exists to stop.
  if (rendered.run === null) return null;

  const parsed = parseSvg(rendered.run.svg, loc);
  for (const d of parsed.diagnostics) ctx.diagnostics.push(d);
  if (parsed.document === null) return null;

  const ex = exHeight(ctx.face);
  const geometry = rendered.run.geometry;
  const depth = -geometry.verticalAlignEx * ex;
  const node: MathNode = {
    kind: "math",
    width: geometry.widthEx * ex,
    // MathJax's `height` is the whole box, ascent *and* descent; subtracting the
    // depth is what leaves the part that sits above the baseline. Reading it as
    // an ascent would raise every formula by its own descender.
    height: geometry.heightEx * ex - depth,
    depth,
    picture: parsed.document,
    source,
    loc,
  };

  if (!Number.isFinite(node.width) || !Number.isFinite(node.height) || !Number.isFinite(node.depth)) {
    ctx.diagnostics.push(
      error("internal", loc, `a math run's box came out non-finite (${node.width} × ${node.height}+${node.depth})`),
    );
    return null;
  }
  return node;
}

/** Everything setting a *display* needs on top of `MathContext`. */
export interface DisplayMathContext extends MathContext {
  /** The text width the display is centred in and the number is flush against. */
  measure: number;
  /** Inlines to a horizontal list, so the number is shaped the way all text is. */
  setInlines: (inlines: readonly Inline[], at: SourceRef) => HList;
}

export interface SetDisplay {
  /** The whole display line, `measure` wide when it carries a number. */
  box: HBox;
  /** The run itself, exposed so a caller can assert on it without walking the box. */
  math: MathNode;
}

/**
 * A display, centred in the measure, with its number at the right-hand margin.
 *
 * The whole environment is handed to MathJax as one run — `\begin{align}…` and
 * all — because the alignment points are MathJax's to resolve and splitting the
 * source into lines here would throw them away. One run therefore comes back as
 * one box, which is why numbering below is restricted to a display that has one
 * line: a multi-line display's per-line baselines live inside a single SVG and
 * are not recoverable from its container attributes. That gap is reported, not
 * skipped.
 */
export function setDisplayMath(block: DisplayMathBlock, ctx: DisplayMathContext): SetDisplay | null {
  const math = setMathRun(block.source, true, block.loc, block.construct, ctx);
  if (math === null) return null;

  const overrun = checkDisplayOverrun(block, math.width, ctx.measure);
  if (overrun !== null) ctx.diagnostics.push(overrun);

  const numberBox = setDisplayNumber(block, ctx);
  const numberWidth = numberBox === null ? 0 : numberBox.width;

  // Centred in the measure, then pushed left only as far as the number forces.
  // Clamped at zero because an overrunning display starts at the left margin and
  // runs off the right one, where the diagnostic above has already said so —
  // starting it at a negative offset would move it into the *left* margin, where
  // a reader would blame the engine rather than the formula.
  let left = Math.max(0, (ctx.measure - math.width) / 2);
  if (numberBox !== null) {
    left = Math.min(left, Math.max(0, ctx.measure - numberWidth - EQUATION_NUMBER_GAP - math.width));
  }

  const content: HNode[] = [];
  if (left !== 0) content.push(kern(left));
  content.push(math);
  if (numberBox !== null) {
    content.push(kern(Math.max(EQUATION_NUMBER_GAP, ctx.measure - left - math.width - numberWidth)));
    content.push(numberBox);
  }
  return { box: hpack(content, "natural").box, math };
}

/**
 * `\@eqnnum` for a display, or `null` when there is nothing to set.
 *
 * `setEquationNumber` (the document layer) decides the *material* — the
 * parentheses live there, beside the counter that produced the digits — and this
 * function only shapes and packs it, so the number is set in exactly the face
 * and at exactly the size the surrounding text is.
 */
function setDisplayNumber(block: DisplayMathBlock, ctx: DisplayMathContext): HBox | null {
  const numbered = block.lines.filter((line) => line.number !== null);
  if (numbered.length === 0) return null;

  if (block.lines.length > 1) {
    /*
     * Loud, and specific about what is missing. `align` and `gather` number
     * every line, and each number belongs on that line's own baseline — which
     * exists only inside the single SVG MathJax returned, where the container
     * attributes this engine reads (`width`, `height`, `vertical-align`,
     * `viewBox`) do not expose it. Reaching into the SVG's internal `<g>`
     * structure to guess at line positions is exactly the kind of "looks right
     * until it doesn't" inference D38 rules out.
     *
     * The mathematics is still set, and `\ref` to any of these lines still
     * resolves — the counter and label machinery ran in the document layer and
     * is untouched. What is absent is the printed `(n)` beside the line, and it
     * says so.
     */
    ctx.diagnostics.push(
      // A *warning*, not an error, and the only place in this file that is not
      // fatal. The formula itself is set correctly and completely; what is
      // missing is the `(n)` beside it. Refusing the whole compile over that
      // would make every `align` document unpublishable, which is a worse
      // answer than a document that is right apart from a mark the diagnostic
      // names. `vlist.ts` reports a nested `\tableofcontents` the same way.
      warning(
        "unsupported",
        block.loc,
        `this engine does not set equation numbers beside the individual lines of a multi-line display — ` +
          `\`${block.construct}\` here has ${block.lines.length} lines and ${numbered.length} of them are numbered; ` +
          `the mathematics is set, but without the numbers (\\ref to them still resolves). ` +
          `Use separate \`equation\` displays, or a starred variant if the numbers are not wanted`,
        block.construct,
      ),
    );
    return null;
  }

  const line = numbered[0] as MathLine;
  const inlines = setEquationNumber(line, ctx.measure);
  if (inlines.length === 0) return null;
  const hlist = ctx.setInlines(inlines, line.loc);
  if (hlist.length === 0) return null;
  return hpack(hlist, "natural").box;
}
