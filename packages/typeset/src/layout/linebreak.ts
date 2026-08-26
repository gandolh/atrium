import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { warning } from "../diagnostics.ts";
import type { FontHandle } from "../font/handle.ts";
import type { Glue, HBox, HList, HNode } from "./model.ts";
import { EJECT_PENALTY, INFINITE_PENALTY, glue } from "./model.ts";
import type { Extent, PackReport } from "./glue.ts";
import { AWFUL_BAD, INF_BAD, addNodeExtent, badness, hpack, measure, zeroExtent } from "./glue.ts";
import type { Shaper } from "./hlist.ts";
import { createShaper, finishParagraph } from "./hlist.ts";
import type { HyphenateOptions, Hyphenator } from "./hyphenate.ts";
import { createEnglishHyphenator, hyphenateHList } from "./hyphenate.ts";

/**
 * Knuth-Plass line breaking — total fit.
 *
 * The algorithm chooses the set of breakpoints that minimises the **total**
 * demerits of the whole paragraph, not the best break for each line in turn.
 * That difference is the entire reason TeX's paragraphs look the way they do:
 * a greedy breaker cannot make line 3 slightly tighter to save line 4 from
 * being dreadful, because by the time it sees line 4 the decision is made.
 *
 * It is a shortest-path problem. Every legal breakpoint is a vertex; an edge
 * from break *a* to break *b* is the line between them, priced by how badly its
 * glue must stretch or shrink plus whatever the break itself costs. Dynamic
 * programming over a list of *active* nodes — the breaks that could still start
 * a line reaching the current position — finds the cheapest path in one
 * left-to-right sweep.
 *
 * Everything priced here is TeX's, cited by section of `tex.web`:
 *
 * - **badness** = 100·(ratio)³, capped at 10000 (§108, and `glue.ts`)
 * - **fitness classes** tight / decent / loose / very loose (§817)
 * - **demerits** = (`\linepenalty` + badness)² ± penalty², plus
 *   `\doublehyphendemerits` for two hyphenated lines in a row and
 *   `\adjdemerits` for adjacent lines two fitness classes apart (§859)
 * - **three passes**: `\pretolerance` without hyphens, `\tolerance` with them,
 *   and a final pass with `\emergencystretch` (§863)
 *
 * The result is deterministic. No clock, no randomness, and every iteration
 * order in here is over an array or over numerically sorted keys.
 */

/** TeX's fitness classes, §817. The numbers are TeX's own and the order matters. */
export const VERY_LOOSE_FIT = 0;
export const LOOSE_FIT = 1;
export const DECENT_FIT = 2;
export const TIGHT_FIT = 3;
export type Fitness = 0 | 1 | 2 | 3;

/** For diagnostics and dumps. Indexed by `Fitness`. */
export const FITNESS_NAMES = ["very loose", "loose", "decent", "tight"] as const;

/**
 * The measure of each line. A single number is a rectangular paragraph; an
 * array gives per-line widths with the **last entry repeating**, which is how
 * hanging indentation and `\parshape` are expressed.
 */
export type LineWidths = number | readonly number[];

export interface LineBreakParams {
  /**
   * `\tolerance` — the worst badness a line may have and still be used. Plain
   * TeX and LaTeX both default to 200, which is a ratio of about 1.26.
   */
  tolerance: number;
  /**
   * `\pretolerance` — the threshold for the first pass, which does not
   * hyphenate. Plain TeX's 100. Negative skips the first pass entirely, which
   * is what `\sloppy`-style setups do.
   */
  pretolerance: number;
  /**
   * `\linepenalty` — added to every line's badness before squaring, so that
   * among two equally-loose breakings the one with fewer lines wins. Plain
   * TeX's 10.
   */
  linePenalty: number;
  /**
   * `\hyphenpenalty` — cost of a break at an automatic hyphen, plain TeX's 50.
   * Used when the discretionaries are inserted, so it is what lands in
   * `Discretionary.penalty`; a discretionary already in the list keeps its own.
   * (`\exhyphenpenalty`, the cost of breaking after a hyphen the author typed,
   * is set the same way — see `TextRunOptions` in `hlist.ts`.)
   */
  hyphenPenalty: number;
  /** `\adjdemerits` — charged when adjacent lines differ by two fitness classes. Plain TeX's 10000. */
  adjDemerits: number;
  /** `\doublehyphendemerits` — charged for two hyphenated lines in a row. Plain TeX's 10000. */
  doubleHyphenDemerits: number;
  /** `\finalhyphendemerits` — charged when the *penultimate* line ends in a hyphen. Plain TeX's 5000. */
  finalHyphenDemerits: number;
  /**
   * `\emergencystretch` — extra stretch pretended into every line on a third
   * pass, used only when the second pass finds nothing tolerable. Plain TeX's
   * 0pt: off, so a hopeless paragraph goes overfull rather than loose.
   */
  emergencyStretch: number;
  /** `\hbadness` — badness above which an underfull line is reported. Plain TeX's 1000. */
  hbadness: number;
  /** `\hfuzz` — overflow below which an overfull line is not reported. Plain TeX's 0.1pt. */
  hfuzz: number;
  /**
   * `\leftskip` / `\rightskip`, glue added at the two ends of every line. Both
   * are zero for justified text. Ragged right is `rightSkip: glue(0, 1, 0, 1)`
   * — the `fil` swallows the whole shortfall, so every line is badness 0 and
   * the breaker optimises on penalties alone.
   */
  leftSkip: Glue;
  rightSkip: Glue;
  /** Insert discretionaries on the second pass. `false` breaks on spaces only. */
  hyphenate: boolean;
  /** Which hyphenator to use. Defaults to TeX's en-US patterns. */
  hyphenator: Hyphenator | null;
  /**
   * Whether a face may be hyphenated — TeX's `\hyphenchar\font >= 0`. Defaults
   * to "yes, always"; the document stage should say no for typewriter type,
   * where a hyphen would read as part of the code.
   */
  hyphenateFont: ((font: FontHandle, size: number) => boolean) | null;
  /**
   * Shared measurement cache. Pass one across a whole document and every word
   * is shaped once; omit it and each paragraph gets its own.
   */
  shaper: Shaper | null;
  /**
   * Append `\penalty10000 \parfillskip` if the list does not already end that
   * way. Leave it on unless the caller finishes its own paragraphs.
   */
  finish: boolean;
  /** Where the paragraph came from, for diagnostics. */
  at: SourceRef;
}

/**
 * Plain TeX's values, which LaTeX inherits. Anything changed here changes where
 * every paragraph in every document breaks, so they are pinned rather than
 * tuned.
 */
export const DEFAULT_LINE_BREAK_PARAMS: LineBreakParams = {
  tolerance: 200,
  pretolerance: 100,
  linePenalty: 10,
  hyphenPenalty: 50,
  adjDemerits: 10000,
  doubleHyphenDemerits: 10000,
  finalHyphenDemerits: 5000,
  emergencyStretch: 0,
  hbadness: 1000,
  hfuzz: 0.1,
  leftSkip: glue(0),
  rightSkip: glue(0),
  hyphenate: true,
  hyphenator: null,
  hyphenateFont: null,
  shaper: null,
  finish: true,
  at: { file: "", line: 0 },
};

/** One chosen break, with the arithmetic that chose it. */
export interface LineBreak {
  /** Index in `LineBreakResult.hlist` of the node broken at; `hlist.length` at the paragraph's end. */
  position: number;
  /** 1-based line number. */
  line: number;
  at: "glue" | "kern" | "penalty" | "disc" | "end";
  /**
   * True when taking this break put a hyphen on the page — a discretionary with
   * something in its `pre`. Distinct from TeX's `break_type`, which also counts
   * a flagged penalty and the paragraph's own end.
   */
  hyphen: boolean;
  /** The penalty charged for breaking here, after TeX's clamping. */
  penalty: number;
  /**
   * The badness the breaker judged this line by. On the third pass that
   * includes `\emergencystretch`, which the packed line does not contain — so
   * a line chosen there can be reported underfull despite a small badness
   * here. That is TeX's behaviour, and the reason `\emergencystretch` turns
   * overfull boxes into underfull ones.
   */
  badness: number;
  fitness: Fitness;
  /** Demerits of this line alone. */
  demerits: number;
  /** Running total — the quantity total fit minimises. */
  totalDemerits: number;
  /** The packed line's glue ratio; read together with the box's `glueSet.sign`. */
  ratio: number;
  /** Points the packed line overflows its measure by. `0` for a line that fits. */
  overfull: number;
}

export interface LineBreakResult {
  /** The packed lines, in order. Each is set to its measure; read `glueSet` to place glyphs. */
  lines: HBox[];
  breaks: LineBreak[];
  /**
   * The list the breaks index into — the input after `finish` and, if the
   * second pass was needed, after hyphenation. Not the caller's array.
   */
  hlist: HList;
  /** `1` pretolerance, `2` tolerance with hyphenation, `3` emergency stretch. */
  pass: 1 | 2 | 3;
  /** Total demerits of the chosen breaking. */
  demerits: number;
  /** Active-node visits, for the engine's step budget. */
  steps: number;
  diagnostics: Diagnostic[];
}

/**
 * Break a paragraph into lines.
 *
 * `hlist` is the paragraph as boxes, glue and penalties — see `hlist.ts` for
 * how to build one. `lineWidths` is the measure. Returns packed `HBox` lines
 * whose glue is already set, plus the breaks that produced them and any
 * diagnostics the paragraph earned.
 *
 * It never throws and always returns at least one line: a paragraph that cannot
 * be broken acceptably comes back overfull, with an `overfull-box` diagnostic
 * naming the overflow. That is TeX's behaviour and it is the right one — a line
 * a human can see sticking into the margin is fixable; a crash is not.
 */
export function breakParagraph(
  hlist: HList,
  lineWidths: LineWidths,
  overrides: Partial<LineBreakParams> = {},
): LineBreakResult {
  const params: LineBreakParams = { ...DEFAULT_LINE_BREAK_PARAMS, ...overrides };
  const shaper = params.shaper ?? createShaper();
  const plain = params.finish ? finishParagraph(hlist) : hlist.slice();

  // Hyphenation is deferred: the first pass deliberately runs without it, and a
  // paragraph that breaks cleanly on spaces never pays for the pattern trie.
  let hyphenatedList: HList | null = null;
  const withHyphens = (): HList => {
    if (hyphenatedList !== null) return hyphenatedList;
    if (!params.hyphenate) {
      hyphenatedList = plain;
      return hyphenatedList;
    }
    const options: HyphenateOptions = {
      hyphenator: params.hyphenator ?? createEnglishHyphenator(),
      hyphenPenalty: params.hyphenPenalty,
      shaper,
    };
    if (params.hyphenateFont !== null) options.hyphenateFont = params.hyphenateFont;
    hyphenatedList = hyphenateHList(plain, options);
    return hyphenatedList;
  };

  let steps = 0;

  // §863: pass 1 at `\pretolerance` without hyphens; pass 2 at `\tolerance`
  // with them; pass 2 is the last unless `\emergencystretch` buys a third.
  const attempts: Array<{ pass: 1 | 2 | 3; list: () => HList; threshold: number; emergency: number; final: boolean }> =
    [];
  if (params.pretolerance >= 0) {
    attempts.push({ pass: 1, list: () => plain, threshold: params.pretolerance, emergency: 0, final: false });
  }
  attempts.push({
    pass: 2,
    list: withHyphens,
    threshold: params.tolerance,
    emergency: 0,
    final: params.emergencyStretch <= 0,
  });
  if (params.emergencyStretch > 0) {
    attempts.push({
      pass: 3,
      list: withHyphens,
      threshold: params.tolerance,
      emergency: params.emergencyStretch,
      final: true,
    });
  }

  for (const attempt of attempts) {
    const list = attempt.list();
    const outcome = runPass(list, lineWidths, params, attempt.threshold, attempt.emergency, attempt.final);
    steps += outcome.steps;
    if (outcome.best === null) continue;
    return assemble(list, outcome.best, lineWidths, params, attempt.pass, steps);
  }

  // Unreachable while the final pass keeps its artificial-demerits escape, but
  // the engine never throws (D38), so there is a floor under it: one line with
  // everything on it, reported as the overfull box it is.
  return lastResort(plain, lineWidths, params, steps);
}

// --- the dynamic program ---------------------------------------------------

interface Candidate {
  /** Index of the node broken at; `list.length` for the paragraph's end. */
  index: number;
  kind: "glue" | "kern" | "penalty" | "disc" | "end";
  /** After TeX's clamping (§829): never above `INFINITE_PENALTY`, never below `EJECT_PENALTY`. */
  penalty: number;
  /** TeX's `break_type`. True at a discretionary, and at the paragraph's end (§873). */
  hyphenated: boolean;
  /** Where the line ending here stops, exclusive. */
  endIndex: number;
  /** Where the following line's slice starts, after discardables are dropped. */
  startIndex: number;
  /** A discretionary's `pre`, appended to the line that ends here. */
  preNodes: readonly HNode[];
  /** A discretionary's `post`, prepended to the line that starts here. */
  postNodes: readonly HNode[];
  preTotals: Totals;
  postTotals: Totals;
}

interface ActiveNode {
  candidate: Candidate;
  lineNumber: number;
  fitness: Fitness;
  hyphenated: boolean;
  badness: number;
  demerits: number;
  totalDemerits: number;
  previous: ActiveNode | null;
}

/** Natural size plus flex. Shrink is collapsed across orders — see `fitLine`. */
interface Totals {
  w: number;
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  sh: number;
}

function zeroTotals(): Totals {
  return { w: 0, s0: 0, s1: 0, s2: 0, s3: 0, sh: 0 };
}

function totalsOf(nodes: readonly HNode[]): Totals {
  return fromExtent(measure(nodes, "h"));
}

function fromExtent(e: Extent): Totals {
  return {
    w: e.natural,
    s0: e.stretch[0],
    s1: e.stretch[1],
    s2: e.stretch[2],
    s3: e.stretch[3],
    sh: e.shrink[0] + e.shrink[1] + e.shrink[2] + e.shrink[3],
  };
}

/** §148: glue, kerns and penalties vanish at a break; everything else stays. */
function isDiscardable(node: HNode): boolean {
  return node.kind === "glue" || node.kind === "kern" || node.kind === "penalty";
}

function skipDiscardable(list: HList, from: number): number {
  let j = from;
  while (j < list.length && isDiscardable(list[j] as HNode)) j++;
  return j;
}

/** Every place a line may end, in list order, with the paragraph's forced end last. */
function enumerateBreakpoints(list: HList): Candidate[] {
  const n = list.length;
  const out: Candidate[] = [];

  for (let i = 0; i < n; i++) {
    const node = list[i] as HNode;
    let pi: number;
    let hyphenated = false;

    switch (node.kind) {
      case "glue":
        // §868: glue is a break only when something non-discardable precedes
        // it, so a run of glue offers exactly one breakpoint and a paragraph
        // never breaks before its first word.
        if (i === 0 || isDiscardable(list[i - 1] as HNode)) continue;
        pi = 0;
        break;
      case "kern":
        // §866: a kern breaks only when glue follows, because the kern is then
        // discarded along with that glue and nothing is left dangling.
        if (i + 1 >= n || (list[i + 1] as HNode).kind !== "glue") continue;
        pi = 0;
        break;
      case "penalty":
        pi = node.penalty;
        // `model.ts` gives `Penalty` a `flagged` bit for exactly TeX's
        // `break_type`, so a caller that expresses a break as a flagged penalty
        // gets the double-hyphen charge too. TeX's own penalty breaks are
        // always unflagged, which is what `penalty()` defaults to.
        hyphenated = node.flagged;
        break;
      case "disc":
        pi = node.penalty;
        hyphenated = true;
        break;
      default:
        continue;
    }

    // §829: `try_break` refuses an infinite penalty outright and clamps an
    // infinitely negative one to `eject_penalty`, so a forced break is exactly
    // -10000 from here on.
    if (pi >= INFINITE_PENALTY) continue;
    if (pi <= EJECT_PENALTY) pi = EJECT_PENALTY;

    if (node.kind === "disc") {
      out.push({
        index: i,
        kind: "disc",
        penalty: pi,
        hyphenated,
        endIndex: i,
        // §840: material after a discretionary is discarded only when `post` is
        // empty. A non-empty `post` starts the next line, and the glue behind
        // it stays.
        startIndex: node.post.length > 0 ? i + 1 : skipDiscardable(list, i + 1),
        preNodes: node.pre,
        postNodes: node.post,
        preTotals: totalsOf(node.pre),
        postTotals: totalsOf(node.post),
      });
      continue;
    }

    out.push({
      index: i,
      kind: node.kind,
      penalty: pi,
      hyphenated,
      endIndex: i,
      startIndex: skipDiscardable(list, i),
      preNodes: EMPTY_NODES,
      postNodes: EMPTY_NODES,
      preTotals: zeroTotals(),
      postTotals: zeroTotals(),
    });
  }

  out.push({
    index: n,
    kind: "end",
    penalty: EJECT_PENALTY,
    // §873 calls `try_break(eject_penalty, hyphenated)` at the paragraph's end.
    // The final break is flagged as a hyphen not because one is printed but so
    // that `\finalhyphendemerits` can notice a hyphen on the penultimate line.
    hyphenated: true,
    endIndex: n,
    startIndex: n,
    preNodes: EMPTY_NODES,
    postNodes: EMPTY_NODES,
    preTotals: zeroTotals(),
    postTotals: zeroTotals(),
  });

  return out;
}

const EMPTY_NODES: readonly HNode[] = [];

/** Running totals of the list, so any line's size is one subtraction. */
interface Prefix {
  w: Float64Array;
  s0: Float64Array;
  s1: Float64Array;
  s2: Float64Array;
  s3: Float64Array;
  sh: Float64Array;
}

function buildPrefix(list: HList): Prefix {
  const n = list.length;
  const p: Prefix = {
    w: new Float64Array(n + 1),
    s0: new Float64Array(n + 1),
    s1: new Float64Array(n + 1),
    s2: new Float64Array(n + 1),
    s3: new Float64Array(n + 1),
    sh: new Float64Array(n + 1),
  };
  const running = zeroExtent();
  for (let i = 0; i < n; i++) {
    addNodeExtent(running, list[i] as HNode, "h");
    p.w[i + 1] = running.natural;
    p.s0[i + 1] = running.stretch[0];
    p.s1[i + 1] = running.stretch[1];
    p.s2[i + 1] = running.stretch[2];
    p.s3[i + 1] = running.stretch[3];
    // TeX keeps one shrink total across all orders while breaking lines
    // (§868 adds `shrink(g)` to `active_width[6]` without looking at the
    // order), so infinite shrink inside a paragraph is measured as if finite.
    // The manual calls that a mistake in the document rather than in TeX.
    p.sh[i + 1] = running.shrink[0] + running.shrink[1] + running.shrink[2] + running.shrink[3];
  }
  return p;
}

function lineWidthAt(widths: LineWidths, line: number): number {
  if (typeof widths === "number") return widths;
  if (widths.length === 0) return 0;
  return widths[Math.min(line - 1, widths.length - 1)] as number;
}

interface Fit {
  badness: number;
  fitness: Fitness;
}

/**
 * Badness and fitness class of a line, §852-853.
 *
 * The asymmetry between the two halves is TeX's and is deliberate. Stretching
 * is elastic: a line stretched past all reason is merely very loose, and any
 * infinite stretch present makes the line perfect. Shrinking is not: past the
 * available shrink the words physically collide, so the answer is `AWFUL_BAD`,
 * which no tolerance can accept.
 */
function fitLine(m: Totals, target: number): Fit {
  const shortfall = target - m.w;
  if (shortfall > 0) {
    // §852: any infinite stretch present absorbs the shortfall exactly.
    if (m.s1 !== 0 || m.s2 !== 0 || m.s3 !== 0) return { badness: 0, fitness: DECENT_FIT };
    const b = badness(shortfall, m.s0);
    return { badness: b, fitness: b > 99 ? VERY_LOOSE_FIT : b > 12 ? LOOSE_FIT : DECENT_FIT };
  }
  if (-shortfall > m.sh) return { badness: AWFUL_BAD, fitness: TIGHT_FIT };
  const b = badness(-shortfall, m.sh);
  return { badness: b, fitness: b > 12 ? TIGHT_FIT : DECENT_FIT };
}

/**
 * The demerits of one line, §859.
 *
 * `(\linepenalty + badness)²` is the body of it: squaring means one dreadful
 * line costs far more than several mediocre ones, which is exactly the
 * judgement a typesetter makes. The square is capped at 10⁸ so that a line at
 * the very edge of tolerance cannot swamp the arithmetic.
 */
function lineDemerits(
  b: number,
  pi: number,
  breakHyphenated: boolean,
  previousHyphenated: boolean,
  fitness: Fitness,
  previousFitness: Fitness,
  atEnd: boolean,
  params: LineBreakParams,
): number {
  const base = params.linePenalty + b;
  let d = Math.abs(base) >= 10000 ? 100000000 : base * base;

  // A positive penalty adds its square; a negative one *subtracts* it, so a
  // mild bonus (say `\penalty-50` before a section) genuinely attracts a break.
  // `eject_penalty` itself is excluded — a forced break is not a bargain.
  if (pi > 0) d += pi * pi;
  else if (pi !== 0 && pi > EJECT_PENALTY) d -= pi * pi;

  if (breakHyphenated && previousHyphenated) {
    // §859: at the paragraph's end this is `\finalhyphendemerits`, which is why
    // the end-of-paragraph break is flagged hyphenated at all. It prices the
    // specific ugliness of a hyphen on the second-to-last line.
    d += atEnd ? params.finalHyphenDemerits : params.doubleHyphenDemerits;
  }
  // §859: two classes apart — a tight line next to a loose one — is visible as
  // a change of colour down the page, so it is charged for.
  if (Math.abs(fitness - previousFitness) > 1) d += params.adjDemerits;

  return d;
}

interface PassOutcome {
  best: ActiveNode | null;
  steps: number;
}

interface Feasible {
  from: ActiveNode;
  lineNumber: number;
  fitness: Fitness;
  badness: number;
  demerits: number;
  totalDemerits: number;
}

function runPass(
  list: HList,
  widths: LineWidths,
  params: LineBreakParams,
  threshold: number,
  emergencyStretch: number,
  finalPass: boolean,
): PassOutcome {
  const breakpoints = enumerateBreakpoints(list);
  const prefix = buildPrefix(list);
  const lastIndex = list.length;
  // §863: `if threshold > inf_bad then threshold := inf_bad`. Without the clamp
  // a generous `\tolerance` would start accepting `AWFUL_BAD` — an overfull
  // line — as merely tolerable, and tolerance is not supposed to be able to
  // buy that.
  const limit = Math.min(threshold, INF_BAD);

  // TeX's `background`: what every line carries before any of its own content.
  const background = fromExtent(skipExtent(params.leftSkip, params.rightSkip));
  background.s0 += emergencyStretch;

  // With one measure for every line, active nodes compete regardless of which
  // line they would start — TeX's `easy_line` (§850). With varying measures they
  // may not, because two nodes on different line numbers are packed to
  // different widths.
  const uniform = typeof widths === "number" || widths.length <= 1;

  const root: ActiveNode = {
    candidate: {
      index: -1,
      kind: "end",
      penalty: 0,
      hyphenated: false,
      endIndex: 0,
      startIndex: 0,
      preNodes: EMPTY_NODES,
      postNodes: EMPTY_NODES,
      preTotals: zeroTotals(),
      postTotals: zeroTotals(),
    },
    lineNumber: 0,
    // §864 seeds the active list as decent and unhyphenated, so the first line
    // is never charged `\adjdemerits` for following nothing.
    fitness: DECENT_FIT,
    hyphenated: false,
    badness: 0,
    demerits: 0,
    totalDemerits: 0,
    previous: null,
  };

  let active: ActiveNode[] = [root];
  let steps = 0;

  for (const c of breakpoints) {
    const best = new Map<number, Feasible>();
    const survivors: ActiveNode[] = [];
    const forced = c.penalty === EJECT_PENALTY;

    for (let i = 0; i < active.length; i++) {
      const a = active[i] as ActiveNode;
      steps++;

      const lineNumber = a.lineNumber + 1;
      const target = lineWidthAt(widths, lineNumber);
      const m = measureLine(prefix, background, a, c);
      const fit = fitLine(m, target);

      let artificial = false;
      let keep: boolean;

      if (fit.badness > INF_BAD || forced) {
        // §851: this node can never reach past here — the line is overfull, or
        // the break is compulsory. The escape hatch is TeX's
        // `artificial_demerits`: on the final pass, if this is the last active
        // node and nothing feasible has been recorded, take the break anyway
        // rather than losing the paragraph.
        if (finalPass && best.size === 0 && survivors.length === 0 && i === active.length - 1) {
          artificial = true;
        } else if (fit.badness > limit) {
          continue;
        }
        keep = false;
      } else {
        keep = true;
        if (fit.badness > limit) {
          survivors.push(a);
          continue;
        }
      }

      if (keep) survivors.push(a);

      const d = artificial
        ? 0
        : lineDemerits(
            fit.badness,
            c.penalty,
            c.hyphenated,
            a.hyphenated,
            fit.fitness,
            a.fitness,
            c.index === lastIndex,
            params,
          );
      const total = d + a.totalDemerits;
      const key = uniform ? fit.fitness : lineNumber * 4 + fit.fitness;
      const held = best.get(key);
      // §855 compares with `<=`, so among equal candidates the one latest in
      // the active list wins. Kept identical because the active list's order is
      // itself part of what makes TeX's choice reproducible.
      if (held === undefined || total <= held.totalDemerits) {
        best.set(key, {
          from: a,
          lineNumber,
          fitness: fit.fitness,
          badness: fit.badness,
          demerits: d,
          totalDemerits: total,
        });
      }
    }

    active = survivors;
    if (best.size > 0) appendFeasible(active, best, c, uniform, params);
    if (active.length === 0) return { best: null, steps };
  }

  // §874: the cheapest node that reached the end, first one winning a tie.
  let winner: ActiveNode | null = null;
  for (const a of active) {
    if (a.candidate.index !== lastIndex) continue;
    if (winner === null || a.totalDemerits < winner.totalDemerits) winner = a;
  }
  return { best: winner, steps };
}

function skipExtent(leftSkip: Glue, rightSkip: Glue): Extent {
  const e = zeroExtent();
  addNodeExtent(e, leftSkip, "h");
  addNodeExtent(e, rightSkip, "h");
  return e;
}

/** The size of the line running from break `a` to break `c`. */
function measureLine(prefix: Prefix, background: Totals, a: ActiveNode, c: Candidate): Totals {
  const from = a.candidate.startIndex;
  const to = c.endIndex;
  const post = a.candidate.postTotals;
  const pre = c.preTotals;
  return {
    w: (prefix.w[to] as number) - (prefix.w[from] as number) + post.w + pre.w + background.w,
    s0: (prefix.s0[to] as number) - (prefix.s0[from] as number) + post.s0 + pre.s0 + background.s0,
    s1: (prefix.s1[to] as number) - (prefix.s1[from] as number) + post.s1 + pre.s1 + background.s1,
    s2: (prefix.s2[to] as number) - (prefix.s2[from] as number) + post.s2 + pre.s2 + background.s2,
    s3: (prefix.s3[to] as number) - (prefix.s3[from] as number) + post.s3 + pre.s3 + background.s3,
    sh: (prefix.sh[to] as number) - (prefix.sh[from] as number) + post.sh + pre.sh + background.sh,
  };
}

/**
 * Turn this breakpoint's best candidates into active nodes, §845.
 *
 * The `\adjdemerits` slack is the subtle part: a fitness class that is *worse*
 * than the best one is still kept if it is within `|\adjdemerits|` of it,
 * because the next line may sit better beside it and save more than it cost.
 * Dropping this makes the algorithm noticeably greedier.
 */
function appendFeasible(
  active: ActiveNode[],
  best: Map<number, Feasible>,
  c: Candidate,
  uniform: boolean,
  params: LineBreakParams,
): void {
  // Sorted numerically rather than walked in insertion order: the map's own
  // order depends on which active node happened to be visited first, and the
  // output must not.
  const keys = Array.from(best.keys()).sort((x, y) => x - y);
  const slack = Math.abs(params.adjDemerits);

  let i = 0;
  while (i < keys.length) {
    // §835: with varying measures the comparison is per line number, because
    // candidates for different line numbers are not alternatives to each other.
    const group = uniform ? -1 : (keys[i] as number) >> 2;
    let j = i;
    let minimum = Infinity;
    while (j < keys.length && (uniform || ((keys[j] as number) >> 2) === group)) {
      const f = best.get(keys[j] as number) as Feasible;
      if (f.totalDemerits < minimum) minimum = f.totalDemerits;
      j++;
    }
    const limit = minimum + slack;
    for (let k = i; k < j; k++) {
      const f = best.get(keys[k] as number) as Feasible;
      if (f.totalDemerits > limit) continue;
      active.push({
        candidate: c,
        lineNumber: f.lineNumber,
        fitness: f.fitness,
        hyphenated: c.hyphenated,
        badness: f.badness,
        demerits: f.demerits,
        totalDemerits: f.totalDemerits,
        previous: f.from,
      });
    }
    i = j;
  }
}

// --- packing the chosen breaks into lines -----------------------------------

function assemble(
  list: HList,
  winner: ActiveNode,
  widths: LineWidths,
  params: LineBreakParams,
  pass: 1 | 2 | 3,
  steps: number,
): LineBreakResult {
  const chain: ActiveNode[] = [];
  for (let node: ActiveNode | null = winner; node !== null && node.previous !== null; node = node.previous) {
    chain.push(node);
  }
  chain.reverse();

  const lines: HBox[] = [];
  const breaks: LineBreak[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let i = 0; i < chain.length; i++) {
    const to = chain[i] as ActiveNode;
    const from = (to.previous as ActiveNode).candidate;
    const line = i + 1;
    const target = lineWidthAt(widths, line);
    const report = packLine(list, from, to.candidate, target, params);

    lines.push(report.box);
    breaks.push({
      position: to.candidate.index,
      line,
      at: to.candidate.kind,
      hyphen: to.candidate.kind === "disc" && to.candidate.preNodes.length > 0,
      penalty: to.candidate.penalty,
      badness: to.badness,
      fitness: to.fitness,
      demerits: to.demerits,
      totalDemerits: to.totalDemerits,
      ratio: report.box.glueSet === null ? 0 : report.box.glueSet.ratio,
      overfull: report.overfull,
    });
    reportLine(diagnostics, report, line, params);
  }

  return { lines, breaks, hlist: list, pass, demerits: winner.totalDemerits, steps, diagnostics };
}

/**
 * The nodes that make up one line, packed to its measure.
 *
 * `\rightskip` goes on every line and `\leftskip` only when it is non-zero,
 * which is what TeX does (§880-881) — and it must, because both were counted
 * into the background while breaking. Leaving them out here would set the glue
 * against a different width than the one the breaker optimised.
 */
function packLine(
  list: HList,
  from: Candidate,
  to: Candidate,
  target: number,
  params: LineBreakParams,
): PackReport {
  const content: HNode[] = [];
  if (params.leftSkip.natural !== 0 || params.leftSkip.stretch !== 0 || params.leftSkip.shrink !== 0) {
    content.push(cloneGlue(params.leftSkip));
  }
  for (const node of from.postNodes) content.push(node);
  for (let i = from.startIndex; i < to.endIndex; i++) content.push(list[i] as HNode);
  for (const node of to.preNodes) content.push(node);
  content.push(cloneGlue(params.rightSkip));
  return hpack(content, target);
}

/** Cloned per line so a consumer that annotates one line's skip cannot touch the rest. */
function cloneGlue(g: Glue): Glue {
  return {
    kind: "glue",
    natural: g.natural,
    stretch: g.stretch,
    stretchOrder: g.stretchOrder,
    shrink: g.shrink,
    shrinkOrder: g.shrinkOrder,
  };
}

function reportLine(
  into: Diagnostic[],
  report: PackReport,
  line: number,
  params: LineBreakParams,
): void {
  if (report.overfull > params.hfuzz) {
    into.push(
      warning(
        "overfull-box",
        params.at,
        `overfull \\hbox (${pt(report.overfull)}pt too wide) on line ${line} of this paragraph`,
      ),
    );
    return;
  }
  // An overfull line is never also reported as underfull: the two cannot both
  // be true, and TeX checks them in this order too (§663-666).
  //
  // §660 reports on a *stretched* box whose glue order is finite. The sign is
  // deliberately not tested: a line with nothing to stretch at all comes back
  // with `sign: 0`, and that is the worst case of underfull, not an exemption
  // from it. Any infinite stretch — the last line's `\parfillskip`, a ragged
  // `\rightskip` — raises the order and rightly says nothing.
  const set = report.box.glueSet;
  if (
    set !== null &&
    set.order === 0 &&
    report.natural < report.box.width &&
    report.badness > params.hbadness
  ) {
    into.push(
      warning(
        "underfull-box",
        params.at,
        `underfull \\hbox (badness ${report.badness}) on line ${line} of this paragraph`,
      ),
    );
  }
}

function pt(value: number): string {
  const s = value.toFixed(2);
  return s === "-0.00" ? "0.00" : s;
}

/**
 * The floor: everything on one line. Only reachable if the final pass somehow
 * finds no path at all, which the artificial-demerits escape is meant to
 * prevent — but `compile()` promises never to throw, and "no lines at all"
 * would be a silent loss of the paragraph, which is worse than an ugly one.
 */
function lastResort(
  list: HList,
  widths: LineWidths,
  params: LineBreakParams,
  steps: number,
): LineBreakResult {
  const target = lineWidthAt(widths, 1);
  const report = hpack(list.slice(), target);
  const diagnostics: Diagnostic[] = [];
  reportLine(diagnostics, report, 1, params);
  return {
    lines: [report.box],
    breaks: [
      {
        position: list.length,
        line: 1,
        at: "end",
        hyphen: false,
        penalty: EJECT_PENALTY,
        badness: report.badness,
        fitness: TIGHT_FIT,
        demerits: 0,
        totalDemerits: 0,
        ratio: report.box.glueSet === null ? 0 : report.box.glueSet.ratio,
        overfull: report.overfull,
      },
    ],
    hlist: list,
    pass: 3,
    demerits: 0,
    steps,
    diagnostics,
  };
}
