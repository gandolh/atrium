import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import type { MathGeometry } from "./geometry.ts";

/**
 * `src/math/` — one TeX math run in, one SVG plus the geometry to place it out,
 * and every failure a real Atrium `Diagnostic` (brief 40, D41).
 *
 * The subsystem is deliberately narrow. It does **not** know what a paragraph
 * is, where a line breaks, what an equation is numbered, or how big an `ex` is
 * on the page — those belong to `doc/`, `layout/` and the document model, and
 * routing them through here would put page state inside a renderer that has no
 * business holding any. What it owns is exactly the three things nothing else
 * can do:
 *
 * 1. **TeX → SVG**, through MathJax (`bridge.ts`).
 * 2. **The subset gate** — refusing what brief 40 declared Out even where
 *    MathJax renders it clean, read off the *MathML* so macro expansion cannot
 *    hide anything (`subset.ts`).
 * 3. **The placement geometry** — baseline offset, size, viewBox (`geometry.ts`).
 *
 * ## The shape callers see
 *
 * A `MathRenderer` is built once, asynchronously, and then used synchronously:
 *
 * ```ts
 * const math = await createMathRenderer();          // once, at startup
 * const { run, diagnostics } = math.render({ tex: "x^2", display: false, at });
 * ```
 *
 * That split is not incidental. `compile()` is synchronous and MathJax's
 * `init()` is not, and the engine acquires nothing for itself — so a renderer
 * is **injected**, exactly the way `CompileOptions.fonts` is injected and for
 * exactly the same reason (`wiki/typeset.md`: "the caller owns byte
 * acquisition"). A caller that sets no math never builds one and never pays for
 * MathJax at all.
 *
 * ## `run` and `diagnostics` are exclusive
 *
 * `run` is non-null **iff** `diagnostics` is empty. There is no partial result
 * and there is deliberately no "rendered, but with a warning" state: a math run
 * this engine is not sure about must not reach a *published* PDF looking
 * confident (D38). A caller therefore branches once, on `run === null`, and
 * appends the diagnostics either way.
 */

export type { MathGeometry, MathGeometryResult, MathViewBox } from "./geometry.ts";
export { findUnresolvedSvgReferences, readMathGeometry } from "./geometry.ts";
export {
  ALLOWED_COMMANDS,
  ALLOWED_ELEMENTS,
  ALLOWED_ENVIRONMENTS,
  KNOWN_UNSUPPORTED_COMMANDS,
  KNOWN_UNSUPPORTED_ENVIRONMENTS,
  checkMathSubset,
  commandsOnly,
  headOf,
} from "./subset.ts";
export { classifyTexError, findMathmlErrors } from "./errors.ts";
export { createMathRenderer } from "./bridge.ts";

/** One math run, as the document model hands it over. */
export interface MathRequest {
  /**
   * The TeX **between** the delimiters — `x^2`, not `$x^2$`. Stripping `$…$`,
   * `\(…\)`, `\[…\]` and the environment wrappers is the document layer's job,
   * because that is where the source positions are; by the time it reaches here
   * a run is just an expression.
   */
  tex: string;
  /**
   * Display style (`\[…\]`, `equation`, `align`) rather than inline (`$…$`).
   * This is MathJax's `{ display }` flag, and it changes the *typesetting* —
   * limit placement on `\sum`, fraction size, spacing — not merely the
   * surrounding whitespace, so it cannot be applied afterwards by the caller.
   */
  display: boolean;
  /**
   * Where the run came from. Carried rather than recomputed, because brief 37
   * treats a wrong line number as a bug and this subsystem has no source text
   * to recover one from.
   */
  at: SourceRef;
}

/** A math run that rendered and passed the gate. */
export interface MathRun {
  /**
   * The `<svg>…</svg>` element, serialised. Self-contained vector: explicit
   * `<path>` outlines, no `<use>`, no `<defs>`, no font to resolve — which is
   * what lets chunk 40.1's emitter be paths and transforms and nothing else.
   */
  svg: string;
  /** Echoed back so a caller holding only the run still knows which style it is. */
  display: boolean;
  /**
   * Baseline offset and size. **`verticalAlignEx`, `widthEx` and `heightEx` are
   * in `ex`** — a property of the surrounding text font at the surrounding
   * size, neither of which this subsystem knows — so the caller multiplies by
   * its own x-height to get points. `viewBox` is in the SVG's own units and is
   * what maps path coordinates onto the page.
   */
  geometry: MathGeometry;
}

export interface MathResult {
  /** Non-null exactly when `diagnostics` is empty. Never a partial render. */
  run: MathRun | null;
  diagnostics: Diagnostic[];
}

/**
 * The injectable renderer. Synchronous by design: `compile()` is, and a
 * document that had to await mid-layout would need the whole engine to become
 * async for the one stage that cannot be.
 */
export interface MathRenderer {
  render(request: MathRequest): MathResult;
}
