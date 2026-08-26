import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LATIN_MODERN_FACE_IDS,
  createLatinModernProvider,
  latinModernFaceId,
} from "../src/index.ts";
import type { FontFamily, FontRequest, FontSlant, FontWeight } from "../src/index.ts";
import { latinModernFontDir, loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Tests for the face catalogue, the committed assets and the Node loader —
 * the parts that decide *which* font answers a request, as opposed to what it
 * then measures.
 */

const FAMILIES: readonly FontFamily[] = ["serif", "sans", "mono"];
const WEIGHTS: readonly FontWeight[] = ["regular", "bold"];
const SLANTS: readonly FontSlant[] = ["upright", "italic"];

function everyRequest(): FontRequest[] {
  const out: FontRequest[] = [];
  for (const family of FAMILIES) {
    for (const weight of WEIGHTS) {
      for (const slant of SLANTS) out.push({ family, weight, slant });
    }
  }
  return out;
}

test("latin modern: the request the acceptance criteria name resolves to roman", () => {
  const fonts = createLatinModernProvider(loadLatinModernBytes());
  const handle = fonts.get({ family: "serif", weight: "regular", slant: "upright" });
  assert.ok(handle);
  assert.equal(handle.id, "lmroman10-regular");
  assert.equal(handle.postscriptName, "LMRoman10-Regular");
});

test("latin modern: the whole request space is covered, each by its own face", () => {
  const fonts = createLatinModernProvider(loadLatinModernBytes());
  const seen = new Map<string, string>();

  for (const request of everyRequest()) {
    const key = `${request.family}/${request.weight}/${request.slant}`;
    const handle = fonts.get(request);
    assert.ok(handle, `no face for ${key}`);
    assert.equal(handle.id, latinModernFaceId(request));
    assert.ok(!seen.has(handle.id), `${handle.id} answers both ${seen.get(handle.id)} and ${key}`);
    seen.set(handle.id, key);
  }

  assert.equal(seen.size, LATIN_MODERN_FACE_IDS.length);
});

test("latin modern: ids are exactly the mapping chunks 4 and 5 were handed", () => {
  // These strings are printed verbatim into golden dumps. Changing one churns
  // every golden in the repo, so they are pinned here deliberately rather than
  // derived from the table they are meant to be guarding.
  const expected: Array<[FontFamily, FontWeight, FontSlant, string]> = [
    ["serif", "regular", "upright", "lmroman10-regular"],
    ["serif", "regular", "italic", "lmroman10-italic"],
    ["serif", "bold", "upright", "lmroman10-bold"],
    ["serif", "bold", "italic", "lmroman10-bolditalic"],
    ["sans", "regular", "upright", "lmsans10-regular"],
    ["sans", "regular", "italic", "lmsans10-oblique"],
    ["sans", "bold", "upright", "lmsans10-bold"],
    ["sans", "bold", "italic", "lmsans10-boldoblique"],
    ["mono", "regular", "upright", "lmmono10-regular"],
    ["mono", "regular", "italic", "lmmono10-italic"],
    ["mono", "bold", "upright", "lmmonolt10-bold"],
    ["mono", "bold", "italic", "lmmonolt10-boldoblique"],
  ];

  for (const [family, weight, slant, id] of expected) {
    assert.equal(latinModernFaceId({ family, weight, slant }), id);
  }
});

test("latin modern: an absent face is undefined, never a near-enough one", () => {
  // The caller owes a `missing-font` diagnostic. Substituting here would set a
  // page in the wrong typeface and tell nobody.
  const serifOnly = createLatinModernProvider({
    "lmroman10-regular": loadLatinModernBytes()["lmroman10-regular"]!,
  });

  assert.ok(serifOnly.get({ family: "serif", weight: "regular", slant: "upright" }));
  assert.equal(serifOnly.get({ family: "sans", weight: "regular", slant: "upright" }), undefined);
  assert.equal(serifOnly.get({ family: "mono", weight: "bold", slant: "italic" }), undefined);
  assert.equal(createLatinModernProvider({}).get({ family: "serif", weight: "regular", slant: "upright" }), undefined);
});

test("latin modern: handles are parsed once and reused", () => {
  const fonts = createLatinModernProvider(loadLatinModernBytes());
  const request: FontRequest = { family: "serif", weight: "bold", slant: "italic" };
  assert.equal(fonts.get(request), fonts.get({ ...request }));
});

test("latin modern: every named face is committed, and nothing else is", () => {
  const files = readdirSync(latinModernFontDir())
    .filter((name) => name.endsWith(".otf"))
    .map((name) => name.slice(0, -".otf".length))
    .sort();

  assert.deepEqual(files, [...LATIN_MODERN_FACE_IDS].sort());
});

test("latin modern: the loader keys bytes by face id and they parse", () => {
  const bytes = loadLatinModernBytes();
  for (const id of LATIN_MODERN_FACE_IDS) {
    const data = bytes[id];
    assert.ok(data instanceof Uint8Array, `${id} missing from the loader`);
    // OpenType with CFF outlines starts with the 'OTTO' tag. If this ever
    // fails, git has mangled a binary asset.
    assert.equal(String.fromCharCode(...data.subarray(0, 4)), "OTTO", `${id} is not an OTF`);
  }
});

test("latin modern: the licence ships with the fonts, as the licence requires", () => {
  const names = readdirSync(latinModernFontDir());
  assert.ok(names.includes("GUST-FONT-LICENSE.txt"));
  assert.ok(names.includes("README.md"));
});

test("latin modern: the loader finds its assets from wherever it runs", () => {
  // The module is executed both as TypeScript source under `node --test` and,
  // once built, from `dist/` — the directory search is what makes both work,
  // and this is the assertion that notices when the output layout moves.
  assert.equal(join(latinModernFontDir(), "lmroman10-regular.otf").endsWith("assets/fonts/lmroman10-regular.otf"), true);
});
