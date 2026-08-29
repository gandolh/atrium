import type { FloatClass, HeadingLevel } from "./model.ts";
import { HEADING_DEPTH, SECTION_NUMBER_DEPTH } from "./model.ts";

/**
 * Counters, and the number a `\ref` to them prints (brief 37, chunk 6).
 *
 * The formats are `article.cls`'s, not inventions: `\theenumii` really is
 * lowercase letters in parentheses, and a `\ref` to a second-level item really
 * does print `1a` rather than `(a)` — LaTeX composes the reference from
 * `\p@enumii\theenumii` while the item's *label* is `(\theenumii)`. Getting
 * this wrong is the kind of bug nobody notices until a cross-reference points
 * at the wrong list item, so it is implemented from the class file's rules.
 */

export type CounterName =
  | "section"
  | "subsection"
  | "subsubsection"
  | "paragraph"
  | "footnote"
  | "figure"
  | "table"
  | "equation"
  | "enumi"
  | "enumii"
  | "enumiii"
  | "enumiv";

/** Stepping a counter resets everything subordinate to it, as `\newcounter[...]` does. */
const SUBORDINATES: Readonly<Record<CounterName, readonly CounterName[]>> = {
  section: ["subsection", "subsubsection", "paragraph"],
  subsection: ["subsubsection", "paragraph"],
  subsubsection: ["paragraph"],
  paragraph: [],
  footnote: [],
  // `article.cls` numbers figures, tables and equations straight through the
  // document: none of the three is reset by a `\section` and none resets
  // anything. Copying `report.cls`'s chapter-relative behaviour here would
  // renumber every caption in a paper.
  //
  // For `equation` this is not a preference, it is forced by the format:
  // `article` sets `\theequation` to a bare `\@arabic\c@equation`, with no
  // section prefix, so resetting it per section would print two different
  // equations as `(1)` in one document and make every `\ref` to them
  // ambiguous. (`\numberwithin{equation}{section}` is the amsmath command
  // that changes *both* halves together; it is not implemented, and
  // `\theequation` is a `FORMATTING_HOOKS` name, so redefining it is already
  // a diagnostic rather than silently-wrong numbering.)
  figure: [],
  table: [],
  equation: [],
  enumi: ["enumii", "enumiii", "enumiv"],
  enumii: ["enumiii", "enumiv"],
  enumiii: ["enumiv"],
  enumiv: [],
};

export type Counters = Record<CounterName, number>;

export function createCounters(): Counters {
  return {
    section: 0,
    subsection: 0,
    subsubsection: 0,
    paragraph: 0,
    footnote: 0,
    figure: 0,
    table: 0,
    equation: 0,
    enumi: 0,
    enumii: 0,
    enumiii: 0,
    enumiv: 0,
  };
}

export function step(counters: Counters, name: CounterName): number {
  counters[name] += 1;
  for (const sub of SUBORDINATES[name]) counters[sub] = 0;
  return counters[name];
}

export function reset(counters: Counters, name: CounterName): void {
  counters[name] = 0;
  for (const sub of SUBORDINATES[name]) counters[sub] = 0;
}

const HEADING_COUNTER: Readonly<Record<HeadingLevel, CounterName>> = {
  section: "section",
  subsection: "subsection",
  subsubsection: "subsubsection",
  paragraph: "paragraph",
};

export function headingCounter(level: HeadingLevel): CounterName {
  return HEADING_COUNTER[level];
}

/** Whether `article` numbers this level at all (`secnumdepth` is 3). */
export function isNumbered(level: HeadingLevel): boolean {
  return HEADING_DEPTH[level] <= SECTION_NUMBER_DEPTH;
}

/** `\thesubsection` and friends: the dotted number chain down to `level`. */
export function formatHeadingNumber(counters: Counters, level: HeadingLevel): string {
  const chain: CounterName[] = ["section", "subsection", "subsubsection", "paragraph"];
  const depth = HEADING_DEPTH[level];
  return chain
    .slice(0, depth)
    .map((c) => String(counters[c]))
    .join(".");
}

const LOWER_ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

export function alph(n: number): string {
  // LaTeX's `\@alph` is only defined for 1–26 and errors past it; printing the
  // bare number is a visible, honest fallback rather than a wrong letter.
  return n >= 1 && n <= 26 ? LOWER_ALPHA[n - 1]! : String(n);
}

export function Alph(n: number): string {
  return alph(n).toUpperCase();
}

export function roman(n: number): string {
  if (n <= 0) return String(n);
  let rest = n;
  let out = "";
  for (const [value, numeral] of ROMAN) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}

export const ENUM_COUNTERS: readonly CounterName[] = ["enumi", "enumii", "enumiii", "enumiv"];

/** The counter for an `enumerate` at `depth` (1-based). Depth past 4 reuses the last. */
export function enumCounter(depth: number): CounterName {
  return ENUM_COUNTERS[Math.min(Math.max(depth, 1), ENUM_COUNTERS.length) - 1]!;
}

/** `\theenumN` — the counter's own value, without the parent chain. */
export function formatEnumValue(depth: number, value: number): string {
  switch (Math.min(Math.max(depth, 1), 4)) {
    case 1:
      return String(value);
    case 2:
      return alph(value);
    case 3:
      return roman(value);
    default:
      return Alph(value);
  }
}

/** `\labelenumN` — what prints in the item's margin. */
export function formatEnumLabel(depth: number, value: number): string {
  const text = formatEnumValue(depth, value);
  return Math.min(Math.max(depth, 1), 4) === 2 ? `(${text})` : `${text}.`;
}

/**
 * `\p@enumN\theenumN` — what a `\ref` to this item prints.
 *
 * The reference prefixes in `classes.dtx` (`article.cls`) are:
 * ```
 * \renewcommand\p@enumii{\theenumi}
 * \renewcommand\p@enumiii{\theenumi(\theenumii)}
 * \renewcommand\p@enumiv{\p@enumiii\theenumiii}
 * ```
 * (`\p@enumi` is `\@empty`, LaTeX's default.) So the parentheses around the
 * second level are *not* part of `\theenumii`: they are literal text inside
 * `\p@enumiii`, which is why a `\ref` to a second-level item prints `1a`
 * while a `\ref` to a third-level one prints `1(a)i`. The parenthesised form
 * an author sees in the margin comes from `\labelenumii{(\theenumii)}`
 * instead — a different macro, handled by `formatEnumLabel`.
 *
 * Concretely: `1`, `1a`, `1(a)i`, `1(a)iA`.
 */
export function enumReferenceText(counters: Counters, depth: number): string {
  const d = Math.min(Math.max(depth, 1), 4);
  let out = "";
  for (let level = 1; level <= d; level++) {
    const value = counters[enumCounter(level)];
    const text = formatEnumValue(level, value);
    // `(`…`)` only when level 2 is being written as part of a *prefix*
    // (`\p@enumiii` and, through it, `\p@enumiv`) — never when it is the
    // level actually being referred to, where `\p@enumii\theenumii` is a
    // bare `\theenumi\theenumii`.
    out += level === 2 && level < d ? `(${text})` : text;
  }
  return out;
}

// --- floats -----------------------------------------------------------------

/**
 * `FloatClass` itself lives in `model.ts` with the blocks that carry it: it is
 * document vocabulary, and a float's class decides three things at once (which
 * counter steps, which `\listof...` collects it, which name its caption gets).
 */

const FLOAT_COUNTER: Readonly<Record<FloatClass, CounterName>> = {
  figure: "figure",
  table: "table",
};

export function floatCounter(floatClass: FloatClass): CounterName {
  return FLOAT_COUNTER[floatClass];
}

/**
 * `\thefigure` / `\thetable` — plain arabic in `article`, with no section
 * prefix. This is also exactly what a `\ref` to the caption prints, which is
 * why there is one function rather than a label form and a reference form (see
 * `enumReferenceText` for the case where LaTeX really does distinguish them).
 */
export function formatFloatNumber(counters: Counters, floatClass: FloatClass): string {
  return String(counters[floatCounter(floatClass)]);
}

// --- equations (brief 40) ---------------------------------------------------

/**
 * `\theequation` — `\@arabic\c@equation` in `article`, so a plain number with
 * no section prefix.
 *
 * As with `formatFloatNumber` there is one function rather than a label form
 * and a reference form, because in `article` they are the same string: the
 * parentheses a reader sees beside a display equation come from
 * `\@eqnnum` (`{\normalfont\normalcolor (\theequation)}`), which is *setting*
 * the number, not formatting the counter — so they belong to chunk 40.5's
 * `EquationNumberSetter` and deliberately not to this string. A plain `\ref` to
 * an equation prints `3`, not `(3)`; amsmath's `\eqref` is the command that
 * adds them, and it is not implemented.
 */
export function formatEquationNumber(counters: Counters): string {
  return String(counters.equation);
}
