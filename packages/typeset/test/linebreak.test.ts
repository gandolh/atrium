import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatinModernProvider } from "../src/font/handle.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import {
  DEFAULT_LINE_BREAK_PARAMS,
  EJECT_PENALTY,
  INFINITE_PENALTY,
  INF_BAD,
  breakParagraph,
  createShaper,
  finishParagraph,
  glue,
  hpack,
  paragraphIndent,
  penalty,
  setWidth,
  textToHList,
} from "../src/layout/index.ts";
import type { HBox, HList, HNode, LineBreakResult, RuleNode, TextFace } from "../src/layout/index.ts";

/**
 * Knuth-Plass line breaking.
 *
 * Two things are being defended here. The first is that this is **total fit**
 * — the optimum over the whole paragraph — which the brute-force test proves
 * outright rather than by inspection. The second is determinism: the golden
 * dumps the rest of the engine is tested with compare layouts exactly, so a
 * breaker whose answer depends on iteration order or accumulation order takes
 * the whole test strategy down with it.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const roman = fonts.get({ family: "serif", weight: "regular", slant: "upright" });
assert.ok(roman, "the committed Latin Modern roman must be available");
const style: TextFace = { font: roman, size: 10 };
const shaper = createShaper();

const GRIMM =
  "In olden times when wishing still helped one, there lived a king whose daughters were all beautiful, " +
  "but the youngest was so beautiful that the sun itself, which has seen so much, was astonished whenever it shone in her face.";

function box(width: number): RuleNode {
  return { kind: "rule", width, height: 0, depth: 0 };
}

/** The set text of a line, spaces included, for readable assertions. */
function lineText(line: HBox): string {
  return line.content
    .map((n) => (n.kind === "glyphs" ? n.text : n.kind === "glue" && n.natural > 0 ? " " : ""))
    .join("");
}

function dump(result: LineBreakResult): string {
  return result.breaks
    .map(
      (b, i) =>
        `${b.line} ${b.position} ${b.badness} ${b.fitness} ${b.demerits} ` +
        `${(result.lines[i] as HBox).width.toFixed(6)} ${b.ratio.toFixed(9)} ${lineText(result.lines[i] as HBox)}`,
    )
    .join("\n");
}

// --- the invariants everything downstream depends on ------------------------

test("every line is packed to its measure and its glue adds up to it", () => {
  // The contract PDF emission relies on: advancing the pen by `setWidth` for
  // every glue and by `width` for everything else lands exactly on the right
  // margin. If this drifts, justified text drifts with it.
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  assert.ok(result.lines.length > 1);

  for (const line of result.lines) {
    assert.equal(line.width, 200);
    let sum = 0;
    for (const node of line.content) {
      if (node.kind === "glue") sum += setWidth(node, line.glueSet);
      else if (node.kind === "kern") sum += node.amount;
      else if (node.kind === "glyphs" || node.kind === "hbox" || node.kind === "rule") sum += node.width;
    }
    assert.ok(Math.abs(sum - line.width) < 1e-9, `line set to ${sum}, wanted ${line.width}`);
  }
});

test("the same input gives byte-identical output, run after run", () => {
  const first = breakParagraph(textToHList(GRIMM, style, { shaper: createShaper() }), 200);
  const second = breakParagraph(textToHList(GRIMM, style, { shaper: createShaper() }), 200);
  assert.equal(dump(first), dump(second));
  assert.equal(first.demerits, second.demerits);
  assert.equal(first.steps, second.steps);

  // And it must not depend on whether a shaping cache was warm — the cache is
  // the one piece of shared mutable state in the stage.
  const warm = createShaper();
  warm(style, "beautiful");
  assert.equal(dump(breakParagraph(textToHList(GRIMM, style, { shaper: warm }), 200, { shaper: warm })), dump(first));
});

test("the lines reassemble the paragraph, losing only the discarded spaces", () => {
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  const set = result.lines
    .map(lineText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(set, GRIMM);
});

// --- total fit, proved -----------------------------------------------------

/**
 * An independent scorer, written from TeX's definitions rather than from the
 * implementation, so that agreeing with it means something.
 */
function scoreBreaking(list: HList, breaks: readonly number[], measure: number): number | null {
  const params = DEFAULT_LINE_BREAK_PARAMS;
  let total = 0;
  let previousFitness = 2;
  let start = 0;

  for (let i = 0; i < breaks.length; i++) {
    const at = breaks[i] as number;
    const report = hpack(list.slice(start, at), measure);
    const set = report.box.glueSet;
    assert.ok(set);

    let badness: number;
    let fitness: number;
    if (report.overfull > 0) return null; // an overfull line is never tolerable
    if (set.sign === 1 && set.order > 0) {
      badness = 0;
      fitness = 2;
    } else if (set.sign === 1) {
      badness = report.badness;
      fitness = badness > 99 ? 0 : badness > 12 ? 1 : 2;
    } else {
      badness = report.badness;
      fitness = badness > 12 ? 3 : 2;
    }
    if (badness > params.tolerance) return null;

    const base = params.linePenalty + badness;
    let d = Math.abs(base) >= 10000 ? 100000000 : base * base;
    if (Math.abs(fitness - previousFitness) > 1) d += params.adjDemerits;
    total += d;
    previousFitness = fitness;

    // Only glue breaks are enumerated below, so the next line starts after the
    // glue and after anything discardable behind it.
    start = at;
    while (start < list.length) {
      const node = list[start] as HNode;
      if (node.kind !== "glue" && node.kind !== "penalty" && node.kind !== "kern") break;
      start++;
    }
  }
  return total;
}

test("the breaking chosen is the optimum over the whole paragraph, not per line", () => {
  // Small enough to enumerate every possible breaking: this is the difference
  // between total fit and first fit, checked rather than asserted.
  const text = "the quick brown fox jumps over a lazy dog again";
  const list = finishParagraph(textToHList(text, style, { shaper }));
  const measure = 120;

  const glueBreaks: number[] = [];
  for (let i = 1; i < list.length; i++) {
    const node = list[i] as HNode;
    const before = list[i - 1] as HNode;
    if (node.kind !== "glue") continue;
    if (before.kind === "glue" || before.kind === "penalty" || before.kind === "kern") continue;
    glueBreaks.push(i);
  }
  assert.ok(glueBreaks.length >= 8 && glueBreaks.length <= 16, `${glueBreaks.length} breakpoints`);

  let bestScore = Infinity;
  for (let mask = 0; mask < 1 << glueBreaks.length; mask++) {
    const chosen: number[] = [];
    for (let bit = 0; bit < glueBreaks.length; bit++) {
      if (mask & (1 << bit)) chosen.push(glueBreaks[bit] as number);
    }
    chosen.push(list.length);
    const score = scoreBreaking(list, chosen, measure);
    if (score !== null && score < bestScore) bestScore = score;
  }
  assert.ok(Number.isFinite(bestScore), "the brute force found no tolerable breaking");

  const result = breakParagraph(list, measure, { shaper, hyphenate: false, finish: false });
  assert.equal(result.demerits, bestScore);
});

test("demerits are (linepenalty + badness) squared, plus the adjacency charge", () => {
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  const params = DEFAULT_LINE_BREAK_PARAMS;

  let previous = 2;
  let running = 0;
  for (const b of result.breaks) {
    const base = params.linePenalty + b.badness;
    let expected = base * base;
    // §859: two fitness classes apart — a tight line beside a loose one — is
    // visible as a change of colour, so it costs `\adjdemerits`.
    if (Math.abs(b.fitness - previous) > 1) expected += params.adjDemerits;
    assert.equal(b.demerits, expected, `line ${b.line} (badness ${b.badness}, fitness ${b.fitness})`);
    previous = b.fitness;
    running += expected;
    assert.equal(b.totalDemerits, running);
  }
  assert.equal(result.demerits, running);
});

test("a paragraph that breaks cleanly never reaches the hyphenation pass", () => {
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  assert.equal(result.pass, 1, "pretolerance should have been enough for a wide measure");
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.breaks.every((b) => !b.hyphen));
});

// --- penalties -------------------------------------------------------------

test("an eject penalty forces a break wherever it appears", () => {
  const list: HList = [
    ...textToHList("one two", style, { shaper }),
    penalty(EJECT_PENALTY),
    ...textToHList("three four", style, { shaper }),
  ];
  const result = breakParagraph(list, 400, { shaper });
  assert.equal(result.lines.length, 2);
  assert.equal(lineText(result.lines[0] as HBox).trim(), "one two");
  assert.equal(result.breaks[0]?.at, "penalty");
  assert.equal(result.breaks[0]?.penalty, EJECT_PENALTY);
});

test("an infinite penalty forbids a break, and a tie is not breakable", () => {
  // This is how `~` works: the glue is still glue, but the penalty in front of
  // it takes the break opportunity away.
  const spaced = textToHList("Chapter 4 begins", style, { shaper });
  const tied: HList = [spaced[0] as HNode, penalty(INFINITE_PENALTY), ...spaced.slice(1)];
  const result = breakParagraph(tied, 42, { shaper, hyphenate: false });
  assert.ok(result.lines.length >= 2);
  assert.equal(
    lineText(result.lines[0] as HBox).trim(),
    "Chapter 4",
    "the tie must have kept `Chapter` and `4` together",
  );
});

test("a negative penalty is a bribe and attracts the break", () => {
  // Two feasible places to end line 1: after the second box (badness 100) and
  // after the third (badness 30). Left alone the breaker takes the better one.
  const widths = [40, 40, 4, 40, 40, 4];
  const build = (bonusAfter: number | null): HList => {
    const out: HList = [];
    for (let i = 0; i < widths.length; i++) {
      if (i > 0) {
        if (bonusAfter === i - 1) out.push(penalty(-1000));
        out.push(glue(10, 10, 3));
      }
      out.push(box(widths[i] as number));
    }
    return out;
  };

  const plain = breakParagraph(build(null), 100, { shaper, hyphenate: false });
  assert.equal(plain.breaks[0]?.at, "glue");
  assert.equal(plain.breaks[0]?.position, 5);

  const bribed = breakParagraph(build(1), 100, { shaper, hyphenate: false });
  assert.equal(bribed.breaks[0]?.at, "penalty", "the bonus should have pulled the break earlier");
  assert.equal(bribed.breaks[0]?.position, 3);

  // §859: a penalty below zero *subtracts* its square, which is what lets a
  // bonus outweigh a line that is otherwise worse. Here badness 100 puts the
  // line two fitness classes from its neighbour, so `\adjdemerits` is charged
  // as well and the bonus still wins.
  const b = bribed.breaks[0] as { badness: number; demerits: number };
  const params = DEFAULT_LINE_BREAK_PARAMS;
  const base = params.linePenalty + b.badness;
  assert.equal(b.demerits, base * base + params.adjDemerits - 1000 * 1000);
});

// --- overfull, underfull, emergencies ---------------------------------------

test("an unbreakable overlong word goes overfull with a diagnostic, not a crash", () => {
  const at = { file: "main.tex", line: 12 };
  const result = breakParagraph(
    textToHList("Short word then supercalifragilisticexpialidocious ends.", style, { shaper }),
    60,
    { shaper, at },
  );

  assert.ok(result.lines.length > 0, "a paragraph must always produce lines");
  const overfull = result.diagnostics.filter((d) => d.code === "overfull-box");
  assert.ok(overfull.length > 0, "the overflow must be reported");
  for (const d of overfull) {
    assert.equal(d.severity, "warning");
    assert.equal(d.file, "main.tex");
    assert.equal(d.line, 12);
    assert.match(d.message, /overfull \\hbox \(\d+\.\d\dpt too wide\)/);
  }
  // The overflow is real and measurable, not swallowed.
  assert.ok(result.breaks.some((b) => b.overfull > 0));
  // Every line still carries a glue set, so emission has something to place by.
  for (const line of result.lines) assert.notEqual(line.glueSet, null);
});

test("a single word wider than the measure is one overfull line", () => {
  const result = breakParagraph([box(500)], 100, { shaper, hyphenate: false });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]?.width, 100);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "overfull-box");
});

test("hfuzz keeps a hair's overflow quiet", () => {
  const list: HList = [box(100.05)];
  assert.deepEqual(breakParagraph(list, 100, { shaper, hyphenate: false }).diagnostics, []);
  assert.equal(breakParagraph(list, 100, { shaper, hyphenate: false, hfuzz: 0 }).diagnostics.length, 1);
});

test("emergency stretch trades overfull boxes for underfull ones", () => {
  const text = "The typographical extravagance of independent hyphenation demonstrates unquestionably remarkable behaviour.";
  const tight = breakParagraph(textToHList(text, style, { shaper }), 100, { shaper });
  assert.equal(tight.pass, 2);
  assert.ok(tight.diagnostics.some((d) => d.code === "overfull-box"));

  const loose = breakParagraph(textToHList(text, style, { shaper }), 100, { shaper, emergencyStretch: 12 });
  assert.equal(loose.pass, 3);
  assert.ok(!loose.diagnostics.some((d) => d.code === "overfull-box"));
  // TeX's own trade: the third pass pretends the extra stretch is there while
  // choosing, then packs the lines without it, so they come out underfull.
  assert.ok(loose.diagnostics.some((d) => d.code === "underfull-box"));
});

// --- skips and varying measures ---------------------------------------------

test("a fil rightskip is what ragged right is, and it leaves the spaces alone", () => {
  const spacing = (textToHList("a b", style, { shaper })[1] as { natural: number }).natural;
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, {
    shaper,
    rightSkip: glue(0, 1, 0, 1),
  });

  for (const [i, line] of result.lines.entries()) {
    assert.equal(line.glueSet?.order, 1, `line ${i + 1} should be set on the fil rightskip`);
    for (const node of line.content) {
      if (node.kind !== "glue" || node.natural === 0) continue;
      assert.equal(setWidth(node, line.glueSet), node.natural, "interword spaces must stay at their natural size");
      assert.equal(node.natural, spacing);
    }
  }
  assert.ok(result.breaks.every((b) => b.badness === 0), "every ragged line is badness 0 by construction");
});

test("leftskip and rightskip are counted while breaking, not only when packing", () => {
  // If they were added only at packing time, the lines would be set against a
  // different width than the one the breaker optimised for.
  const plain = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  const inset = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, {
    shaper,
    leftSkip: glue(30),
    rightSkip: glue(30),
  });
  assert.notEqual(dump(plain), dump(inset), "60pt of skip must change where the lines break");
  for (const line of inset.lines) {
    assert.equal(line.width, 200);
    const first = line.content[0];
    assert.equal(first?.kind, "glue");
    assert.equal((first as { natural: number }).natural, 30);
  }
});

test("an array of measures gives per-line widths, with the last one repeating", () => {
  const widths = [120, 200];
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), widths, { shaper });
  assert.ok(result.lines.length > 2);
  assert.equal(result.lines[0]?.width, 120);
  for (const line of result.lines.slice(1)) assert.equal(line.width, 200);
});

// --- edges ------------------------------------------------------------------

test("an empty paragraph is one empty line rather than nothing at all", () => {
  const result = breakParagraph([], 200, { shaper });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]?.width, 200);
  assert.deepEqual(result.diagnostics, []);
});

test("a paragraph indent is carried into the first line and only the first", () => {
  const list: HList = [paragraphIndent(15), ...textToHList(GRIMM, style, { shaper })];
  const result = breakParagraph(list, 200, { shaper });
  assert.equal(result.lines[0]?.content[0]?.kind, "hbox");
  assert.equal((result.lines[0]?.content[0] as HBox).width, 15);
  for (const line of result.lines.slice(1)) assert.notEqual(line.content[0]?.kind, "hbox");
});

test("the last line is short and is never reported as underfull", () => {
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  const last = result.lines[result.lines.length - 1] as HBox;
  // `\parfillskip`'s fil absorbs the whole shortfall, so the badness is 0 no
  // matter how short the line is.
  assert.equal(last.glueSet?.order, 1);
  assert.equal(result.breaks[result.breaks.length - 1]?.badness, 0);
  assert.ok(!result.diagnostics.some((d) => d.code === "underfull-box"));
});

test("badness never exceeds TeX's inf_bad, and no line is chosen above tolerance", () => {
  const result = breakParagraph(textToHList(GRIMM, style, { shaper }), 200, { shaper });
  for (const b of result.breaks) {
    assert.ok(b.badness <= INF_BAD);
    assert.ok(b.badness <= DEFAULT_LINE_BREAK_PARAMS.tolerance, `line ${b.line} badness ${b.badness}`);
  }
});
