import { test } from "node:test";
import assert from "node:assert/strict";
import { createFontHandle, createLatinModernProvider, scaleToPoints } from "../src/index.ts";
import type { FontHandle } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Tests for the fontkit-backed `FontHandle`.
 *
 * The rule these follow: **check the font against itself, never against a
 * number typed from memory.** A test that asserts "The quick brown fox" is
 * 90.31 pt only proves that today's code agrees with yesterday's; a test that
 * rebuilds the width out of `advanceWidth` and `kern` and finds the same answer
 * proves that `shape()` really is applying the metrics in the file. Both kinds
 * appear below, but the derived ones are the ones that carry the weight — the
 * few literal constants exist to catch a wholesale change of font, and are
 * marked as such.
 */

const BYTES = loadLatinModernBytes();
const fonts = createLatinModernProvider(BYTES);

function face(family: "serif" | "sans" | "mono", weight: "regular" | "bold", slant: "upright" | "italic"): FontHandle {
  const handle = fonts.get({ family, weight, slant });
  assert.ok(handle, `no handle for ${family}/${weight}/${slant}`);
  return handle;
}

const roman = face("serif", "regular", "upright");

/** Glyph id of a single character, via the same path layout would use. */
function gid(handle: FontHandle, char: string): number {
  const ids = handle.glyphsForString(char);
  assert.equal(ids.length, 1, `expected one glyph for ${JSON.stringify(char)}`);
  return ids[0]!;
}

/**
 * Rebuild a run's width from the raw per-glyph metrics: advances out of `hmtx`,
 * pair kerns out of GPOS, scaled by the one conversion rule. Independent of
 * `shape()`'s own arithmetic, which is the point.
 */
function widthFromRawMetrics(handle: FontHandle, glyphIds: readonly number[], size: number): number {
  let units = 0;
  for (let i = 0; i < glyphIds.length; i++) {
    units += handle.advanceWidth(glyphIds[i]!);
    if (i + 1 < glyphIds.length) units += handle.kern(glyphIds[i]!, glyphIds[i + 1]!);
  }
  return scaleToPoints(units, size, handle.unitsPerEm);
}

// --- metrics ---------------------------------------------------------------

test("font: handle reports the face's own metrics", () => {
  assert.equal(roman.id, "lmroman10-regular");
  assert.equal(roman.postscriptName, "LMRoman10-Regular");
  assert.equal(roman.unitsPerEm, 1000);
  assert.equal(roman.data, BYTES["lmroman10-regular"]);
});

test("font: descent is positive-downwards on every face", () => {
  // OpenType stores hhea.descent negative. The interface promises the opposite,
  // and a face that leaked the raw sign would push every baseline up the page.
  for (const family of ["serif", "sans", "mono"] as const) {
    for (const weight of ["regular", "bold"] as const) {
      for (const slant of ["upright", "italic"] as const) {
        const handle = face(family, weight, slant);
        assert.ok(handle.descent > 0, `${handle.id} descent ${handle.descent}`);
        assert.ok(handle.ascent > 0, `${handle.id} ascent ${handle.ascent}`);
      }
    }
  }
});

test("font: x-height and cap-height agree with the letters they are named for", () => {
  // OS/2 is the source, but a font may leave it at zero; either way the value
  // has to describe the actual outlines or every accent lands wrong.
  const xTop = roman.shape("x", 1000).height;
  const hTop = roman.shape("H", 1000).height;
  assert.equal(roman.xHeight, xTop);
  assert.equal(roman.capHeight, hTop);
  assert.ok(roman.xHeight < roman.capHeight);
  assert.ok(roman.capHeight < roman.ascent);
});

// --- shaping ---------------------------------------------------------------

test("font: shaped width equals the width rebuilt from raw metrics", () => {
  for (const text of ["The quick brown fox", "office", "AV To Wa", "Typography, 1234."]) {
    for (const size of [10, 12, 17.28]) {
      const shaped = roman.shape(text, size);
      const ids = shaped.glyphs.map((glyph) => glyph.id);
      assert.ok(
        Math.abs(shaped.width - widthFromRawMetrics(roman, ids, size)) < 1e-9,
        `${JSON.stringify(text)}@${size}: shape() says ${shaped.width}`,
      );
    }
  }
});

test("font: width is the sum of the advances it hands back", () => {
  // The interface documents `width` as exactly that, and chunk 4 will add the
  // advances up itself when it splits a run at a break.
  const shaped = roman.shape("The quick brown fox", 10);
  const summed = shaped.glyphs.reduce((total, glyph) => total + glyph.advance, 0);
  assert.equal(shaped.width, summed);
});

test("font: shaping is linear in size", () => {
  const ten = roman.shape("The quick brown fox", 10);
  const twenty = roman.shape("The quick brown fox", 20);
  assert.ok(Math.abs(twenty.width - ten.width * 2) < 1e-9);
  assert.ok(Math.abs(twenty.height - ten.height * 2) < 1e-9);
  assert.ok(Math.abs(twenty.depth - ten.depth * 2) < 1e-9);
});

test("font: measured reference run — Latin Modern Roman at 10 pt", () => {
  // A canary, not a proof: the derived tests above establish that the numbers
  // are the font's; this one notices if the font underneath them is swapped.
  const shaped = roman.shape("The quick brown fox", 10);
  assert.equal(shaped.glyphs.length, 19);
  assert.equal(round(shaped.width), 90.31);
  assert.equal(round(shaped.height), 7.05);
  assert.equal(round(shaped.depth), 1.94);
});

test("font: height and depth follow the ink, not the font box", () => {
  // TeX's height/depth are the contents' extent — that is what makes
  // \baselineskip's interline glue come out right.
  const flat = roman.shape("nmx", 10);
  const moon = roman.shape("moon", 10);
  const gpqy = roman.shape("gpqy", 10);
  assert.equal(flat.depth, 0, "flat-bottomed letters sit on the baseline");
  // Round letters overshoot the baseline by about 1% of the em so they do not
  // look small next to flat ones; that ink is real and shows up as depth. TeX's
  // TFM files rounded it away, we do not.
  assert.ok(moon.depth > 0 && moon.depth < 0.2, `optical overshoot, got ${moon.depth}`);
  assert.ok(gpqy.depth > 1, "a real descender is an order of magnitude deeper");
  assert.ok(roman.shape("h", 10).height > roman.shape("x", 10).height);
  // Glyphs with no outline contribute nothing, which is right: a space is not
  // as tall as the font.
  const spaces = roman.shape("  ", 10);
  assert.equal(spaces.height, 0);
  assert.equal(spaces.depth, 0);
});

test("font: an empty string shapes to nothing", () => {
  assert.deepEqual(roman.shape("", 10), { glyphs: [], width: 0, height: 0, depth: 0 });
});

// --- ligatures -------------------------------------------------------------

test("font: ligatures apply", () => {
  // "office" is o + ffi + c + e in Latin Modern: the f-f-i run becomes one
  // glyph, so six characters come out as four.
  const ids = roman.glyphsForString("office");
  assert.equal(ids.length, 4);

  const separate = roman.glyphsForString("o") .concat(
    roman.glyphsForString("f"),
    roman.glyphsForString("f"),
    roman.glyphsForString("i"),
    roman.glyphsForString("c"),
    roman.glyphsForString("e"),
  );
  assert.equal(separate.length, 6);
  assert.notEqual(ids[1], separate[1], "the ligature must not be a plain 'f'");

  // The narrower "fi" pair ligates too, and is not the same glyph as "ffi".
  const fi = roman.glyphsForString("fi");
  assert.equal(fi.length, 1);
  assert.notEqual(fi[0], ids[1]);

  // A ligature is narrower than its parts drawn separately — that is the point
  // of it, and it means the substitution really reached the metrics.
  assert.ok(roman.shape("office", 10).width < widthFromRawMetrics(roman, separate, 10));
});

test("font: clusters point back into the source string", () => {
  // "office": o=0, ffi covers 1..3 and reports 1, c=4, e=5. Chunk 5 builds
  // /ToUnicode out of this, so an off-by-one here is a document whose text
  // cannot be copied out correctly.
  assert.deepEqual(
    roman.shape("office", 10).glyphs.map((glyph) => glyph.cluster),
    [0, 1, 4, 5],
  );
  // Astral characters occupy two UTF-16 units and must count as one cluster.
  assert.deepEqual(
    roman.shape("a\u{1F600}b", 10).glyphs.map((glyph) => glyph.cluster),
    [0, 1, 3],
  );
  // Clusters never run backwards or off the end.
  const text = "The quick brown fox jumps — ﬁnally — over 1½ lazy dogs.";
  let previous = -1;
  for (const glyph of roman.shape(text, 10).glyphs) {
    assert.ok(glyph.cluster >= previous, "clusters must be monotone");
    assert.ok(glyph.cluster < text.length, "cluster outside the source string");
    previous = glyph.cluster;
  }
});

test("font: a precomposed ligature character does not corrupt later clusters", () => {
  // fontkit caches Glyph objects by id along with the code points of whichever
  // lookup built them first, so shaping "ﬁ" (U+FB01) teaches it that glyph is
  // worth one code point — and a later "fi", which really is worth two, would
  // then shift every following cluster left by one. The handle detects the
  // mismatch and reshapes; this is the test that the detection actually fires.
  const handle = createFontHandle("probe", BYTES["lmroman10-regular"]!);
  assert.equal(handle.shape("ﬁ", 10).glyphs.length, 1);
  assert.deepEqual(
    handle.shape("afib", 10).glyphs.map((glyph) => glyph.cluster),
    [0, 1, 3],
  );
});

// --- kerning ---------------------------------------------------------------

test("font: kerning applies and is negative for the classic pairs", () => {
  assert.ok(roman.kern(gid(roman, "A"), gid(roman, "V")) < 0);
  assert.ok(roman.kern(gid(roman, "T"), gid(roman, "o")) < 0);
  // An unkerned pair reports exactly zero rather than a rounding artefact.
  assert.equal(roman.kern(gid(roman, "A"), gid(roman, "B")), 0);
});

test("font: shape() folds the kern into the left glyph's advance", () => {
  const pair = roman.shape("AV", 10);
  const kern = roman.kern(gid(roman, "A"), gid(roman, "V"));
  assert.ok(kern < 0);
  const unkerned = scaleToPoints(
    roman.advanceWidth(gid(roman, "A")) + roman.advanceWidth(gid(roman, "V")),
    10,
    roman.unitsPerEm,
  );
  assert.ok(Math.abs(pair.width - (unkerned + scaleToPoints(kern, 10, roman.unitsPerEm))) < 1e-9);
  assert.ok(pair.width < unkerned, "AV must set tighter than A followed by V");
  // The adjustment lands on the left glyph, which is what lets a line breaker
  // cut a run after any glyph and still add the advances up correctly.
  assert.equal(
    round(pair.glyphs[0]!.advance),
    round(scaleToPoints(roman.advanceWidth(gid(roman, "A")) + kern, 10, roman.unitsPerEm)),
  );
});

test("font: kern() answers about the pair it was asked about", () => {
  // Not about the ligature those two glyphs would form if substitution were
  // left switched on — "f" then "i" is a kerning question, not an "ﬁ" question,
  // and answering it with the ligature's width would be off by 28 units here.
  const f = gid(roman, "f");
  const i = gid(roman, "i");
  const pair = roman.advanceWidth(f) + roman.kern(f, i) + roman.advanceWidth(i);
  const ligature = roman.advanceWidth(roman.glyphsForString("fi")[0]!);
  assert.notEqual(pair, ligature);
  assert.ok(Math.abs(roman.kern(f, i)) < roman.xHeight, "a kern is an adjustment, not a width");
});

// --- the edges layout has to know about -----------------------------------

test("font: an unmapped character shapes to .notdef, not to nothing", () => {
  // No diagnostic comes from the font layer — it reports what the font can do
  // and leaves the policy to the caller. Chunk 4 can spot these by id.
  const shaped = roman.shape("一", 10);
  assert.equal(shaped.glyphs.length, 1);
  assert.equal(shaped.glyphs[0]!.id, 0);
  assert.ok(shaped.glyphs[0]!.advance > 0, ".notdef still occupies space");
});

test("font: control characters are glyphs like any other", () => {
  // shape() does not interpret whitespace: a newline is an unmapped character
  // and comes back as .notdef. Runs reaching shape() must already be normalised.
  const shaped = roman.shape("a\nb", 10);
  assert.equal(shaped.glyphs.length, 3);
  assert.equal(shaped.glyphs[1]!.id, 0);
  // U+0020, by contrast, is a real glyph with a real advance and no flex.
  const space = roman.shape(" ", 10);
  assert.equal(space.glyphs.length, 1);
  assert.notEqual(space.glyphs[0]!.id, 0);
  assert.ok(space.glyphs[0]!.advance > 0);
});

test("font: typewriter faces are monospaced", () => {
  const mono = face("mono", "regular", "upright");
  const advances = new Set(mono.shape("Wil.", 10).glyphs.map((glyph) => round(glyph.advance)));
  assert.equal(advances.size, 1, `expected one advance, got ${[...advances].join(", ")}`);
});

/** Golden-dump precision: differences below this are below anything visible. */
function round(value: number): number {
  return Number(value.toFixed(3));
}
