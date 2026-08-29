import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, hasErrors, unsupported } from "../diagnostics.ts";
import { formatNumber } from "./numbers.ts";

/**
 * SVG → PDF content-stream operators (brief 40, chunk 40.1).
 *
 * **What this is for.** Brief 40 sets mathematics by handing the run to MathJax
 * and converting its SVG output ourselves, rather than reimplementing TeX's
 * mlist layout. This file is that conversion, and nothing else: it knows about
 * paths, rectangles, transforms and a viewBox. It knows nothing about TeX,
 * about `src/math/`, or about where on the page the result goes. Give it an
 * SVG string and a rectangle in PDF page space and it gives back operators.
 *
 * ## The subset is exactly what MathJax emits, and refusing the rest is the point
 *
 * Probed against `mathjax@4.1.3` with `svg: { fontCache: "none" }` on 2026-08-29
 * across fractions, radicals, matrices, `\left…\right`, sums, integrals,
 * accents, over/underbraces and `\text`: the output contains only `<svg>`,
 * `<g>`, `<path>` and `<rect>`; path data uses only `M`, `L`, `C` and `Z`, all
 * absolute; transforms are only `translate`, `scale` and `matrix`, sometimes
 * several in one list; and there is **no `<use>` and no `<defs>`** — that is
 * what `fontCache: "none"` buys, and it is why this file resolves no references
 * (D41, brief 40's settled calls §2).
 *
 * The parser nevertheless implements the *whole* path grammar except arcs,
 * because relative commands, `H`/`V`, `S`, `Q` and `T` cost about eighty lines
 * and cover the case where a MathJax upgrade changes its font-outline encoder.
 * Arcs (`A`/`a`) and `rotate`/`skew` transforms are **refused with a
 * diagnostic** rather than implemented: converting an arc to cubics is fiddly,
 * verified-unused code, and untested code that runs is worse than a refusal
 * that says so.
 *
 * ## The loud-failure contract (D38) applied to a picture
 *
 * The failure mode this file exists to avoid is a formula that renders with a
 * glyph or a fraction bar quietly missing. So:
 *
 * - **`<use>` is refused by name**, with a message pointing at `fontCache`,
 *   because a `<use>` appearing means the assumption above broke and every
 *   glyph in the document is about to vanish.
 * - Every element that is not `<svg>`, `<g>`, `<path>` or `<rect>` is refused,
 *   by name. There is no "skip what we do not know" branch.
 * - Every attribute that could silently *change* the picture — `style` outside
 *   the root, `opacity`, `clip-path`, `mask`, `filter`, `display`,
 *   `visibility` — is refused rather than ignored. Ignoring `opacity="0.3"`
 *   paints something the author cannot tell is wrong.
 * - **An error abandons the whole SVG**: `emitSvg` returns no operators at all
 *   rather than a half-drawn formula. Half a formula is the silent-wrong-answer
 *   case with extra steps.
 *
 * ## Which diagnostic code, and why
 *
 * A malformed SVG is `internal`, not `syntax`. `syntax` means the *author's*
 * LaTeX would not parse; the SVG here is produced by MathJax inside the engine,
 * so a `d` string this file cannot read is our bug and must not be reported as
 * the writer's. A construct we chose not to implement is `unsupported`, the
 * same code `\rotatebox` gets. Neither carries a `construct` field: that field
 * is specified as "the single LaTeX construct this is about", and `<rect>` is
 * not one.
 *
 * ## Coordinates
 *
 * Two conventions meet here and both are load-bearing.
 *
 * SVG's y grows **downward** from the top-left of the viewport; PDF's grows
 * **upward** from the bottom-left of the page. The flip lives in exactly one
 * place, `viewBoxMatrix`, folded into the viewBox → target-box mapping. MathJax
 * separately puts `transform="scale(1,-1)"` on its outer `<g>` because its
 * glyph outlines are in font units with y up; that is an ordinary transform in
 * the tree and composes on top of the flip. It is **not** a second flip, and
 * the pair is asserted with real coordinates in `test/svg.test.ts`.
 *
 * The transform tree is **baked into the emitted numbers** rather than written
 * out as `cm` operators. A cubic Bézier is affine-invariant, so transforming
 * the control points is exact, and it matches how `content.ts` positions
 * glyphs: this engine computes positions and states them, rather than asking a
 * renderer to compute them. It also means a test can read a coordinate straight
 * out of the operator list.
 */

/* ------------------------------------------------------------------ types */

/** A length as written in the SVG, unit unresolved — `"2.282ex"` → `2.282`, `"ex"`. */
export interface SvgLength {
  value: number;
  /** `""` when the number was written bare (SVG's "user units"). */
  unit: string;
}

export interface SvgViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** A parsed element. Text nodes are not represented — see `parseSvg`. */
export interface SvgElement {
  /** Local name, lower-cased for the elements we act on; namespace prefix kept. */
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly SvgElement[];
}

/** The `<svg>` root plus the attributes a caller placing the picture needs. */
export interface SvgDocument {
  root: SvgElement;
  /**
   * Required. An SVG with no `viewBox` has no intrinsic coordinate system to
   * map, so this file refuses one rather than inventing a scale.
   */
  viewBox: SvgViewBox;
  /** The root `width` attribute. MathJax writes `ex`; resolving that is the caller's job. */
  width?: SvgLength;
  /** The root `height` attribute. */
  height?: SvgLength;
  /**
   * `vertical-align` out of the root `style`, when present. MathJax puts the
   * baseline offset here (`style="vertical-align: -1.577ex;"`) and it is the
   * only reason this file reads a `style` attribute at all — it is placement
   * information, not paint.
   */
  verticalAlign?: SvgLength;
}

/**
 * Where the picture goes, in **PDF page space**: points, y up, origin at the
 * page's bottom-left, `x`/`y` naming the box's **bottom-left** corner.
 *
 * Deliberately not layout space. `content.ts` documents itself as the one place
 * that converts y-down layout coordinates to y-up PDF ones; this file takes the
 * converted rectangle so that stays true.
 */
export interface SvgTargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `[a, b, c, d, e, f]`, the same six numbers SVG's `matrix()` and PDF's `cm`
 * both use: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 */
export type SvgMatrix = readonly [number, number, number, number, number, number];

export interface SvgParseResult {
  /** `null` when `diagnostics` carries an error. */
  document: SvgDocument | null;
  diagnostics: Diagnostic[];
}

export interface SvgEmission {
  /** One PDF operator per entry, ready to join with newlines. Empty on any error. */
  operators: string[];
  diagnostics: Diagnostic[];
}

export const SVG_IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

/* --------------------------------------------------------------- matrices */

/** `apply(multiply(m, n), p) === apply(m, apply(n, p))` — `n` runs first. */
export function multiplyMatrix(m: SvgMatrix, n: SvgMatrix): SvgMatrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMatrix(m: SvgMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/* ---------------------------------------------------------------- numbers */

interface Scanner {
  text: string;
  i: number;
}

function isWsp(code: number): boolean {
  // Space, tab, LF, CR, FF — SVG's wsp production.
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function skipWsp(s: Scanner): void {
  while (s.i < s.text.length && isWsp(s.text.charCodeAt(s.i))) s.i++;
}

/** Whitespace, then at most one comma, then whitespace — SVG's comma-wsp. */
function skipSeparator(s: Scanner): void {
  skipWsp(s);
  if (s.i < s.text.length && s.text.charCodeAt(s.i) === 0x2c /* , */) {
    s.i++;
    skipWsp(s);
  }
}

/**
 * One SVG number, or `null`. Hand-rolled rather than delegated to `Number()`
 * because path data runs numbers together: `126 18C112 18 99 21 88 26` and
 * `329-11` are both two numbers, and `1.5.5` is `1.5` followed by `.5`. A
 * regex-and-split would get the last one wrong, and getting it wrong moves a
 * glyph rather than failing.
 */
function readNumber(s: Scanner): number | null {
  const start = s.i;
  const text = s.text;
  if (s.i < text.length) {
    const sign = text.charCodeAt(s.i);
    if (sign === 0x2b /* + */ || sign === 0x2d /* - */) s.i++;
  }

  let digits = 0;
  while (s.i < text.length && isDigit(text.charCodeAt(s.i))) {
    s.i++;
    digits++;
  }
  if (s.i < text.length && text.charCodeAt(s.i) === 0x2e /* . */) {
    s.i++;
    while (s.i < text.length && isDigit(text.charCodeAt(s.i))) {
      s.i++;
      digits++;
    }
  }
  if (digits === 0) {
    s.i = start;
    return null;
  }

  // The exponent is only consumed when it is complete: `1e` is the number `1`
  // followed by something this parser will reject, not a broken number.
  const afterMantissa = s.i;
  if (s.i < text.length) {
    const e = text.charCodeAt(s.i);
    if (e === 0x65 /* e */ || e === 0x45 /* E */) {
      s.i++;
      if (s.i < text.length) {
        const expSign = text.charCodeAt(s.i);
        if (expSign === 0x2b || expSign === 0x2d) s.i++;
      }
      let expDigits = 0;
      while (s.i < text.length && isDigit(text.charCodeAt(s.i))) {
        s.i++;
        expDigits++;
      }
      if (expDigits === 0) s.i = afterMantissa;
    }
  }

  const value = Number(text.slice(start, s.i));
  return Number.isFinite(value) ? value : null;
}

/** A number with an optional unit suffix: `"2.282ex"`, `"12"`, `"-1.577ex"`. */
export function parseSvgLength(raw: string): SvgLength | null {
  const s: Scanner = { text: raw.trim(), i: 0 };
  const value = readNumber(s);
  if (value === null) return null;
  const unit = s.text.slice(s.i).trim();
  // A trailing `;` is legal inside a `style` declaration list.
  const cleaned = unit.endsWith(";") ? unit.slice(0, -1).trim() : unit;
  if (cleaned !== "" && !/^[A-Za-z%]+$/.test(cleaned)) return null;
  return { value, unit: cleaned };
}

/* ------------------------------------------------------------- XML parsing */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const code =
        body.charCodeAt(1) === 0x78 /* x */ || body.charCodeAt(1) === 0x58
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // A code point outside Unicode is corruption; leaving the reference
      // untouched keeps it visible instead of throwing from `fromCodePoint`.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_:]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_:.\-]/.test(ch);
}

/**
 * A markup parser for exactly the shape MathJax's `LiteAdaptor` writes:
 * elements, attributes, and nothing else that renders. Text nodes are
 * **discarded**, which is safe only because `<text>` is refused as an element
 * — with no text-rendering element in the subset, character data inside the
 * tree cannot carry anything a reader would see.
 *
 * There is no DOM here to borrow: `src/` compiles with `"types": []` and must
 * run unchanged in the browser bundle, so `DOMParser` is not available and
 * neither is anything from Node (D38).
 */
function parseMarkup(source: string, at: SourceRef): { roots: SvgElement[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const roots: SvgElement[] = [];
  interface Frame {
    name: string;
    attributes: Record<string, string>;
    children: SvgElement[];
  }
  const stack: Frame[] = [];

  const fail = (message: string): { roots: SvgElement[]; diagnostics: Diagnostic[] } => {
    diagnostics.push(error("internal", at, `SVG output could not be parsed — ${message}`));
    return { roots: [], diagnostics };
  };

  const push = (element: SvgElement): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(element);
    else parent.children.push(element);
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;

    if (source.startsWith("!--", i)) {
      const end = source.indexOf("-->", i + 3);
      if (end < 0) return fail("an unterminated comment");
      i = end + 3;
      continue;
    }
    if (source.charCodeAt(i) === 0x21 /* ! */ || source.charCodeAt(i) === 0x3f /* ? */) {
      // `<!DOCTYPE …>` and `<?xml …?>`. Neither can appear inside the `<svg>`
      // subtree, so skipping to the next `>` cannot swallow drawable content.
      const end = source.indexOf(">", i);
      if (end < 0) return fail("an unterminated declaration");
      i = end + 1;
      continue;
    }

    if (source.charCodeAt(i) === 0x2f /* / */) {
      i++;
      const start = i;
      while (i < source.length && isNameChar(source[i]!)) i++;
      const name = source.slice(start, i);
      const end = source.indexOf(">", i);
      if (end < 0) return fail(`an unterminated closing tag for \`${name}\``);
      i = end + 1;
      const frame = stack.pop();
      if (frame === undefined) return fail(`a closing tag \`</${name}>\` with nothing open`);
      if (frame.name !== name) {
        return fail(`\`</${name}>\` closing \`<${frame.name}>\``);
      }
      push({ name: frame.name, attributes: frame.attributes, children: frame.children });
      continue;
    }

    if (i >= source.length || !isNameStart(source[i]!)) return fail("a `<` that starts no tag");
    const nameStart = i;
    while (i < source.length && isNameChar(source[i]!)) i++;
    const name = source.slice(nameStart, i);

    const attributes: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (i < source.length && isWsp(source.charCodeAt(i))) i++;
      if (i >= source.length) return fail(`an unterminated \`<${name}>\` tag`);
      const ch = source.charCodeAt(i);
      if (ch === 0x3e /* > */) {
        i++;
        break;
      }
      if (ch === 0x2f /* / */) {
        if (source.charCodeAt(i + 1) !== 0x3e) return fail(`a stray \`/\` in \`<${name}>\``);
        selfClosing = true;
        i += 2;
        break;
      }
      if (!isNameStart(source[i]!)) return fail(`an unreadable attribute in \`<${name}>\``);
      const attrStart = i;
      while (i < source.length && isNameChar(source[i]!)) i++;
      const attrName = source.slice(attrStart, i);
      while (i < source.length && isWsp(source.charCodeAt(i))) i++;
      if (source.charCodeAt(i) !== 0x3d /* = */) {
        // A bare attribute is HTML, not XML. MathJax never writes one, and
        // guessing a value for it is exactly what this file does not do.
        return fail(`the valueless attribute \`${attrName}\` in \`<${name}>\``);
      }
      i++;
      while (i < source.length && isWsp(source.charCodeAt(i))) i++;
      const quote = source.charCodeAt(i);
      if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
        return fail(`an unquoted value for \`${attrName}\` in \`<${name}>\``);
      }
      i++;
      const valueStart = i;
      const close = source.indexOf(String.fromCharCode(quote), i);
      if (close < 0) return fail(`an unterminated value for \`${attrName}\` in \`<${name}>\``);
      i = close + 1;
      attributes[attrName] = decodeEntities(source.slice(valueStart, close));
    }

    if (selfClosing) push({ name, attributes, children: [] });
    else stack.push({ name, attributes, children: [] });
  }

  if (stack.length > 0) {
    return fail(`\`<${stack[stack.length - 1]!.name}>\` was never closed`);
  }
  return { roots, diagnostics };
}

function findElement(elements: readonly SvgElement[], name: string): SvgElement | null {
  for (const element of elements) {
    if (element.name === name) return element;
    const nested = findElement(element.children, name);
    if (nested !== null) return nested;
  }
  return null;
}

function parseViewBox(raw: string): SvgViewBox | null {
  const s: Scanner = { text: raw, i: 0 };
  const values: number[] = [];
  for (let n = 0; n < 4; n++) {
    skipSeparator(s);
    const value = readNumber(s);
    if (value === null) return null;
    values.push(value);
  }
  skipWsp(s);
  if (s.i !== s.text.length) return null;
  const [minX, minY, width, height] = values as [number, number, number, number];
  // A zero or negative extent disables rendering per the SVG spec, and a
  // negative one is invalid outright; either way there is no mapping to make.
  if (!(width > 0) || !(height > 0)) return null;
  return { minX, minY, width, height };
}

/** Pulls `vertical-align` out of a `style` attribute. Nothing else is read. */
function readVerticalAlign(style: string): SvgLength | null {
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() !== "vertical-align") continue;
    return parseSvgLength(declaration.slice(colon + 1));
  }
  return null;
}

/**
 * The markup to an `SvgDocument`. The first `<svg>` element **anywhere** in the
 * input is the root, so this accepts MathJax's `adaptor.outerHTML(node)` —
 * which wraps the `<svg>` in an `<mjx-container>` — as well as a bare `<svg>`.
 * The wrapper is a layout hook with no drawable content, so looking past it
 * drops nothing.
 */
export function parseSvg(source: string, at: SourceRef): SvgParseResult {
  const { roots, diagnostics } = parseMarkup(source, at);
  if (hasErrors(diagnostics)) return { document: null, diagnostics };

  const root = findElement(roots, "svg");
  if (root === null) {
    diagnostics.push(error("internal", at, "SVG output contains no `<svg>` element"));
    return { document: null, diagnostics };
  }

  const rawViewBox = root.attributes["viewBox"];
  if (rawViewBox === undefined) {
    diagnostics.push(
      error("internal", at, "the `<svg>` element has no `viewBox`, so it has no coordinate system to map"),
    );
    return { document: null, diagnostics };
  }
  const viewBox = parseViewBox(rawViewBox);
  if (viewBox === null) {
    diagnostics.push(error("internal", at, `the \`<svg>\` \`viewBox\` is unreadable: \`${rawViewBox}\``));
    return { document: null, diagnostics };
  }

  const document: SvgDocument = { root, viewBox };
  const width = root.attributes["width"];
  if (width !== undefined) {
    const parsed = parseSvgLength(width);
    if (parsed !== null) document.width = parsed;
  }
  const height = root.attributes["height"];
  if (height !== undefined) {
    const parsed = parseSvgLength(height);
    if (parsed !== null) document.height = parsed;
  }
  const style = root.attributes["style"];
  if (style !== undefined) {
    const parsed = readVerticalAlign(style);
    if (parsed !== null) document.verticalAlign = parsed;
  }
  return { document, diagnostics };
}

/* ------------------------------------------------------ the viewBox mapping */

const ALIGN_VALUES: readonly string[] = [
  "none",
  "xMinYMin",
  "xMidYMin",
  "xMaxYMin",
  "xMinYMid",
  "xMidYMid",
  "xMaxYMid",
  "xMinYMax",
  "xMidYMax",
  "xMaxYMax",
];

export interface AspectRatio {
  align: string;
  slice: boolean;
}

function parsePreserveAspectRatio(raw: string | undefined): AspectRatio | null {
  if (raw === undefined) return { align: "xMidYMid", slice: false };
  const parts = raw.trim().split(/\s+/).filter((p) => p !== "");
  // The `defer` keyword only means anything on `<image>`, which is not in the
  // subset; accepting and dropping it here would be the one place this file
  // ignores something, so it is simply not accepted.
  if (parts.length === 0 || parts.length > 2) return null;
  const align = parts[0]!;
  if (!ALIGN_VALUES.includes(align)) return null;
  const meetOrSlice = parts[1];
  if (meetOrSlice === undefined) return { align, slice: false };
  if (meetOrSlice === "meet") return { align, slice: false };
  if (meetOrSlice === "slice") return { align, slice: true };
  return null;
}

/**
 * viewBox coordinates → PDF page coordinates, **including the y-axis flip**.
 *
 * The two-step derivation, because this is the function most likely to be
 * quietly wrong. A user-space point `(ux, uy)` lands in the viewport at
 * `(px, py)` where `py` is measured *down* from the box's top edge:
 *
 * ```
 * px = (ux - minX) · sx + alignX
 * py = (uy - minY) · sy + alignY
 * ```
 *
 * and PDF measures *up* from the page's bottom, so with the box's bottom-left
 * corner at `(box.x, box.y)`:
 *
 * ```
 * X = box.x + px
 * Y = box.y + box.height - py
 * ```
 *
 * Substituting gives the six numbers below. The `-sy` on the diagonal **is**
 * the flip, and it happens here once. MathJax's own `scale(1,-1)` is a child
 * transform that composes on top of this and un-flips its font-unit outlines;
 * applying the flip a second time here would cancel it and set every formula
 * upside down.
 */
export function viewBoxMatrix(viewBox: SvgViewBox, box: SvgTargetBox, ratio: AspectRatio): SvgMatrix {
  let sx = box.width / viewBox.width;
  let sy = box.height / viewBox.height;
  let alignX = 0;
  let alignY = 0;

  if (ratio.align !== "none") {
    const uniform = ratio.slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = uniform;
    sy = uniform;
    const slackX = box.width - viewBox.width * sx;
    const slackY = box.height - viewBox.height * sy;
    if (ratio.align.includes("xMid")) alignX = slackX / 2;
    else if (ratio.align.includes("xMax")) alignX = slackX;
    if (ratio.align.includes("YMid")) alignY = slackY / 2;
    else if (ratio.align.includes("YMax")) alignY = slackY;
  }

  return [
    sx,
    0,
    0,
    -sy,
    box.x + alignX - viewBox.minX * sx,
    box.y + box.height - alignY + viewBox.minY * sy,
  ];
}

/* ------------------------------------------------------------- transforms */

/**
 * A `transform` attribute's list. `translate(220,676)`, `translate(0 -686)`,
 * `translate(605,363) scale(0.707)` and `matrix(…)` are all forms MathJax
 * actually writes; the leftmost function is the outermost, so the list
 * multiplies left to right.
 *
 * `rotate`, `skewX` and `skewY` are recognised **so they can be refused by
 * name**. They are exact and trivial to implement, and that is the argument
 * against: MathJax emits none of them, so implementing them would ship code
 * with no test that ever exercises it under real input.
 */
export function parseTransform(raw: string, at: SourceRef): { matrix: SvgMatrix | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const s: Scanner = { text: raw, i: 0 };
  let matrix: SvgMatrix = SVG_IDENTITY;

  const bad = (message: string): { matrix: null; diagnostics: Diagnostic[] } => {
    diagnostics.push(error("internal", at, `an SVG \`transform\` could not be read — ${message}: \`${raw}\``));
    return { matrix: null, diagnostics };
  };

  for (;;) {
    skipSeparator(s);
    if (s.i >= s.text.length) break;
    const nameStart = s.i;
    while (s.i < s.text.length && /[A-Za-z]/.test(s.text[s.i]!)) s.i++;
    const name = s.text.slice(nameStart, s.i);
    if (name === "") return bad("a transform function name was expected");
    skipWsp(s);
    if (s.text.charCodeAt(s.i) !== 0x28 /* ( */) return bad(`\`${name}\` is not followed by \`(\``);
    s.i++;

    const args: number[] = [];
    for (;;) {
      skipSeparator(s);
      if (s.i < s.text.length && s.text.charCodeAt(s.i) === 0x29 /* ) */) break;
      const value = readNumber(s);
      if (value === null) return bad(`\`${name}\` has an unreadable argument`);
      args.push(value);
      if (args.length > 6) return bad(`\`${name}\` has too many arguments`);
    }
    if (s.text.charCodeAt(s.i) !== 0x29) return bad(`\`${name}\` is unterminated`);
    s.i++;

    let step: SvgMatrix;
    if (name === "translate") {
      if (args.length === 1) step = [1, 0, 0, 1, args[0]!, 0];
      else if (args.length === 2) step = [1, 0, 0, 1, args[0]!, args[1]!];
      else return bad("`translate` takes one or two arguments");
    } else if (name === "scale") {
      // `scale(s)` is `scale(s, s)`, and MathJax writes the one-argument form
      // for script-size runs: `translate(605,363) scale(0.707)`.
      if (args.length === 1) step = [args[0]!, 0, 0, args[0]!, 0, 0];
      else if (args.length === 2) step = [args[0]!, 0, 0, args[1]!, 0, 0];
      else return bad("`scale` takes one or two arguments");
    } else if (name === "matrix") {
      if (args.length !== 6) return bad("`matrix` takes six arguments");
      step = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
    } else if (name === "rotate" || name === "skewX" || name === "skewY") {
      diagnostics.push(
        unsupported(
          at,
          `the SVG transform \`${name}()\``,
          "this engine converts only `translate`, `scale` and `matrix`, which is everything MathJax emits",
        ),
      );
      return { matrix: null, diagnostics };
    } else {
      diagnostics.push(unsupported(at, `the SVG transform \`${name}()\``));
      return { matrix: null, diagnostics };
    }

    matrix = multiplyMatrix(matrix, step);
  }

  return { matrix, diagnostics };
}

/* ------------------------------------------------------------- path data */

/** Collects operators while transforming every point through one matrix. */
interface PathSink {
  ctm: SvgMatrix;
  out: string[];
  /** Whether anything at all was emitted, so an empty `d` paints no `f`. */
  drew: boolean;
}

function emitPoint(sink: PathSink, x: number, y: number): string {
  const p = applyMatrix(sink.ctm, x, y);
  return `${formatNumber(p.x)} ${formatNumber(p.y)}`;
}

/**
 * `d` to `m`/`l`/`c`/`h`, with every coordinate already in PDF page space.
 *
 * Quadratics become cubics because PDF has no quadratic operator; the
 * conversion is exact, not an approximation — a degree-2 Bézier is a degree-3
 * Bézier whose controls are `p0 + ⅔(q − p0)` and `p2 + ⅔(q − p2)`.
 */
function emitPathData(d: string, sink: PathSink, at: SourceRef): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const s: Scanner = { text: d, i: 0 };

  const bad = (message: string): Diagnostic[] => {
    diagnostics.push(error("internal", at, `SVG path data could not be read — ${message}: \`${d}\``));
    return diagnostics;
  };

  // The current point, the current subpath's first point, and the reflection
  // state `S`/`T` need. `lastCubic`/`lastQuad` are null unless the immediately
  // preceding command was of the matching family, which is what the spec says
  // decides between reflecting and reusing the current point.
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicX: number | null = null;
  let lastCubicY: number | null = null;
  let lastQuadX: number | null = null;
  let lastQuadY: number | null = null;

  let command: string | undefined;
  let first = true;

  const need = (n: number, name: string): number[] | null => {
    const args: number[] = [];
    for (let k = 0; k < n; k++) {
      skipSeparator(s);
      const value = readNumber(s);
      if (value === null) {
        bad(`\`${name}\` is missing an argument`);
        return null;
      }
      args.push(value);
    }
    return args;
  };

  for (;;) {
    skipWsp(s);
    if (s.i >= s.text.length) break;

    const ch = s.text[s.i]!;
    if (/[A-Za-z]/.test(ch)) {
      command = ch;
      s.i++;
    } else {
      if (command === undefined) return bad("it does not begin with a command");
      // An implicit repeat. After a moveto the repeat is a lineto — the one
      // place in the grammar where the repeated command is not the written one.
      if (command === "M") command = "L";
      else if (command === "m") command = "l";
      else if (command === "Z" || command === "z") return bad("`Z` takes no arguments");
    }

    if (first) {
      if (command !== "M" && command !== "m") return bad("it does not begin with a moveto");
      first = false;
    }

    const relative = command >= "a" && command <= "z";
    const upper = command.toUpperCase();
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;

    if (upper === "A") {
      diagnostics.push(
        unsupported(
          at,
          "the SVG path arc command `A`",
          "MathJax's glyph outlines are cubic Béziers and contain no arcs; rather than ship an arc-to-Bézier conversion nothing exercises, this engine refuses one and says so",
        ),
      );
      return diagnostics;
    }

    if (upper === "Z") {
      sink.out.push("h");
      sink.drew = true;
      // After a closepath the current point is the subpath's start, not the
      // point the pen was at.
      cx = startX;
      cy = startY;
      lastCubicX = null;
      lastCubicY = null;
      lastQuadX = null;
      lastQuadY = null;
      continue;
    }

    if (upper === "M") {
      const a = need(2, command);
      if (a === null) return diagnostics;
      cx = ox + a[0]!;
      cy = oy + a[1]!;
      startX = cx;
      startY = cy;
      sink.out.push(`${emitPoint(sink, cx, cy)} m`);
      sink.drew = true;
      lastCubicX = null;
      lastCubicY = null;
      lastQuadX = null;
      lastQuadY = null;
      continue;
    }

    if (upper === "L" || upper === "H" || upper === "V") {
      let nx: number;
      let ny: number;
      if (upper === "L") {
        const a = need(2, command);
        if (a === null) return diagnostics;
        nx = ox + a[0]!;
        ny = oy + a[1]!;
      } else if (upper === "H") {
        const a = need(1, command);
        if (a === null) return diagnostics;
        nx = ox + a[0]!;
        ny = cy;
      } else {
        const a = need(1, command);
        if (a === null) return diagnostics;
        nx = cx;
        ny = oy + a[0]!;
      }
      cx = nx;
      cy = ny;
      sink.out.push(`${emitPoint(sink, cx, cy)} l`);
      sink.drew = true;
      lastCubicX = null;
      lastCubicY = null;
      lastQuadX = null;
      lastQuadY = null;
      continue;
    }

    if (upper === "C" || upper === "S") {
      let x1: number;
      let y1: number;
      let x2: number;
      let y2: number;
      let x: number;
      let y: number;
      if (upper === "C") {
        const a = need(6, command);
        if (a === null) return diagnostics;
        x1 = ox + a[0]!;
        y1 = oy + a[1]!;
        x2 = ox + a[2]!;
        y2 = oy + a[3]!;
        x = ox + a[4]!;
        y = oy + a[5]!;
      } else {
        const a = need(4, command);
        if (a === null) return diagnostics;
        // Reflect the previous second control about the current point; with no
        // previous cubic the first control coincides with the current point.
        x1 = lastCubicX === null ? cx : 2 * cx - lastCubicX;
        y1 = lastCubicY === null ? cy : 2 * cy - lastCubicY;
        x2 = ox + a[0]!;
        y2 = oy + a[1]!;
        x = ox + a[2]!;
        y = oy + a[3]!;
      }
      sink.out.push(
        `${emitPoint(sink, x1, y1)} ${emitPoint(sink, x2, y2)} ${emitPoint(sink, x, y)} c`,
      );
      sink.drew = true;
      cx = x;
      cy = y;
      lastCubicX = x2;
      lastCubicY = y2;
      lastQuadX = null;
      lastQuadY = null;
      continue;
    }

    if (upper === "Q" || upper === "T") {
      let qx: number;
      let qy: number;
      let x: number;
      let y: number;
      if (upper === "Q") {
        const a = need(4, command);
        if (a === null) return diagnostics;
        qx = ox + a[0]!;
        qy = oy + a[1]!;
        x = ox + a[2]!;
        y = oy + a[3]!;
      } else {
        const a = need(2, command);
        if (a === null) return diagnostics;
        qx = lastQuadX === null ? cx : 2 * cx - lastQuadX;
        qy = lastQuadY === null ? cy : 2 * cy - lastQuadY;
        x = ox + a[0]!;
        y = oy + a[1]!;
      }
      const x1 = cx + (2 / 3) * (qx - cx);
      const y1 = cy + (2 / 3) * (qy - cy);
      const x2 = x + (2 / 3) * (qx - x);
      const y2 = y + (2 / 3) * (qy - y);
      sink.out.push(
        `${emitPoint(sink, x1, y1)} ${emitPoint(sink, x2, y2)} ${emitPoint(sink, x, y)} c`,
      );
      sink.drew = true;
      cx = x;
      cy = y;
      lastQuadX = qx;
      lastQuadY = qy;
      lastCubicX = x2;
      lastCubicY = y2;
      continue;
    }

    return bad(`\`${command}\` is not a path command`);
  }

  return diagnostics;
}

/* ------------------------------------------------------------- the walker */

/** The inherited paint properties. Everything else is refused, not inherited. */
interface Paint {
  /** `"currentColor"`, `"none"`, or `#rrggbb` normalised to three 0–1 numbers. */
  fill: string;
  fillRule: string;
  stroke: string;
  strokeWidth: number;
}

const INITIAL_PAINT: Paint = {
  // SVG's initial `fill` is black, and `content.ts` opens every page content
  // stream with `0 g`. The two agree, so "inherit the ambient colour" and
  // "black" are the same thing here and no colour operator need be emitted.
  fill: "currentColor",
  fillRule: "nonzero",
  stroke: "none",
  strokeWidth: 1,
};

/**
 * Attributes that change what a reader sees and that this file does not
 * implement. Listed rather than ignored: silently dropping `opacity="0.3"`
 * produces a picture that is wrong with nothing saying so, which is the one
 * outcome D38 exists to prevent.
 */
const REFUSED_ATTRIBUTES: readonly string[] = [
  "clip-path",
  "clip-rule",
  "display",
  "filter",
  "fill-opacity",
  "mask",
  "opacity",
  "stroke-opacity",
  "transform-origin",
  "visibility",
];

const RGB_HEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

function parseColor(raw: string): [number, number, number] | null {
  const match = RGB_HEX.exec(raw.trim());
  if (match === null) return null;
  const body = match[1]!;
  const expanded =
    body.length === 3 ? `${body[0]!}${body[0]!}${body[1]!}${body[1]!}${body[2]!}${body[2]!}` : body;
  return [
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

interface WalkState {
  out: string[];
  diagnostics: Diagnostic[];
  at: SourceRef;
  failed: boolean;
}

function refuse(state: WalkState, diagnostic: Diagnostic): void {
  state.diagnostics.push(diagnostic);
  state.failed = true;
}

/** The paint that a fill needs, or `null` when the element paints nothing. */
function resolvePaint(element: SvgElement, inherited: Paint, state: WalkState): Paint | null {
  const paint: Paint = { ...inherited };
  const fill = element.attributes["fill"];
  if (fill !== undefined) paint.fill = fill.trim();
  const fillRule = element.attributes["fill-rule"];
  if (fillRule !== undefined) paint.fillRule = fillRule.trim();
  const stroke = element.attributes["stroke"];
  if (stroke !== undefined) paint.stroke = stroke.trim();
  const strokeWidth = element.attributes["stroke-width"];
  if (strokeWidth !== undefined) {
    const parsed = parseSvgLength(strokeWidth);
    if (parsed === null || parsed.unit !== "") {
      refuse(state, error("internal", state.at, `an SVG \`stroke-width\` is unreadable: \`${strokeWidth}\``));
      return null;
    }
    paint.strokeWidth = parsed.value;
  }

  if (paint.fillRule !== "nonzero" && paint.fillRule !== "evenodd") {
    refuse(state, error("internal", state.at, `an SVG \`fill-rule\` is unreadable: \`${paint.fillRule}\``));
    return null;
  }
  return paint;
}

/**
 * `<path>` and `<rect>` both end here: the geometry is already in the operator
 * list, and this adds the fill.
 *
 * A stroke is **refused**, not approximated. Under a non-uniform `matrix()` a
 * PDF `w` line width cannot express an SVG stroke at all — the pen would be an
 * ellipse — so "stroke it anyway" would draw a different shape. MathJax writes
 * `stroke-width="0"`, so nothing real reaches this branch.
 */
function paintShape(paint: Paint, geometry: string[], state: WalkState): void {
  if (paint.stroke !== "none" && paint.stroke !== "" && paint.strokeWidth > 0) {
    refuse(
      state,
      unsupported(
        state.at,
        "a stroked SVG shape",
        "this engine fills SVG geometry only; MathJax paints its outlines with `stroke-width=\"0\"`",
      ),
    );
    return;
  }

  // `fill="none"` is the SVG-specified way to say "draw no interior". With no
  // stroke either, the element is invisible by instruction rather than by
  // omission, so there is nothing to report.
  if (paint.fill === "none") return;
  if (geometry.length === 0) return;

  const operator = paint.fillRule === "evenodd" ? "f*" : "f";
  if (paint.fill === "currentColor" || paint.fill === "") {
    state.out.push(...geometry, operator);
    return;
  }

  const colour = parseColor(paint.fill);
  if (colour === null) {
    refuse(
      state,
      unsupported(
        state.at,
        `the SVG fill \`${paint.fill}\``,
        "only `currentColor`, `none` and `#rgb`/`#rrggbb` are converted; a paint server or a colour keyword is not",
      ),
    );
    return;
  }
  // `q`/`Q` rather than restoring to black afterwards: the ambient fill colour
  // belongs to whoever built the surrounding content stream, and guessing it
  // back would be a silent change to everything drawn after this SVG.
  state.out.push("q", `${formatNumber(colour[0])} ${formatNumber(colour[1])} ${formatNumber(colour[2])} rg`);
  state.out.push(...geometry, operator);
  state.out.push("Q");
}

function walk(element: SvgElement, ctm: SvgMatrix, inherited: Paint, state: WalkState): void {
  if (state.failed) return;

  const name = element.name;

  if (name === "use") {
    // The guard brief 40's settled calls (§2) asked for by name. `fontCache:
    // "none"` inlines every glyph outline, which is what makes this file's job
    // small; a `<use>` means that stopped being true and that every glyph in
    // the document is one silent skip away from disappearing.
    refuse(
      state,
      unsupported(
        state.at,
        "the SVG `<use>` element",
        "MathJax is configured with `svg: { fontCache: \"none\" }`, which inlines glyph outlines, so a `<use>` should be impossible — this engine resolves no references and would otherwise drop the glyph silently",
      ),
    );
    return;
  }

  // Non-rendering metadata. Skipping these loses nothing a reader could see,
  // and MathJax emits `<title>` when its accessibility options are on.
  if (name === "title" || name === "desc" || name === "metadata") return;

  if (name !== "svg" && name !== "g" && name !== "path" && name !== "rect") {
    refuse(state, unsupported(state.at, `the SVG element \`<${name}>\``));
    return;
  }

  for (const attribute of REFUSED_ATTRIBUTES) {
    if (element.attributes[attribute] !== undefined) {
      refuse(
        state,
        unsupported(
          state.at,
          `the SVG attribute \`${attribute}\``,
          `it changes what a reader sees and this engine does not implement it, so \`<${name} ${attribute}="${element.attributes[attribute]}">\` is refused rather than silently ignored`,
        ),
      );
      return;
    }
  }
  // The root's `style` carries `vertical-align`, which is placement rather than
  // paint and is read by `parseSvg`. Anywhere else a `style` can override
  // `fill` or `opacity` behind this walker's back.
  if (name !== "svg" && element.attributes["style"] !== undefined) {
    refuse(
      state,
      unsupported(
        state.at,
        "an SVG `style` attribute",
        "presentation attributes are converted, CSS is not, and a `style` can silently override the fill this engine resolved",
      ),
    );
    return;
  }

  let local = ctm;
  const transform = element.attributes["transform"];
  if (transform !== undefined) {
    // The root's own `transform` is applied after the viewBox mapping, which is
    // the order the SVG spec gives them.
    const parsed = parseTransform(transform, state.at);
    state.diagnostics.push(...parsed.diagnostics);
    if (parsed.matrix === null) {
      state.failed = true;
      return;
    }
    local = multiplyMatrix(ctm, parsed.matrix);
  }

  const paint = resolvePaint(element, inherited, state);
  if (paint === null) return;

  if (name === "path") {
    const d = element.attributes["d"];
    // An absent or empty `d` renders nothing by specification. It is not a
    // dropped shape, so there is nothing to report.
    if (d !== undefined && d.trim() !== "") {
      const sink: PathSink = { ctm: local, out: [], drew: false };
      const pathDiagnostics = emitPathData(d, sink, state.at);
      state.diagnostics.push(...pathDiagnostics);
      if (hasErrors(pathDiagnostics)) {
        state.failed = true;
        return;
      }
      paintShape(paint, sink.out, state);
    }
    if (element.children.length > 0) {
      refuse(state, error("internal", state.at, "an SVG `<path>` has child elements"));
    }
    return;
  }

  if (name === "rect") {
    if (element.attributes["rx"] !== undefined || element.attributes["ry"] !== undefined) {
      refuse(
        state,
        unsupported(
          state.at,
          "a rounded SVG `<rect>`",
          "`rx`/`ry` need corner arcs; MathJax's rules and fraction bars are square",
        ),
      );
      return;
    }
    const numbers: Record<string, number> = { x: 0, y: 0, width: 0, height: 0 };
    for (const key of ["x", "y", "width", "height"]) {
      const raw = element.attributes[key];
      if (raw === undefined) continue;
      const parsed = parseSvgLength(raw);
      if (parsed === null || parsed.unit !== "") {
        refuse(state, error("internal", state.at, `an SVG \`<rect>\` \`${key}\` is unreadable: \`${raw}\``));
        return;
      }
      numbers[key] = parsed.value;
    }
    const w = numbers["width"]!;
    const h = numbers["height"]!;
    if (w < 0 || h < 0) {
      refuse(state, error("internal", state.at, `an SVG \`<rect>\` has a negative extent (${w} × ${h})`));
      return;
    }
    // Zero on either axis disables rendering per the spec — the same "draw
    // nothing on purpose" case as `fill="none"`.
    if (w > 0 && h > 0) {
      // Four transformed corners rather than PDF's `re`, because `re` is
      // axis-aligned in *page* space and the CTM here need not be: under a
      // `matrix()` the rectangle is a parallelogram, and `re` would draw a
      // different shape.
      const sink: PathSink = { ctm: local, out: [], drew: true };
      const x0 = numbers["x"]!;
      const y0 = numbers["y"]!;
      sink.out.push(`${emitPoint(sink, x0, y0)} m`);
      sink.out.push(`${emitPoint(sink, x0 + w, y0)} l`);
      sink.out.push(`${emitPoint(sink, x0 + w, y0 + h)} l`);
      sink.out.push(`${emitPoint(sink, x0, y0 + h)} l`);
      sink.out.push("h");
      paintShape(paint, sink.out, state);
    }
    return;
  }

  for (const child of element.children) {
    walk(child, local, paint, state);
    if (state.failed) return;
  }
}

/* ------------------------------------------------------------- the surface */

/**
 * The parsed document, painted into `box`.
 *
 * `box` is in PDF page space (points, y up, bottom-left origin). The result's
 * `operators` are self-contained: they change no graphics state that outlives
 * them, so a caller can splice them straight into a page content stream.
 *
 * **Any error empties `operators`.** A formula missing one glyph is the silent
 * wrong answer D38 refuses; a formula that is entirely absent, with a
 * diagnostic naming the reason, is the loud one.
 */
export function emitSvg(document: SvgDocument, box: SvgTargetBox, at: SourceRef): SvgEmission {
  const diagnostics: Diagnostic[] = [];

  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height)
  ) {
    diagnostics.push(error("internal", at, "the SVG target box has a non-finite dimension"));
    return { operators: [], diagnostics };
  }
  // A zero-extent box paints nothing; that is a caller's arithmetic, not a
  // failure, and emitting a degenerate scale would divide the picture by zero.
  if (box.width <= 0 || box.height <= 0) return { operators: [], diagnostics };

  const rawRatio = document.root.attributes["preserveAspectRatio"];
  const ratio = parsePreserveAspectRatio(rawRatio);
  if (ratio === null) {
    diagnostics.push(
      error("internal", at, `the \`<svg>\` \`preserveAspectRatio\` is unreadable: \`${rawRatio ?? ""}\``),
    );
    return { operators: [], diagnostics };
  }
  if (ratio.slice) {
    // `slice` fills the box and lets the picture overflow, which is only
    // correct with a clip. This file emits no clipping path, so honouring
    // `slice` would paint outside the box a caller reserved.
    diagnostics.push(
      unsupported(at, "`preserveAspectRatio` with `slice`", "it requires a clipping path this engine does not emit"),
    );
    return { operators: [], diagnostics };
  }

  const state: WalkState = { out: [], diagnostics, at, failed: false };
  walk(document.root, viewBoxMatrix(document.viewBox, box, ratio), INITIAL_PAINT, state);

  if (state.failed || hasErrors(diagnostics)) return { operators: [], diagnostics };
  return { operators: state.out, diagnostics };
}

/** `parseSvg` then `emitSvg`, for the common case of having only the string. */
export function svgToOperators(source: string, box: SvgTargetBox, at: SourceRef): SvgEmission {
  const parsed = parseSvg(source, at);
  if (parsed.document === null) return { operators: [], diagnostics: parsed.diagnostics };
  const emitted = emitSvg(parsed.document, box, at);
  return { operators: emitted.operators, diagnostics: [...parsed.diagnostics, ...emitted.diagnostics] };
}
