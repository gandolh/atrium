import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMatrix,
  emitSvg,
  multiplyMatrix,
  parseSvg,
  parseSvgLength,
  parseTransform,
  svgToOperators,
  viewBoxMatrix,
} from "../src/pdf/svg.ts";
import type { SvgTargetBox } from "../src/pdf/svg.ts";
import type { Diagnostic } from "../src/diagnostics.ts";

/**
 * Brief 40, chunk 40.1: the SVG → PDF operator emitter.
 *
 * **Every assertion here is on a coordinate, not on "it did not throw".** That
 * is deliberate, and it is the lesson `wiki/typeset.md` records from brief 39:
 * the one defect its review found was geometry that produced no diagnostic and
 * still drew the wrong picture, because the test asserted only that the case
 * "stays quiet". A formula rendered upside down, or with one glyph half a point
 * off, is exactly that failure again — so the tests below say where the ink
 * lands.
 *
 * ## The coordinate frame these tests use
 *
 * Nearly every case uses `viewBox="0 0 100 100"` painted into the target box
 * `{x: 0, y: 0, width: 100, height: 100}`. That makes both scales exactly 1 and
 * leaves one visible conversion:
 *
 * ```
 * X = ux            Y = 100 − uy
 * ```
 *
 * so an expected operator can be read against the `d` string by hand. The
 * flip is the whole point: SVG's y grows down, PDF's grows up.
 */

const AT = { file: "main.tex", line: 12 };
const UNIT: SvgTargetBox = { x: 0, y: 0, width: 100, height: 100 };
const FIXTURES = join(import.meta.dirname, "fixtures", "svg");

/** A one-path document in the frame described above. */
function pathDoc(d: string, extra = ""): string {
  return `<svg viewBox="0 0 100 100"><path d="${d}"${extra}></path></svg>`;
}

function ops(svg: string, box: SvgTargetBox = UNIT): string[] {
  const result = svgToOperators(svg, box, AT);
  assert.deepEqual(result.diagnostics, [], "expected no diagnostics");
  return result.operators;
}

function refusal(svg: string, box: SvgTargetBox = UNIT): Diagnostic {
  const result = svgToOperators(svg, box, AT);
  assert.equal(result.operators.length, 0, "a refused SVG must paint nothing at all");
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(result.diagnostics)}`);
  return errors[0]!;
}

/* ============================================================ the y-axis flip */

/**
 * The orientation proof, stated as two numbers.
 *
 * The path runs from the viewBox's top-left corner to its bottom-right one. In
 * PDF that is `(0, 100)` down to `(100, 0)`. If the flip were missing the
 * operators would read `0 0 m / 100 100 l`; if it were applied twice they would
 * read the same, since two flips cancel. Only the emitted pair below is right.
 */
test("svg: the viewBox y-axis is flipped exactly once", () => {
  assert.deepEqual(ops(pathDoc("M0 0 L100 100")), ["0 100 m", "100 0 l", "f"]);
});

/**
 * MathJax's own `transform="scale(1,-1)"` and this emitter's flip are two
 * different things, and the bug this test exists for is applying one of them
 * twice.
 *
 * The shape mimics the real output: a viewBox whose y runs from −1000 (top) to
 * 0 (the baseline), an outer group that flips MathJax's y-up font units, and a
 * stroke rising 800 units from the baseline. On the page the pen must therefore
 * end up 800 points **above** where it started. Double-flip it and the second
 * operator becomes `0 -800 l` — the formula hangs below the baseline, upside
 * down, which is precisely what "prove the orientation" means here.
 */
test("svg: MathJax's outer scale(1,-1) is not a second flip", () => {
  const svg = `<svg viewBox="0 -1000 1000 1000"><g transform="scale(1,-1)"><path d="M0 0 L0 800"></path></g></svg>`;
  assert.deepEqual(ops(svg, { x: 0, y: 0, width: 1000, height: 1000 }), ["0 0 m", "0 800 l", "f"]);
});

/** The mapping is a translation too, not only a scale: the box need not sit at the origin. */
test("svg: the target box's own position moves the picture", () => {
  const box: SvgTargetBox = { x: 72, y: 200, width: 100, height: 100 };
  assert.deepEqual(ops(pathDoc("M0 0 L100 100"), box), ["72 300 m", "172 200 l", "f"]);
});

/** A viewBox with a non-zero origin: `minX`/`minY` shift the user space, the flip stays. */
test("svg: a non-zero viewBox origin is subtracted before the flip", () => {
  const svg = `<svg viewBox="-50 -50 100 100"><path d="M-50 -50 L50 50"></path></svg>`;
  assert.deepEqual(ops(svg), ["0 100 m", "100 0 l", "f"]);
});

/** Scale, when the box and the viewBox are different sizes. */
test("svg: the viewBox scales to the target box", () => {
  const svg = `<svg viewBox="0 0 10 10"><path d="M0 0 L10 5"></path></svg>`;
  assert.deepEqual(ops(svg, { x: 0, y: 0, width: 50, height: 50 }), ["0 50 m", "50 25 l", "f"]);
});

/* ================================================================ path data */

test("svg: M/L, absolute", () => {
  assert.deepEqual(ops(pathDoc("M10 20 L30 40")), ["10 80 m", "30 60 l", "f"]);
});

test("svg: m/l, relative — every argument is an offset from the current point", () => {
  assert.deepEqual(ops(pathDoc("m10 20 l20 20")), ["10 80 m", "30 60 l", "f"]);
});

/**
 * An implicit repeat after a moveto is a **lineto**, not another moveto — the
 * one place the SVG grammar repeats a different command than the one written.
 * Getting this wrong turns a filled outline into a set of disconnected points
 * and fills nothing.
 */
test("svg: a repeated moveto argument set is a lineto", () => {
  assert.deepEqual(ops(pathDoc("M10 10 20 10 20 20")), ["10 90 m", "20 90 l", "20 80 l", "f"]);
  assert.deepEqual(ops(pathDoc("m10 10 10 0 0 10")), ["10 90 m", "20 90 l", "20 80 l", "f"]);
});

test("svg: H/h and V/v hold the other coordinate", () => {
  assert.deepEqual(ops(pathDoc("M10 10 H30 V40 h-5 v-5")), [
    "10 90 m",
    "30 90 l",
    "30 60 l",
    "25 60 l",
    "25 65 l",
    "f",
  ]);
});

test("svg: C/c control points ride the same transform as the endpoints", () => {
  assert.deepEqual(ops(pathDoc("M0 0 C10 0 20 10 20 20")), [
    "0 100 m",
    "10 100 20 90 20 80 c",
    "f",
  ]);
  // The relative form has every one of the six numbers offset from (0,0).
  assert.deepEqual(ops(pathDoc("M0 0 c10 0 20 10 20 20")), [
    "0 100 m",
    "10 100 20 90 20 80 c",
    "f",
  ]);
});

/**
 * `S` reflects the previous cubic's **second** control point about the current
 * point. Here the previous second control is `(20, 10)` and the current point
 * is `(20, 20)`, so the reflection is `(20, 30)` — user y *increasing*, which
 * lands at PDF y 70.
 */
test("svg: S reflects the previous cubic's second control point", () => {
  assert.deepEqual(ops(pathDoc("M0 0 C10 0 20 10 20 20 S40 30 40 40")), [
    "0 100 m",
    "10 100 20 90 20 80 c",
    "20 70 40 70 40 60 c",
    "f",
  ]);
});

/** With no preceding cubic, `S`'s first control is the current point itself. */
test("svg: S with no preceding cubic uses the current point", () => {
  assert.deepEqual(ops(pathDoc("M10 10 S30 10 30 30")), [
    "10 90 m",
    "10 90 30 90 30 70 c",
    "f",
  ]);
});

/**
 * PDF has no quadratic operator, so `Q` becomes the *exact* cubic that draws
 * the same curve: controls at `p₀ + ⅔(q − p₀)` and `p₂ + ⅔(q − p₂)`. With
 * `p₀ = (0,0)`, `q = (30,0)`, `p₂ = (30,30)` those are `(20,0)` and `(30,10)`.
 */
test("svg: Q becomes the equivalent cubic", () => {
  assert.deepEqual(ops(pathDoc("M0 0 Q30 0 30 30")), [
    "0 100 m",
    "20 100 30 90 30 70 c",
    "f",
  ]);
});

/** `T` reflects the previous *quadratic* control, then converts as `Q` does. */
test("svg: T reflects the previous quadratic control point", () => {
  assert.deepEqual(ops(pathDoc("M0 0 Q30 0 30 30 T60 60")), [
    "0 100 m",
    "20 100 30 90 30 70 c",
    "30 50 40 40 60 40 c",
    "f",
  ]);
});

test("svg: q and t are the relative forms", () => {
  assert.deepEqual(ops(pathDoc("M0 0 q30 0 30 30")), ops(pathDoc("M0 0 Q30 0 30 30")));
});

/**
 * `Z` closes the subpath **and** puts the current point back at the subpath's
 * first point. The trailing `l10 0` therefore starts from `(10,10)`, not from
 * `(20,10)` where the pen visibly was.
 */
test("svg: after Z the current point is the subpath's start", () => {
  assert.deepEqual(ops(pathDoc("M10 10 L20 10 Z l10 0")), [
    "10 90 m",
    "20 90 l",
    "h",
    "20 90 l",
    "f",
  ]);
});

test("svg: several subpaths fill as one shape", () => {
  assert.deepEqual(ops(pathDoc("M0 0 L10 0 Z M20 0 L30 0 Z")), [
    "0 100 m",
    "10 100 l",
    "h",
    "20 100 m",
    "30 100 l",
    "h",
    "f",
  ]);
});

/** Numbers run together in real glyph data: `88 26C114` and `329-11` are pairs. */
test("svg: numbers separated only by a sign, a dot or a command letter", () => {
  assert.deepEqual(ops(pathDoc("M10 10L20-10")), ["10 90 m", "20 110 l", "f"]);
  assert.deepEqual(ops(pathDoc("M.5.5L1.5.5")), ["0.5 99.5 m", "1.5 99.5 l", "f"]);
  assert.deepEqual(ops(pathDoc("M0 0L1e2 1E2")), ["0 100 m", "100 0 l", "f"]);
});

test("svg: an absent or empty d paints nothing and says nothing", () => {
  assert.deepEqual(ops(`<svg viewBox="0 0 100 100"><path></path></svg>`), []);
  assert.deepEqual(ops(pathDoc("   ")), []);
});

/* ================================================================ transforms */

/**
 * Composition down the `<g>` tree: the outer `translate` must be applied to the
 * *result* of the inner `scale`, not the other way round. `(5,5)` scaled by 2
 * is `(10,10)`; translated by `(10,20)` it is `(20,30)`; flipped it is
 * `(20,70)`. Swapping the two would give `(30,50)` → `(30,50)`, a different
 * point, which is what a wrong multiplication order looks like.
 */
test("svg: nested transforms compose outermost-last", () => {
  const svg =
    `<svg viewBox="0 0 100 100">` +
    `<g transform="translate(10,20)"><g transform="scale(2)"><path d="M5 5 L10 0"></path></g></g>` +
    `</svg>`;
  assert.deepEqual(ops(svg), ["20 70 m", "30 80 l", "f"]);
});

/**
 * A transform *list* on one attribute composes the same way, leftmost
 * outermost. MathJax writes exactly this for script-size runs:
 * `translate(605,363) scale(0.707)`.
 */
test("svg: a transform list composes leftmost-outermost", () => {
  const listed =
    `<svg viewBox="0 0 100 100"><g transform="translate(10,20) scale(2)"><path d="M5 5 L10 0"></path></g></svg>`;
  assert.deepEqual(ops(listed), ["20 70 m", "30 80 l", "f"]);
});

/** Both separators MathJax uses: `translate(220,676)` and `translate(0 -686)`. */
test("svg: transform arguments accept commas or spaces", () => {
  const comma = `<svg viewBox="0 0 100 100"><g transform="translate(10,20)"><path d="M0 0 L0 0"></path></g></svg>`;
  const space = `<svg viewBox="0 0 100 100"><g transform="translate(10 20)"><path d="M0 0 L0 0"></path></g></svg>`;
  assert.deepEqual(ops(comma), ops(space));
  assert.deepEqual(ops(comma), ["10 80 m", "10 80 l", "f"]);
});

/** `scale(s)` is `scale(s, s)` — the one-argument form MathJax actually writes. */
test("svg: single-argument scale and translate", () => {
  assert.deepEqual(
    ops(`<svg viewBox="0 0 100 100"><g transform="scale(2)"><path d="M5 10 L0 0"></path></g></svg>`),
    ["10 80 m", "0 100 l", "f"],
  );
  // `translate(tx)` means `translate(tx, 0)`.
  assert.deepEqual(
    ops(`<svg viewBox="0 0 100 100"><g transform="translate(10)"><path d="M0 0 L0 0"></path></g></svg>`),
    ["10 100 m", "10 100 l", "f"],
  );
});

/** `matrix(a b c d e f)`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
test("svg: matrix() applies all six numbers", () => {
  // (10, 20) → (2·10 + 3·20 + 4, 0·10 + 5·20 + 6) = (84, 106) → PDF (84, -6).
  const svg = `<svg viewBox="0 0 100 100"><g transform="matrix(2 0 3 5 4 6)"><path d="M10 20 L10 20"></path></g></svg>`;
  assert.deepEqual(ops(svg), ["84 -6 m", "84 -6 l", "f"]);
});

test("svg: a transform on the <svg> root composes after the viewBox mapping", () => {
  const svg = `<svg viewBox="0 0 100 100" transform="translate(5,5)"><path d="M0 0 L0 0"></path></svg>`;
  assert.deepEqual(ops(svg), ["5 95 m", "5 95 l", "f"]);
});

test("svg: multiplyMatrix and applyMatrix agree on the order of application", () => {
  const translate = [1, 0, 0, 1, 10, 20] as const;
  const scale = [2, 0, 0, 2, 0, 0] as const;
  const composed = multiplyMatrix(translate, scale);
  // `multiply(m, n)` means "n first, then m" — scale 5 to 10, then shift by 10.
  const stepwise = applyMatrix(scale, 5, 5);
  assert.deepEqual(applyMatrix(composed, 5, 5), applyMatrix(translate, stepwise.x, stepwise.y));
  assert.deepEqual(applyMatrix(composed, 5, 5), { x: 20, y: 30 });
});

/* =========================================================== preserveAspectRatio */

/**
 * The default is `xMidYMid meet`: one uniform scale, the leftover centred. A
 * 10×20 viewBox in a 20×20 box scales by 1 (not 2 horizontally), leaving 10
 * units of slack that split 5 either side.
 */
test("svg: the default preserveAspectRatio scales uniformly and centres", () => {
  const svg = `<svg viewBox="0 0 10 20"><path d="M0 0 L10 20"></path></svg>`;
  assert.deepEqual(ops(svg, { x: 0, y: 0, width: 20, height: 20 }), ["5 20 m", "15 0 l", "f"]);
});

test("svg: preserveAspectRatio=none stretches each axis independently", () => {
  const svg = `<svg viewBox="0 0 10 20" preserveAspectRatio="none"><path d="M0 0 L10 20"></path></svg>`;
  assert.deepEqual(ops(svg, { x: 0, y: 0, width: 20, height: 20 }), ["0 20 m", "20 0 l", "f"]);
});

test("svg: xMinYMin puts the slack on one side only", () => {
  const svg = `<svg viewBox="0 0 10 20" preserveAspectRatio="xMinYMin meet"><path d="M0 0 L10 20"></path></svg>`;
  assert.deepEqual(ops(svg, { x: 0, y: 0, width: 20, height: 20 }), ["0 20 m", "10 0 l", "f"]);
});

test("svg: viewBoxMatrix is the flip, stated directly", () => {
  const matrix = viewBoxMatrix(
    { minX: 0, minY: -833.9, width: 1008.6, height: 844.9 },
    { x: 0, y: 0, width: 1008.6, height: 844.9 },
    { align: "xMidYMid", slice: false },
  );
  assert.deepEqual(matrix, [1, 0, 0, -1, 0, 11]);
  // The viewBox's top edge lands on the box's top edge, its bottom on the bottom.
  assert.deepEqual(applyMatrix(matrix, 0, -833.9), { x: 0, y: 844.9 });
});

/* ============================================================ paint handling */

test("svg: fill=none paints nothing", () => {
  assert.deepEqual(ops(pathDoc("M0 0 L10 10", ' fill="none"')), []);
});

test("svg: fill-rule=evenodd selects f*", () => {
  assert.deepEqual(ops(pathDoc("M0 0 L10 10", ' fill-rule="evenodd"')).at(-1), "f*");
});

/**
 * `currentColor` — which is all MathJax writes — emits no colour operator, so
 * the formula inherits whatever the page stream set. `content.ts` opens every
 * page with `0 g`, and SVG's initial `fill` is black, so the two agree.
 */
test("svg: currentColor emits no colour operator", () => {
  assert.equal(ops(pathDoc("M0 0 L10 10", ' fill="currentColor"')).join(" ").includes("rg"), false);
});

/** A concrete colour is bracketed by q/Q so it cannot leak into the page. */
test("svg: a hex fill is set inside q/Q", () => {
  assert.deepEqual(ops(pathDoc("M0 0 L10 10", ' fill="#f00"')), [
    "q",
    "1 0 0 rg",
    "0 100 m",
    "10 90 l",
    "f",
    "Q",
  ]);
});

test("svg: paint is inherited down the group tree", () => {
  const svg =
    `<svg viewBox="0 0 100 100"><g fill="none"><path d="M0 0 L10 10"></path>` +
    `<path d="M0 0 L10 10" fill="currentColor"></path></g></svg>`;
  // The first path inherits `none` and paints nothing; the second overrides it.
  assert.deepEqual(ops(svg), ["0 100 m", "10 90 l", "f"]);
});

/** MathJax's real preamble: a stroke colour with a zero width is not a stroke. */
test("svg: stroke-width 0 is not a stroke", () => {
  const svg =
    `<svg viewBox="0 0 100 100"><g stroke="currentColor" fill="currentColor" stroke-width="0">` +
    `<path d="M0 0 L10 10"></path></g></svg>`;
  assert.deepEqual(ops(svg), ["0 100 m", "10 90 l", "f"]);
});

/* ==================================================================== <rect> */

/**
 * A `<rect>` is emitted as four transformed corners rather than PDF's `re`,
 * because `re` is axis-aligned in *page* space while the CTM need not be.
 */
test("svg: rect becomes four corners and a close", () => {
  const svg = `<svg viewBox="0 0 100 100"><rect x="10" y="20" width="30" height="40"></rect></svg>`;
  assert.deepEqual(ops(svg), ["10 80 m", "40 80 l", "40 40 l", "10 40 l", "h", "f"]);
});

test("svg: rect x and y default to zero", () => {
  const svg = `<svg viewBox="0 0 100 100"><rect width="10" height="10"></rect></svg>`;
  assert.deepEqual(ops(svg), ["0 100 m", "10 100 l", "10 90 l", "0 90 l", "h", "f"]);
});

test("svg: a zero-extent rect paints nothing", () => {
  assert.deepEqual(ops(`<svg viewBox="0 0 100 100"><rect width="0" height="10"></rect></svg>`), []);
});

test("svg: a rect under a skewing matrix stays a parallelogram, not a re", () => {
  const svg =
    `<svg viewBox="0 0 100 100"><g transform="matrix(1 0 1 1 0 0)">` +
    `<rect x="0" y="0" width="10" height="10"></rect></g></svg>`;
  // The `c` term shears x by y, so the top corners slide right by 10.
  assert.deepEqual(ops(svg), ["0 100 m", "10 100 l", "20 90 l", "10 90 l", "h", "f"]);
});

/* ============================================ the loud guards (D38, brief 40 §2) */

/**
 * The guard brief 40's settled calls asked for by name. `fontCache: "none"`
 * inlines every glyph outline, so a `<use>` means that assumption broke — and
 * the failure it prevents is every glyph in the document silently disappearing.
 */
test("svg: <use> fails loudly instead of dropping a glyph", () => {
  const svg = `<svg viewBox="0 0 100 100"><g><use href="#g1" x="0" y="0"></use></g></svg>`;
  const d = refusal(svg);
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /<use>/);
  // The message must point at the cause, not just name the element.
  assert.match(d.message, /fontCache/);
});

test("svg: <defs> is refused too — with fontCache none there is nothing to define", () => {
  const d = refusal(`<svg viewBox="0 0 100 100"><defs></defs><path d="M0 0 L1 1"></path></svg>`);
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /<defs>/);
});

test("svg: <use> is refused even when other glyphs would have rendered", () => {
  const svg =
    `<svg viewBox="0 0 100 100"><path d="M0 0 L10 10"></path><use href="#g1"></use></svg>`;
  const d = refusal(svg);
  assert.equal(d.code, "unsupported");
  // Nothing at all is painted: half a formula is the silent wrong answer.
  assert.equal(svgToOperators(svg, UNIT, AT).operators.length, 0);
});

/**
 * Arcs. Probed on 2026-08-29 against `mathjax@4.1.3`: its path data uses only
 * `M`, `L`, `C` and `Z`, so an `A` here means an assumption changed. Refusing
 * is the settled call — an arc-to-Bézier conversion nothing exercises is worse
 * than a diagnostic that says what happened.
 */
test("svg: an arc command is refused with a diagnostic, not approximated", () => {
  const d = refusal(pathDoc("M0 0 A5 5 0 0 1 10 10"));
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /arc/);
  assert.equal(refusal(pathDoc("M0 0 a5 5 0 0 1 10 10")).code, "unsupported");
});

test("svg: an unknown element is refused by name", () => {
  const d = refusal(`<svg viewBox="0 0 100 100"><circle cx="1" cy="1" r="1"></circle></svg>`);
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /<circle>/);
});

test("svg: <text> is refused, which is what makes discarding text nodes safe", () => {
  const d = refusal(`<svg viewBox="0 0 100 100"><text x="0" y="0">hello</text></svg>`);
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /<text>/);
});

/** Ignoring an opacity paints a picture that is wrong with nothing saying so. */
test("svg: a paint-changing attribute is refused rather than ignored", () => {
  for (const attribute of ["opacity", "fill-opacity", "clip-path", "mask", "filter", "display", "visibility"]) {
    const d = refusal(pathDoc("M0 0 L10 10", ` ${attribute}="0.3"`));
    assert.equal(d.code, "unsupported", attribute);
    assert.match(d.message, new RegExp(attribute.replace("-", "\\-")));
  }
});

test("svg: a style attribute below the root is refused — CSS could override the fill", () => {
  const svg = `<svg viewBox="0 0 100 100"><g style="fill:none"><path d="M0 0 L10 10"></path></g></svg>`;
  const d = refusal(svg);
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /style/);
});

test("svg: a real stroke is refused — a PDF line width cannot express it under a skew", () => {
  const d = refusal(pathDoc("M0 0 L10 10", ' stroke="#000" stroke-width="2"'));
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /stroke/);
});

test("svg: rotate and skew transforms are refused by name", () => {
  for (const fn of ["rotate(45)", "skewX(10)", "skewY(10)"]) {
    const svg = `<svg viewBox="0 0 100 100"><g transform="${fn}"><path d="M0 0 L1 1"></path></g></svg>`;
    const d = refusal(svg);
    assert.equal(d.code, "unsupported", fn);
    assert.match(d.message, new RegExp(fn.slice(0, fn.indexOf("("))));
  }
});

test("svg: preserveAspectRatio slice is refused — it needs a clip this engine does not emit", () => {
  const svg = `<svg viewBox="0 0 10 20" preserveAspectRatio="xMidYMid slice"><path d="M0 0 L1 1"></path></svg>`;
  const d = refusal(svg, { x: 0, y: 0, width: 20, height: 20 });
  assert.equal(d.code, "unsupported");
  assert.match(d.message, /slice/);
});

test("svg: a rounded rect is refused", () => {
  const svg = `<svg viewBox="0 0 100 100"><rect width="10" height="10" rx="2"></rect></svg>`;
  assert.equal(refusal(svg).code, "unsupported");
});

/* ================================================= malformed input is internal */

/**
 * A malformed SVG is the *engine's* bug, not the author's: MathJax produced it
 * inside `compile()`. Reporting `syntax` would tell a writer their LaTeX is
 * broken when it is not, which is the code-conflation `wiki/typeset.md` says is
 * treated as a bug rather than a detail.
 */
test("svg: malformed markup is an internal error, never a syntax one", () => {
  for (const source of [
    `<svg viewBox="0 0 1 1"><g><path d="M0 0"></g></svg>`,
    `<svg viewBox="0 0 1 1"><path d="M0 0"`,
    `<svg viewBox="0 0 1 1"><path d=M0></path></svg>`,
  ]) {
    const d = refusal(source);
    assert.equal(d.code, "internal", source);
  }
});

test("svg: a missing or unreadable viewBox is an internal error", () => {
  assert.equal(refusal(`<svg><path d="M0 0"></path></svg>`).code, "internal");
  assert.equal(refusal(`<svg viewBox="0 0 1"><path d="M0 0"></path></svg>`).code, "internal");
  assert.equal(refusal(`<svg viewBox="0 0 0 10"><path d="M0 0"></path></svg>`).code, "internal");
});

test("svg: path data that does not start with a moveto is an internal error", () => {
  assert.equal(refusal(pathDoc("L10 10")).code, "internal");
  assert.equal(refusal(pathDoc("M0 0 L10")).code, "internal");
  assert.equal(refusal(pathDoc("M0 0 X10 10")).code, "internal");
});

test("svg: a degenerate target box paints nothing and reports nothing", () => {
  const result = svgToOperators(pathDoc("M0 0 L10 10"), { x: 0, y: 0, width: 0, height: 10 }, AT);
  assert.deepEqual(result.operators, []);
  assert.deepEqual(result.diagnostics, []);
});

test("svg: a non-finite target box is an internal error", () => {
  const result = svgToOperators(pathDoc("M0 0 L10 10"), { x: 0, y: 0, width: Number.NaN, height: 10 }, AT);
  assert.deepEqual(result.operators, []);
  assert.equal(result.diagnostics[0]?.code, "internal");
});

test("svg: diagnostics carry the caller's file and line", () => {
  const d = refusal(pathDoc("M0 0 A5 5 0 0 1 10 10"));
  assert.equal(d.file, "main.tex");
  assert.equal(d.line, 12);
});

/* ==================================================== parsing the container */

test("svg: the <svg> is found inside MathJax's <mjx-container>", () => {
  const source = readFileSync(join(FIXTURES, "mathjax-x-squared.svg"), "utf8");
  const { document, diagnostics } = parseSvg(source, AT);
  assert.deepEqual(diagnostics, []);
  assert.ok(document);
  assert.equal(document.root.name, "svg");
  assert.deepEqual(document.viewBox, { minX: 0, minY: -833.9, width: 1008.6, height: 844.9 });
  // The container carries what placement needs: `ex` sizes and the baseline.
  assert.deepEqual(document.width, { value: 2.282, unit: "ex" });
  assert.deepEqual(document.height, { value: 1.912, unit: "ex" });
  assert.deepEqual(document.verticalAlign, { value: -0.025, unit: "ex" });
});

/**
 * The split surface, which is the one chunk 40.4 uses: parse once to read the
 * container's `ex` sizes and its baseline, decide a target box from them, then
 * emit. `svgToOperators` is the same two calls for callers that need neither.
 */
test("svg: parse-then-emit gives the same operators as the one-shot call", () => {
  const source = readFileSync(join(FIXTURES, "mathjax-x-squared.svg"), "utf8");
  const box: SvgTargetBox = { x: 5, y: 7, width: 100.86, height: 84.49 };
  const { document, diagnostics } = parseSvg(source, AT);
  assert.deepEqual(diagnostics, []);
  assert.ok(document);
  const emitted = emitSvg(document, box, AT);
  assert.deepEqual(emitted.diagnostics, []);
  assert.deepEqual(emitted.operators, svgToOperators(source, box, AT).operators);
  // The same document can be painted into a second box without carrying state.
  const other = emitSvg(document, { x: 0, y: 0, width: 50, height: 50 }, AT);
  assert.notDeepEqual(other.operators, emitted.operators);
  assert.equal(other.operators.length, emitted.operators.length);
});

test("svg: parseSvgLength keeps the unit unresolved", () => {
  assert.deepEqual(parseSvgLength("2.282ex"), { value: 2.282, unit: "ex" });
  assert.deepEqual(parseSvgLength(" -1.577ex "), { value: -1.577, unit: "ex" });
  assert.deepEqual(parseSvgLength("12"), { value: 12, unit: "" });
  assert.equal(parseSvgLength("auto"), null);
});

test("svg: parseTransform reports the transform it could not read", () => {
  const { matrix, diagnostics } = parseTransform("translate(", AT);
  assert.equal(matrix, null);
  assert.equal(diagnostics[0]?.code, "internal");
});

/* ======================================== real MathJax output, end to end */

/**
 * `x^2`, straight out of `mathjax@4.1.3`, painted 1:1 into its own viewBox.
 *
 * The claim under test is orientation on *real* content, which the synthetic
 * cases cannot make: a superscript must sit **above** the base. Under a double
 * flip the whole picture inverts and the `2` drops below the `x`, so comparing
 * the two glyphs' extents is the assertion that a wrong sign cannot survive.
 *
 * The two glyphs are told apart by x: MathJax places the `2` with
 * `transform="translate(605,363) scale(0.707)"`, so nothing of the `x` reaches
 * x = 605.
 */
test("svg: a real MathJax x² puts the superscript above the base", () => {
  const source = readFileSync(join(FIXTURES, "mathjax-x-squared.svg"), "utf8");
  const box: SvgTargetBox = { x: 0, y: 0, width: 1008.6, height: 844.9 };
  const result = svgToOperators(source, box, AT);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.operators.length > 50, "the outlines should be dozens of operators");

  const base = { top: -Infinity, bottom: Infinity };
  const script = { top: -Infinity, bottom: Infinity };
  for (const { x, y } of coordinates(result.operators)) {
    const into = x >= 605 ? script : base;
    into.top = Math.max(into.top, y);
    into.bottom = Math.min(into.bottom, y);
  }

  // Both glyphs sit inside the box they were given.
  assert.ok(base.bottom >= -1 && script.bottom >= -1, `ink below the box: ${base.bottom}, ${script.bottom}`);
  assert.ok(base.top <= 845 && script.top <= 845, `ink above the box: ${base.top}, ${script.top}`);
  // The superscript's top is far above the base's top. Flip the picture and
  // this inequality reverses.
  assert.ok(
    script.top > base.top + 300,
    `superscript top ${script.top} should clear base top ${base.top} by 300+`,
  );
  // And the superscript's baseline is above the base's baseline: MathJax's
  // `translate(605,363)` raises it by 363 font units.
  assert.ok(script.bottom > base.bottom + 300, `${script.bottom} vs ${base.bottom}`);
});

/**
 * `\frac{a}{b}`. The fraction bar is a `<rect>` — `x="120" y="220" width="729"
 * height="60"` inside MathJax's `scale(1,-1)` — and its four corners are
 * computable by hand, so this asserts them exactly rather than approximately.
 *
 * With `viewBox="0 -1118 969 1815"` painted 1:1, the viewBox matrix is
 * `[1, 0, 0, -1, 0, 697]`; composed with `scale(1,-1)` that becomes
 * `[1, 0, 0, 1, 0, 697]`, so a rect corner at user `(120, 220)` lands at PDF
 * `(120, 917)`.
 */
test("svg: a real MathJax fraction bar lands on exact coordinates", () => {
  const source = readFileSync(join(FIXTURES, "mathjax-frac-a-b.svg"), "utf8");
  const box: SvgTargetBox = { x: 0, y: 0, width: 969, height: 1815 };
  const result = svgToOperators(source, box, AT);
  assert.deepEqual(result.diagnostics, []);

  const bar = ["120 917 m", "849 917 l", "849 977 l", "120 977 l", "h"];
  const at = result.operators.findIndex((op) => op === bar[0]);
  assert.notEqual(at, -1, "the fraction bar's first corner is missing");
  assert.deepEqual(result.operators.slice(at, at + bar.length), bar);

  // The numerator sits above the bar and the denominator below it — the whole
  // point of a fraction, and the thing a flipped y-axis gets backwards.
  const numerator = { bottom: Infinity };
  const denominator = { top: -Infinity };
  for (const { y } of coordinates(result.operators)) {
    if (y > 977) numerator.bottom = Math.min(numerator.bottom, y);
    if (y < 917) denominator.top = Math.max(denominator.top, y);
  }
  assert.ok(numerator.bottom > 977, "there is ink above the bar");
  assert.ok(denominator.top < 917, "there is ink below the bar");
});

test("svg: the same SVG converts identically twice", () => {
  const source = readFileSync(join(FIXTURES, "mathjax-frac-a-b.svg"), "utf8");
  const box: SvgTargetBox = { x: 10, y: 20, width: 96.9, height: 181.5 };
  assert.deepEqual(svgToOperators(source, box, AT), svgToOperators(source, box, AT));
});

/** Every (x, y) pair in an operator list, whatever operator carried it. */
function* coordinates(operators: readonly string[]): Generator<{ x: number; y: number }> {
  for (const op of operators) {
    const parts = op.split(" ");
    const verb = parts[parts.length - 1]!;
    if (verb !== "m" && verb !== "l" && verb !== "c") continue;
    const numbers = parts.slice(0, -1).map(Number);
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      yield { x: numbers[i]!, y: numbers[i + 1]! };
    }
  }
}
