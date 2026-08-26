import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatinModernProvider } from "../src/font/handle.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import {
  INFINITE_PENALTY,
  createShaper,
  finishParagraph,
  fontSpacing,
  glue,
  isFinished,
  measure,
  paragraphIndent,
  textToHList,
} from "../src/layout/index.ts";
import type { Discretionary, GlyphNode, HList, TextFace } from "../src/layout/index.ts";

/**
 * The input contract: what a paragraph looks like before it is broken.
 *
 * The one thing here that is easy to get wrong and impossible to see later is
 * that an interword space must be **glue**. The font will happily shape U+0020
 * into a real glyph with a fixed advance; a paragraph built that way measures
 * correctly and can never be justified.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const roman = fonts.get({ family: "serif", weight: "regular", slant: "upright" });
assert.ok(roman, "the committed Latin Modern roman must be available");
const style: TextFace = { font: roman, size: 10 };
const shaper = createShaper();

function kinds(list: HList): string {
  return list.map((n) => n.kind).join(",");
}

test("words become glyph runs and the spaces between them become glue", () => {
  const list = textToHList("The quick brown fox", style, { shaper });
  assert.equal(kinds(list), "glyphs,glue,glyphs,glue,glyphs,glue,glyphs");
  for (const node of list) {
    if (node.kind !== "glyphs") continue;
    assert.ok(!node.text.includes(" "), `a glyph run must not contain a space: ${node.text}`);
  }
});

test("interword glue matches TeX's fontdimen 2, 3 and 4 for the face", () => {
  const spacing = fontSpacing(style, shaper);
  // Computer Modern, and Latin Modern after it, sets the interword space to
  // the width of U+0020 and derives stretch and shrink as half and a third.
  assert.equal(spacing.space, roman.shape(" ", 10).width);
  assert.equal(spacing.stretch, spacing.space / 2);
  assert.equal(spacing.shrink, spacing.space / 3);

  const list = textToHList("one two", style, { shaper });
  const g = list[1];
  assert.equal(g.kind, "glue");
  assert.equal(g.natural, spacing.space);
  assert.equal(g.stretch, spacing.stretch);
  assert.equal(g.shrink, spacing.shrink);
  assert.equal(g.stretchOrder, 0);
  assert.equal(g.shrinkOrder, 0);
});

test("the built list measures what shaping the whole string measures", () => {
  // Chunk 2's reference number. This is the check that word-by-word shaping
  // plus our own interword glue does not quietly lose or gain anything: TeX
  // never kerns across a space, so the two routes must agree.
  const whole = roman.shape("The quick brown fox", 10);
  assert.equal(Number(whole.width.toFixed(2)), 90.31);
  const natural = measure(textToHList("The quick brown fox", style, { shaper }), "h").natural;
  assert.ok(Math.abs(natural - whole.width) < 1e-9, `${natural} vs ${whole.width}`);
});

test("a sentence gets TeX's extra space, and an initialism does not", () => {
  // §1034/§1043. The space factor after `.` is 3000, which adds `\fontdimen7`
  // and scales stretch by 3 and shrink by 1/3. After an uppercase letter the
  // factor is 999, and the `< 1000` rule then pins a following `.` back to
  // 1000 — which is exactly why `U.S.A. next` is not a sentence break.
  const spacing = fontSpacing(style, shaper);

  const sentence = textToHList("end. Next", style, { shaper })[1];
  assert.equal(sentence.kind, "glue");
  assert.equal(sentence.natural, spacing.space + spacing.extraSpace);
  assert.equal(sentence.stretch, (spacing.stretch * 3000) / 1000);
  assert.equal(sentence.shrink, (spacing.shrink * 1000) / 3000);

  const initialism = textToHList("U.S.A. next", style, { shaper })[1];
  assert.equal(initialism.kind, "glue");
  assert.equal(initialism.natural, spacing.space);

  // A closing delimiter is transparent (`\sfcode` 0), so the period still ends
  // the sentence through it.
  const throughParen = textToHList("(ibid.) Next", style, { shaper })[1];
  assert.equal(throughParen.kind, "glue");
  assert.equal(throughParen.natural, spacing.space + spacing.extraSpace);

  // `\frenchspacing` turns the whole mechanism off.
  const french = textToHList("end. Next", style, { shaper, frenchSpacing: true })[1];
  assert.equal(french.kind, "glue");
  assert.equal(french.natural, spacing.space);
});

test("a comma widens the space less than a full stop does", () => {
  const spacing = fontSpacing(style, shaper);
  const comma = textToHList("one, two", style, { shaper })[1];
  assert.equal(comma.kind, "glue");
  // Space factor 1250: below 2000, so no extra space, but the flex still moves.
  assert.equal(comma.natural, spacing.space);
  assert.equal(comma.stretch, (spacing.stretch * 1250) / 1000);
  assert.equal(comma.shrink, (spacing.shrink * 1000) / 1250);
});

test("an author's hyphen leaves an empty discretionary behind it", () => {
  const list = textToHList("well-known", style, { shaper });
  assert.equal(kinds(list), "glyphs,disc,glyphs");
  assert.equal((list[0] as GlyphNode).text, "well-");
  assert.equal((list[2] as GlyphNode).text, "known");

  const disc = list[1] as Discretionary;
  // Empty `pre`: the hyphen is already on the page, so taking the break must
  // not print a second one. TeX §1117 does exactly this, and §869 is why the
  // penalty here is `\exhyphenpenalty` rather than `\hyphenpenalty`.
  assert.deepEqual(disc.pre, []);
  assert.deepEqual(disc.post, []);
  assert.deepEqual(disc.no, []);
  assert.equal(disc.penalty, 50);
});

test("whitespace collapses and the runs concatenate at the seam", () => {
  assert.equal(kinds(textToHList("a   b\n c", style, { shaper })), "glyphs,glue,glyphs,glue,glyphs");
  // Leading and trailing whitespace survive as glue, so two runs joined end to
  // end keep the space between them.
  assert.equal(kinds(textToHList(" a ", style, { shaper })), "glue,glyphs,glue");
});

test("the paragraph indent is a box, so nothing can break inside it", () => {
  const indent = paragraphIndent(15);
  assert.equal(indent.kind, "hbox");
  assert.equal(indent.width, 15);
  assert.deepEqual(indent.content, []);
  assert.equal(indent.glueSet, null);
});

test("finishing a paragraph drops the trailing space and adds parfillskip", () => {
  const finished = finishParagraph(textToHList("one two ", style, { shaper }));
  assert.equal(kinds(finished), "glyphs,glue,glyphs,penalty,glue");

  const stop = finished[3];
  assert.equal(stop.kind, "penalty");
  assert.equal(stop.penalty, INFINITE_PENALTY);

  const fill = finished[4];
  assert.equal(fill.kind, "glue");
  assert.equal(fill.natural, 0);
  assert.equal(fill.stretchOrder, 1, "parfillskip is 0pt plus 1fil");
  assert.equal(fill.stretch, 1);

  // Idempotent, so a caller that finishes its own paragraphs is not punished.
  assert.equal(finishParagraph(finished), finished);
  assert.ok(isFinished(finished));
  assert.ok(!isFinished(textToHList("one two", style, { shaper })));
});

test("a custom parfillskip is honoured — this is how a flush last line is set", () => {
  const finished = finishParagraph(textToHList("one two", style, { shaper }), glue(0));
  const fill = finished[finished.length - 1];
  assert.equal(fill.kind, "glue");
  assert.equal(fill.stretch, 0);
});

test("shaping is memoised, and the cache changes nothing but speed", () => {
  const cached = createShaper();
  const first = cached(style, "hyphenation");
  const second = cached(style, "hyphenation");
  assert.equal(first, second, "the same call must return the same shaped run");
  assert.deepEqual(first, roman.shape("hyphenation", 10));
});
