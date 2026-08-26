import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INF_BAD,
  badness,
  computeGlueSet,
  glue,
  hpack,
  kern,
  measure,
  setWidth,
} from "../src/layout/index.ts";
import type { HBox, HNode, RuleNode } from "../src/layout/index.ts";

/**
 * Glue setting: how leftover space is shared out along a packed box.
 *
 * These are the numbers PDF emission places glyphs from, so they are pinned
 * against TeX's own definitions rather than against whatever the code happens
 * to do today.
 */

/** A rigid box of a known width — a rule stands in for set text. */
function box(width: number, height = 0, depth = 0): RuleNode {
  return { kind: "rule", width, height, depth };
}

test("badness is 100*(t/s)^3, capped at TeX's inf_bad", () => {
  // tex.web §108. A ratio of 1 — glue stretched to exactly its stated
  // stretchability — is badness 100 by construction, and every other value on
  // this list follows from the cube.
  assert.equal(badness(0, 10), 0);
  assert.equal(badness(10, 10), 100);
  assert.equal(badness(5, 10), 13); // 100 * 0.125 = 12.5, rounded
  assert.equal(badness(20, 10), 800);
  assert.equal(badness(30, 10), 2700);
  assert.equal(badness(46, 10), 9734); // 100 * 4.6^3, just under the cap
  assert.equal(badness(47, 10), INF_BAD); // 100 * 4.7^3 = 10382 -> capped
  // No stretch at all and something to make up is unsettable, not merely bad.
  assert.equal(badness(1, 0), INF_BAD);
  assert.equal(badness(0, 0), 0);
});

test("the fitness thresholds sit where TeX puts them", () => {
  // §817: decent is badness <= 12, loose is 13..99, very loose is >= 100. The
  // boundaries are what make `\adjdemerits` fire, so they are worth pinning.
  assert.ok(badness(4.9, 10) <= 12);
  assert.ok(badness(5, 10) > 12);
  assert.ok(badness(9.9, 10) <= 99);
  assert.ok(badness(10, 10) > 99);
});

test("finite glue shares the leftover in proportion to its stretch", () => {
  const content: HNode[] = [box(10), glue(0, 1), box(10), glue(0, 3), box(10)];
  const { box: packed } = hpack(content, 42);
  // 12pt spare across 4 units of stretch is a ratio of 3.
  assert.equal(packed.glueSet?.sign, 1);
  assert.equal(packed.glueSet?.order, 0);
  assert.equal(packed.glueSet?.ratio, 3);
  assert.equal(setWidth(content[1] as never, packed.glueSet), 3);
  assert.equal(setWidth(content[3] as never, packed.glueSet), 9);
});

test("fil glue absorbs everything and finite glue gets nothing", () => {
  // The rule that makes `\hfill` work at all: only the highest order present
  // participates, and the rest are frozen at their natural size.
  const finite = glue(5, 100);
  const fil = glue(0, 1, 0, 1);
  const { box: packed } = hpack([box(10), finite, box(10), fil], 100);

  assert.equal(packed.glueSet?.order, 1);
  assert.equal(packed.glueSet?.sign, 1);
  assert.equal(packed.glueSet?.ratio, 75);
  assert.equal(setWidth(finite, packed.glueSet), 5, "finite glue must not move");
  assert.equal(setWidth(fil, packed.glueSet), 75);
});

test("fill beats fil, which is what makes nested infinite glue work", () => {
  const fil = glue(0, 1, 0, 1);
  const fill = glue(0, 1, 0, 2);
  const { box: packed } = hpack([fil, box(20), fill], 100);
  assert.equal(packed.glueSet?.order, 2);
  assert.equal(setWidth(fil, packed.glueSet), 0);
  assert.equal(setWidth(fill, packed.glueSet), 80);
});

test("hfil on both sides centres", () => {
  const left = glue(0, 1, 0, 1);
  const right = glue(0, 1, 0, 1);
  const { box: packed } = hpack([left, box(20), right], 100);
  assert.equal(setWidth(left, packed.glueSet), 40);
  assert.equal(setWidth(right, packed.glueSet), 40);
});

test("shrinking is capped: past the available shrink the box is overfull", () => {
  const g = glue(10, 0, 4);
  const report = hpack([box(50), g, box(50)], 100);

  // 110 natural into 100, with only 4pt of shrink. TeX §664 sets the glue to
  // full shrink and lets the surplus stick out rather than compressing further.
  assert.equal(report.overfull, 6);
  assert.equal(report.box.glueSet?.sign, -1);
  assert.equal(report.box.glueSet?.ratio, 1);
  assert.equal(setWidth(g, report.box.glueSet), 6);
  assert.equal(report.badness, INF_BAD);
  // The box still claims the width it was asked for; the content overflows it.
  assert.equal(report.box.width, 100);
});

test("shrinking within the available shrink is not overfull", () => {
  const g = glue(10, 0, 12);
  const report = hpack([box(50), g, box(50)], 100);
  assert.equal(report.overfull, 0);
  assert.equal(report.box.glueSet?.sign, -1);
  assert.equal(report.box.glueSet?.ratio, 10 / 12);
  assert.equal(setWidth(g, report.box.glueSet), 0);
  assert.equal(report.badness, badness(10, 12));
});

test("nothing to stretch leaves the glue unset and the box underfull", () => {
  const report = hpack([box(50), glue(10), box(20)], 100);
  assert.equal(report.box.glueSet?.sign, 0);
  assert.equal(report.badness, INF_BAD);
  assert.equal(report.overfull, 0);
});

test("packing to the natural size sets no glue at all", () => {
  const report = hpack([box(10), glue(5, 3, 2), box(10)], "natural");
  assert.equal(report.box.width, 25);
  assert.equal(report.box.glueSet?.sign, 0);
  assert.equal(report.badness, 0);
});

test("height and depth are the maxima over the content, with shift applied", () => {
  const raised: HBox = { kind: "hbox", width: 0, height: 4, depth: 1, shift: -3, glueSet: null, content: [] };
  const report = hpack([box(10, 5, 2), raised], "natural");
  // The raised box's height counts as 4 - (-3) = 7; its depth as 1 + (-3) = -2,
  // which loses to the rule's 2.
  assert.equal(report.box.height, 7);
  assert.equal(report.box.depth, 2);
});

test("kerns are rigid and glue orders are measured separately", () => {
  const e = measure([box(10), kern(2), glue(5, 1, 1), glue(0, 3, 0, 2), glue(0, 0, 7, 0, 1)], "h");
  assert.equal(e.natural, 17);
  assert.deepEqual(e.stretch, [1, 0, 3, 0]);
  assert.deepEqual(e.shrink, [1, 7, 0, 0]);
});

test("computeGlueSet is exact when the content already fits", () => {
  const setting = computeGlueSet(measure([box(100)], "h"), 100);
  assert.deepEqual(setting.set, { ratio: 0, sign: 0, order: 0 });
  assert.equal(setting.badness, 0);
  assert.equal(setting.overfull, 0);
});
