import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatinModernProvider } from "../src/font/handle.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import {
  breakParagraph,
  createEnglishHyphenator,
  createShaper,
  glue,
  hyphenateHList,
  measure,
  naturalSize,
  textToHList,
} from "../src/layout/index.ts";
import type { Discretionary, GlyphNode, HBox, HList, RuleNode, TextFace } from "../src/layout/index.ts";

/**
 * Hyphenation, and what it does to the paragraph.
 *
 * Two properties matter more than which words break where. First, the
 * *unbroken* word must still measure exactly what it did before the
 * discretionaries went in, or every un-hyphenated line silently changes width.
 * Second, hyphenation must never invent a break that cannot be set — which is
 * why a point falling inside a ligature is dropped rather than approximated.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const roman = fonts.get({ family: "serif", weight: "regular", slant: "upright" });
const mono = fonts.get({ family: "mono", weight: "regular", slant: "upright" });
assert.ok(roman);
assert.ok(mono);
const style: TextFace = { font: roman, size: 10 };
const shaper = createShaper();
const hyphenator = createEnglishHyphenator();

function word(text: string, s: TextFace = style): GlyphNode {
  const node = textToHList(text, s, { shaper })[0];
  assert.equal(node?.kind, "glyphs");
  return node;
}

function render(list: HList): string {
  return list.map((n) => (n.kind === "glyphs" ? n.text : n.kind === "disc" ? "-|" : "?")).join("");
}

function lineText(line: HBox): string {
  return line.content
    .map((n) => (n.kind === "glyphs" ? n.text : n.kind === "glue" && n.natural > 0 ? " " : ""))
    .join("");
}

test("Liang's patterns find TeX's break points", () => {
  // The en-US pattern file is the one TeX ships, so these are TeX's answers.
  assert.deepEqual(hyphenator.positions("typographical"), [2, 4, 9, 10]); // ty-po-graph-i-cal
  assert.deepEqual(hyphenator.positions("independent"), [2, 4, 7]); //     in-de-pen-dent
  assert.deepEqual(hyphenator.positions("representation"), [3, 5, 8, 10]); // rep-re-sen-ta-tion
  assert.deepEqual(hyphenator.positions("beautiful"), [4, 6]); //          beau-ti-ful
  // `\lefthyphenmin` 2 and `\righthyphenmin` 3 come from the pattern file, so
  // a short word offers nothing at all.
  assert.deepEqual(hyphenator.positions("olden"), []);
  assert.deepEqual(hyphenator.positions("the"), []);
});

test("a hyphenated word becomes fragments joined by discretionaries", () => {
  const list = hyphenateHList([word("extravagance")], { shaper, hyphenator });
  assert.equal(render(list), "ex-|trav-|a-|gance");

  for (const node of list) {
    if (node.kind !== "disc") continue;
    const disc = node as Discretionary;
    // `pre` is the hyphen that only exists if the break is taken; `no` is empty
    // because the fragments themselves are the unbroken word.
    assert.equal(disc.pre.length, 1);
    assert.equal((disc.pre[0] as GlyphNode).text, "-");
    assert.deepEqual(disc.post, []);
    assert.deepEqual(disc.no, []);
    assert.equal(disc.penalty, 50);
  }
});

test("the unbroken word keeps every glyph and every advance it had", () => {
  // Glyphs are sliced rather than re-shaped, so the kerns folded into each
  // advance survive. Re-shaping the fragments would lose every kern that
  // straddles a break and make the unbroken word quietly narrower — which is
  // why the check is on the advances themselves, not only on the total.
  for (const text of ["extravagance", "typographical", "representation", "beautiful", "hyphenation"]) {
    const whole = word(text);
    const pieces = hyphenateHList([whole], { shaper, hyphenator });

    const rejoined = pieces.filter((n) => n.kind === "glyphs").flatMap((n) => (n as GlyphNode).glyphs);
    assert.deepEqual(
      rejoined.map((g) => [g.id, g.advance]),
      whole.glyphs.map((g) => [g.id, g.advance]),
      text,
    );
    // The width follows, up to the order the advances are added in — the
    // fragments sum their own advances before the totals meet.
    const sum = pieces.reduce((total, node) => total + naturalSize(node, "h"), 0);
    assert.ok(Math.abs(sum - whole.width) < 1e-9, `${text}: ${sum} vs ${whole.width}`);
    assert.ok(Math.abs(measure(pieces, "h").natural - whole.width) < 1e-9);
  }
});

test("clusters are rebased so each fragment indexes its own text", () => {
  const pieces = hyphenateHList([word("typographical")], { shaper, hyphenator });
  for (const node of pieces) {
    if (node.kind !== "glyphs") continue;
    assert.equal(node.glyphs[0]?.cluster, 0, `${node.text} must start at cluster 0`);
    for (const g of node.glyphs) assert.ok(g.cluster < node.text.length);
  }
});

test("a break point inside a ligature is dropped, not approximated", () => {
  // Latin Modern sets `ffi` as one glyph, so `dif-fi-cult` has no glyph
  // boundary at the first point. TeX rebuilds the ligature into the
  // discretionary's three lists; we take the conservative half of that and keep
  // only the break we can set exactly, losing an opportunity rather than
  // inventing a wrong one.
  const difficult = word("difficult");
  assert.deepEqual(hyphenator.positions("difficult"), [3, 5]);
  const clusters = difficult.glyphs.map((g) => g.cluster);
  assert.ok(!clusters.includes(3), "the ffi ligature should swallow character 3");
  assert.ok(clusters.includes(5));
  assert.equal(render(hyphenateHList([difficult], { shaper, hyphenator })), "diffi-|cult");
});

test("a word the author already hyphenated is left alone", () => {
  // TeX §896 refuses to hyphenate a word containing an explicit hyphen: the
  // author's hyphen is the break, and a second one in the same word is a typo.
  const list = textToHList("well-established", style, { shaper });
  const hyphenated = hyphenateHList(list, { shaper, hyphenator });
  const discs = hyphenated.filter((n) => n.kind === "disc");
  assert.equal(discs.length, 1, "only the author's own break should be there");
  assert.deepEqual((discs[0] as Discretionary).pre, []);
});

test("a face may be excluded from hyphenation, as plain TeX excludes typewriter", () => {
  const typed = word("hyphenation", { font: mono, size: 10 });
  assert.ok(hyphenateHList([typed], { shaper, hyphenator }).length > 1);
  const suppressed = hyphenateHList([typed], {
    shaper,
    hyphenator,
    hyphenateFont: (font) => !font.id.startsWith("lmmono"),
  });
  assert.deepEqual(suppressed, [typed]);
});

test("hyphenating nothing returns the very same array", () => {
  // Cheap, but it is what lets the first pass hand the untouched list straight
  // back rather than copying every paragraph that needs no hyphens.
  const list = textToHList("the cat sat on a mat", style, { shaper });
  assert.equal(hyphenateHList(list, { shaper, hyphenator }), list);
});

// --- through the breaker ----------------------------------------------------

const NARROW =
  "In olden times when wishing still helped one, there lived a king whose daughters were all beautiful, " +
  "but the youngest was so beautiful that the sun itself, which has seen so much, was astonished whenever it shone in her face.";

test("a wide measure never reaches the hyphenating pass; a narrow one does", () => {
  // §863's first pass exists precisely so that a paragraph which sets cleanly
  // on its spaces is never hyphenated at all.
  const wide = breakParagraph(textToHList(NARROW, style, { shaper }), 200, { shaper });
  assert.equal(wide.pass, 1);
  assert.ok(wide.breaks.every((b) => !b.hyphen));

  const narrow = breakParagraph(textToHList(NARROW, style, { shaper }), 120, { shaper });
  assert.equal(narrow.pass, 2, "pretolerance without hyphens cannot set this measure");
  assert.ok(narrow.breaks.some((b) => b.hyphen));
});

test("a hyphenated line really ends with a hyphen, and the next one carries on", () => {
  const result = breakParagraph(textToHList(NARROW, style, { shaper }), 120, { shaper });
  const index = result.breaks.findIndex((b) => b.hyphen);
  assert.ok(index >= 0);

  const line = result.lines[index] as HBox;
  const glyphs = line.content.filter((n) => n.kind === "glyphs");
  assert.equal((glyphs[glyphs.length - 1] as GlyphNode).text, "-");
  assert.equal(result.breaks[index]?.at, "disc");
  assert.equal(result.breaks[index]?.penalty, 50);

  // Joining the lines back up, minus the hyphens the breaks added, gives the
  // paragraph again — nothing was duplicated and nothing was lost.
  const set = result.lines
    .map((l, i) => {
      const text = lineText(l);
      return result.breaks[i]?.hyphen ? text.slice(0, -1) : `${text} `;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(set, NARROW);
});

test("hyphenation is what makes a narrow measure settable at all", () => {
  const on = breakParagraph(textToHList(NARROW, style, { shaper }), 120, { shaper });
  const off = breakParagraph(textToHList(NARROW, style, { shaper }), 120, { shaper, hyphenate: false });

  assert.ok(off.breaks.every((b) => !b.hyphen));
  assert.notEqual(on.demerits, off.demerits);
  // With hyphens the whole paragraph fits its measure; without them the final
  // pass has to force overfull lines, because the gap between "too loose to
  // tolerate" and "too long to shrink" contains no break at all.
  assert.deepEqual(on.diagnostics, []);
  assert.ok(off.diagnostics.filter((d) => d.code === "overfull-box").length >= 3);
});

test("the hyphen penalty, double hyphens and the final hyphen are all charged", () => {
  // Built rather than found: every line here is exactly its measure, so the
  // badness term is zero and each demerit can be read off on its own. The
  // "words" are two 25pt halves with a 4pt hyphen between them, and the only
  // breaks that fit are the hyphens.
  const box = (w: number): RuleNode => ({ kind: "rule", width: w, height: 0, depth: 0 });
  const hyphen = (): Discretionary => ({ kind: "disc", pre: [box(4)], post: [], no: [], penalty: 50 });
  const list: HList = [box(25)];
  for (let i = 0; i < 6; i++) list.push(glue(10, 10, 3), box(25), hyphen(), box(25));

  const result = breakParagraph(list, 124, { shaper, hyphenate: false });
  assert.equal(result.breaks.length, 4);
  assert.ok(result.breaks.slice(0, 3).every((b) => b.hyphen && b.badness === 0));

  // §859 term by term: (linepenalty + badness)^2, plus the break's own penalty
  // squared, plus `\doublehyphendemerits` once a hyphen follows a hyphen.
  assert.equal(result.breaks[0]?.demerits, 100 + 50 * 50);
  assert.equal(result.breaks[1]?.demerits, 100 + 50 * 50 + 10000);
  assert.equal(result.breaks[2]?.demerits, 100 + 50 * 50 + 10000);
  // The paragraph's own end is flagged hyphenated (§873) purely so that a
  // hyphen on the penultimate line is charged `\finalhyphendemerits` instead.
  assert.equal(result.breaks[3]?.hyphen, false);
  assert.equal(result.breaks[3]?.demerits, 100 + 5000);

  // And the charge is a real lever: raise it and the total moves by exactly the
  // two double-hyphen pairs.
  const dearer = breakParagraph(list, 124, { shaper, hyphenate: false, doubleHyphenDemerits: 20000 });
  assert.equal(dearer.demerits, result.demerits + 2 * 10000);
});

test("hyphenation is deterministic across runs and across shaper caches", () => {
  const dumpOf = (result: { breaks: readonly { position: number; badness: number; demerits: number }[] }): string =>
    result.breaks.map((b) => `${b.position}/${b.badness}/${b.demerits}`).join(" ");
  const a = breakParagraph(textToHList(NARROW, style, { shaper: createShaper() }), 120);
  const b = breakParagraph(textToHList(NARROW, style, { shaper: createShaper() }), 120, {
    hyphenator: createEnglishHyphenator(),
  });
  assert.equal(dumpOf(a), dumpOf(b));
});
