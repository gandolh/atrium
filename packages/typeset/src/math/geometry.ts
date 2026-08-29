import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error } from "../diagnostics.ts";

/**
 * The geometry a caller needs to *place* a rendered math run, read back off the
 * `<svg>` MathJax produced.
 *
 * MathJax already did the hard part. Its container carries three numbers that
 * together are everything the page builder needs, and none of them can be
 * recovered from the path data afterwards:
 *
 * - **`vertical-align`**, in `ex`, negative for the part that hangs below the
 *   text baseline. This is *the* number brief 40 says betrays a bad
 *   implementation: inline math sitting a point or two off the baseline looks
 *   subtly wrong across a whole paragraph, which is harder to notice and worse
 *   than an obvious break.
 * - **`width`/`height`**, also in `ex`, which is the box the run occupies.
 * - **the `viewBox`**, in the SVG's own font units, which is what the
 *   SVG → PDF emitter (chunk 40.1) needs to map path coordinates onto the page.
 *
 * **Units are `ex`, and they are left as `ex` on purpose.** An `ex` is a
 * property of the surrounding *text* font at the surrounding *size*, and this
 * module has neither — `src/font/` owns face metrics and `src/layout/` owns the
 * current size. Converting here would mean guessing one of them, and a silently
 * wrong baseline is precisely the failure mode D38's contract exists to
 * prevent. The caller multiplies by its own x-height.
 *
 * Nothing here parses SVG. Every value lives in an attribute of the single
 * outermost `<svg>` start tag, so this reads that tag and nothing else.
 */

/** The SVG `viewBox`, in the drawing's own units. */
export interface MathViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export interface MathGeometry {
  /**
   * The container's `vertical-align`, in `ex`. Negative means the run hangs
   * that far below the baseline it sits on; `0` means it sits on it exactly.
   */
  verticalAlignEx: number;
  /** Advance width of the run, in `ex`. */
  widthEx: number;
  /** Total height of the run, in `ex` — ascent plus descent, not ascent alone. */
  heightEx: number;
  /** The `viewBox`, for mapping path coordinates onto the page. */
  viewBox: MathViewBox;
}

export interface MathGeometryResult {
  /** `null` whenever `diagnostics` is non-empty — never a partly-guessed box. */
  geometry: MathGeometry | null;
  diagnostics: Diagnostic[];
}

const SVG_TAG_PATTERN = /<svg\b([^>]*)>/;

function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`);
  const match = pattern.exec(tag);
  return match === null ? null : (match[1] ?? null);
}

/**
 * A length MathJax wrote as `ex`. A bare `0` is accepted because that is what
 * it emits for an empty run's `vertical-align`, and `0ex` and `0` are the same
 * length; any *other* unit is refused rather than reinterpreted, because
 * treating an unknown unit as `ex` is exactly the silent wrong answer this
 * engine promises not to produce.
 */
function readExLength(raw: string | null): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  const zero = /^[+-]?0(?:\.0+)?$/.exec(value);
  if (zero !== null) return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))ex$/.exec(value);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readViewBox(raw: string | null): MathViewBox | null {
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  return {
    minX: numbers[0] ?? 0,
    minY: numbers[1] ?? 0,
    width: numbers[2] ?? 0,
    height: numbers[3] ?? 0,
  };
}

/**
 * Read the placement geometry off a MathJax `<svg>`.
 *
 * A missing or unreadable attribute is an **`internal`** diagnostic, not a
 * `syntax` one: the document cannot cause it. It would mean MathJax's output
 * shape changed under a version bump, and the engine noticing that loudly is
 * the whole reason this is parsed rather than assumed.
 */
export function readMathGeometry(svg: string, at: SourceRef): MathGeometryResult {
  const tag = SVG_TAG_PATTERN.exec(svg);
  if (tag === null) {
    return { geometry: null, diagnostics: [error("internal", at, "MathJax produced no <svg> element for a math run")] };
  }
  const attributes = tag[1] ?? "";

  const style = attribute(attributes, "style") ?? "";
  const verticalAlignRaw = /vertical-align\s*:\s*([^;]+)/.exec(style);
  // No `vertical-align` at all is not a failure: absent, CSS means the baseline,
  // which is what `0` says here. MathJax emits `vertical-align: 0;` for an empty
  // run, so this branch is a contract with CSS rather than a fallback guess.
  const verticalAlignEx = verticalAlignRaw === null ? 0 : readExLength(verticalAlignRaw[1] ?? null);
  const widthEx = readExLength(attribute(attributes, "width"));
  const heightEx = readExLength(attribute(attributes, "height"));
  const viewBox = readViewBox(attribute(attributes, "viewBox"));

  const missing: string[] = [];
  if (verticalAlignEx === null) missing.push("vertical-align");
  if (widthEx === null) missing.push("width");
  if (heightEx === null) missing.push("height");
  if (viewBox === null) missing.push("viewBox");
  if (missing.length > 0 || verticalAlignEx === null || widthEx === null || heightEx === null || viewBox === null) {
    return {
      geometry: null,
      diagnostics: [
        error(
          "internal",
          at,
          `MathJax's <svg> is missing readable ${missing.join(", ")} — the math run cannot be placed without it`,
        ),
      ],
    };
  }

  return { geometry: { verticalAlignEx, widthEx, heightEx, viewBox }, diagnostics: [] };
}

/**
 * The guard settled call §2 asks for. `fontCache: "none"` inlines every glyph
 * as `<path>` data — verified against `mathjax@4.1.3` — so a `<use>` or a
 * `<defs>` reaching the emitter means that setting stopped taking effect.
 *
 * It fails loudly here rather than in `pdf/svg.ts`, because the emitter's
 * failure mode is to draw nothing where a glyph should be: a formula silently
 * missing half its symbols, which is the one outcome worse than not compiling.
 */
export function findUnresolvedSvgReferences(svg: string): string[] {
  const found: string[] = [];
  if (/<use\b/.test(svg)) found.push("<use>");
  if (/<defs\b/.test(svg)) found.push("<defs>");
  return found;
}
