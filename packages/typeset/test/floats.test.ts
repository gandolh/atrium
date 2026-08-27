import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompileResult, Diagnostic, GlyphRun, Page, PlacedItem } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";
import { dumpResult, goldenTest, loadFixture } from "./harness.ts";

/**
 * Brief 39, chunk 39.4: the float deferral queue and placement.
 *
 * Chunk 39.1 parsed `figure`/`table`, numbered their captions and collected
 * `\listoffigures`; this chunk is what finally *puts them somewhere*. So unlike
 * `figures-tables-bib.test.ts`, which asserts on the document model, everything
 * here asserts on **geometry** — which page a float landed on and where on that
 * page — because that is the only statement about a float that can be wrong.
 *
 * The page is US Letter with one-inch margins (`design.ts`): the text body runs
 * from y=72 to y=720, x=72 to x=540. Every assertion below is written against
 * those numbers rather than against absolute coordinates copied out of a run,
 * so that a change to the page design breaks the *golden* — where a human can
 * read the movement — and not thirty unit tests.
 *
 * The one thing worth stating twice: **nothing may be dropped**. Several tests
 * below check not that a float landed in a particular place but that it landed
 * *at all*, and the never-placeable case checks that the engine says so at the
 * float's own line. That is D38's failure contract, and brief 39 names floats
 * as the place it matters most.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();

/** The text body's edges, from `defaultDesign()`. */
const BODY_TOP = 72;
const BODY_BOTTOM = 720;
const BODY_LEFT = 72;
const BODY_RIGHT = 540;

const IMAGE_DIR = join(import.meta.dirname, "fixtures", "images");

function doc(body: string): string {
  return `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

function compileSource(body: string, files: Record<string, Uint8Array> = {}): CompileResult {
  return compile({ "main.tex": encoder.encode(doc(body)), ...files }, "main.tex", { fonts });
}

/** The result, with a guarantee that nothing went wrong while producing it. */
function clean(body: string, files: Record<string, Uint8Array> = {}): CompileResult {
  const result = compileSource(body, files);
  assert.deepEqual(
    result.diagnostics.map((d) => `${d.severity} ${d.code ?? "-"}: ${d.message}`),
    [],
    "unexpected diagnostics",
  );
  return result;
}

function glyphRuns(page: Page): GlyphRun[] {
  return page.items.filter((item): item is GlyphRun => item.kind === "glyphrun");
}

/** Every place a word was set, in reading order: which page, and where on it. */
interface Sighting {
  page: number;
  x: number;
  y: number;
}

function sightings(result: CompileResult, word: string): Sighting[] {
  const found: Sighting[] = [];
  for (const page of result.pages) {
    for (const run of glyphRuns(page)) {
      if (run.text === word) found.push({ page: page.number, x: run.x, y: run.y });
    }
  }
  return found;
}

/** The one place a word was set. Set exactly once is itself the assertion. */
function only(result: CompileResult, word: string): Sighting {
  const found = sightings(result, word);
  assert.equal(found.length, 1, `"${word}" was set ${found.length} times, expected once`);
  return found[0] as Sighting;
}

/**
 * A float whose material is `lines` paragraphs of one line each, so its height
 * is predictable without pinning a font metric: roughly `lines * 12pt`.
 */
function bulk(lines: number, tag: string): string {
  return Array.from({ length: lines }, (_, i) => `${tag}${i} some words of filler on one single line.`).join(
    "\n\n",
  );
}

function float(kind: "figure" | "table", placement: string, caption: string, lines = 1): string {
  const option = placement === "" ? "" : `[${placement}]`;
  return `\\begin{${kind}}${option}\n${bulk(lines, caption)}\n\\caption{${caption}}\n\\end{${kind}}`;
}

function image(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(IMAGE_DIR, name)));
}

// --- the four placements ----------------------------------------------------

test("[t] puts the float at the top of the text body, above the prose around it", () => {
  const result = clean(`Opening line of prose.\n\n${float("figure", "t", "Alpha")}\n\nClosing line of prose.`);
  assert.equal(result.pages.length, 1);
  const caption = only(result, "Alpha");
  const opening = only(result, "Opening");
  // The float's own material starts at the very top of the body — `\topskip`
  // belongs to the float, not to the first line of text under it.
  assert.equal(only(result, "Alpha0").y - BODY_TOP < 12, true);
  // …and both the prose that came before it and the prose that came after are
  // below the caption, because the float was lifted over them.
  assert.ok(caption.y < opening.y, "the top float is above the prose written before it");
  assert.ok(caption.y < only(result, "Closing").y);
});

test("[b] puts the float at the foot of the text body, below the prose", () => {
  const result = clean(`Opening line of prose.\n\n${float("figure", "b", "Beta")}\n\nClosing line of prose.`);
  assert.equal(result.pages.length, 1);
  const caption = only(result, "Beta");
  assert.ok(caption.y > only(result, "Closing").y, "the bottom float is below the prose");
  // Bottom-anchored: the caption is the last thing in the float, so it sits
  // just above the foot of the text body rather than just under the prose.
  assert.ok(BODY_BOTTOM - caption.y < 12, `caption at ${caption.y}, body foot at ${BODY_BOTTOM}`);
});

test("[h] leaves the float in the flow, between the prose either side of it", () => {
  const result = clean(`Opening line of prose.\n\n${float("figure", "h", "Gamma")}\n\nClosing line of prose.`);
  assert.equal(result.pages.length, 1);
  const caption = only(result, "Gamma");
  assert.ok(only(result, "Opening").y < caption.y, "the here float is below the prose written before it");
  assert.ok(caption.y < only(result, "Closing").y, "…and above the prose written after it");
});

test("[p] gives the float a page of its own, and that page carries no prose", () => {
  const result = clean(`Opening line of prose.\n\n${float("figure", "p", "Delta")}\n\nClosing line of prose.`);
  assert.equal(result.pages.length, 2);
  const caption = only(result, "Delta");
  assert.equal(caption.page, 2, "the float page follows the text page");
  assert.equal(only(result, "Opening").page, 1);
  assert.equal(only(result, "Closing").page, 1);
  // Nothing but the float and the folio: a float page is not a text page with
  // a picture on it, it is a page LaTeX gave up the text on.
  const words = glyphRuns(result.pages[1] as Page).map((run) => run.text);
  assert.deepEqual(words.filter((w) => /Opening|Closing/.test(w)), []);
  // `\@fptop`/`\@fpbot` are equal infinite stretch, so the block is centred.
  const first = only(result, "Delta0");
  assert.ok(first.y > BODY_TOP + 100, `float page material starts at ${first.y}, not centred`);
});

// --- the preference order ---------------------------------------------------

test("positions are tried in LaTeX's h-t-b-p order, not the order the letters were written", () => {
  // `[bh]` reads bottom-then-here, but `\@addtocurcol` tests `h` first, so a
  // float that fits where it stands stays where it stands.
  const result = clean(`Opening line of prose.\n\n${float("figure", "bh", "Order")}\n\nClosing line of prose.`);
  const caption = only(result, "Order");
  assert.ok(only(result, "Opening").y < caption.y, "the float did not stay in the flow");
  assert.ok(caption.y < only(result, "Closing").y);
  assert.ok(BODY_BOTTOM - caption.y > 100, "the float was placed at the bottom, so `b` beat `h`");
});

test("a float with no [...] takes the class default, tbp — so it goes to the top", () => {
  const result = clean(`Opening line of prose.\n\n${float("figure", "", "Default")}\n\nClosing line.`);
  assert.ok(only(result, "Default").y < only(result, "Opening").y, "the default did not prefer `t`");
});

test("[!] suspends \\topfraction but not the paper: an oversized top float is still accepted", () => {
  // 40 lines is roughly 480pt, past `\topfraction`'s 0.7 of the 648pt body but
  // inside the page. Without `!` it is deferred; with `!` it goes on top.
  const plain = clean(`Opening.\n\n${float("figure", "t", "Plain", 40)}\n\n${bulk(6, "Body")}`);
  const bang = clean(`Opening.\n\n${float("figure", "!t", "Bang", 40)}\n\n${bulk(6, "Body")}`);
  assert.ok(only(plain, "Plain").page > 1, "the plain float should have been held back by \\topfraction");
  assert.equal(only(bang, "Bang").page, 1, "[!t] should have overridden \\topfraction");
});

// --- deferral ---------------------------------------------------------------

test("a float that does not fit defers to the next page rather than overflowing", () => {
  const result = clean(`${bulk(40, "Body")}\n\n${float("figure", "t", "Late", 30)}\n\n${bulk(10, "Tail")}`);
  const caption = only(result, "Late");
  assert.ok(caption.page > 1, "the float was not deferred");
  // Deferred, not overflowed: every one of its lines is inside the text body.
  for (const line of Array.from({ length: 30 }, (_, i) => only(result, `Late${i}`))) {
    assert.equal(line.page, caption.page, "the float was split across pages");
    assert.ok(line.y >= BODY_TOP && line.y <= BODY_BOTTOM, `float line at y=${line.y} is off the text body`);
  }
});

test("same-class floats never reorder: Figure 2 cannot be placed before Figure 1", () => {
  // Two floats too tall to share a page, so the second must wait for the page
  // after the first — which is exactly the case a queue that skipped over a
  // stuck float would get wrong.
  const body = [
    "Opening.",
    float("figure", "t", "First", 30),
    float("figure", "t", "Second", 30),
    bulk(40, "Body"),
  ].join("\n\n");
  const result = clean(body);
  const first = only(result, "First");
  const second = only(result, "Second");
  assert.ok(first.page < second.page, `Figure 1 on page ${first.page}, Figure 2 on page ${second.page}`);
  // And the numbers a reader sees still ascend down the document.
  assert.equal(numberBesideCaption(result, "First"), "1:");
  assert.equal(numberBesideCaption(result, "Second"), "2:");
});

test("a float never jumps the queue past one that is stuck behind a page break", () => {
  // The first float is `[b]`-only and enormous, so it can never share a text
  // page; the second is small and would fit at the top of any page. It must
  // still wait, because floats leave the queue in document order.
  const body = [
    "Opening.",
    float("figure", "b", "Stuck", 30),
    float("figure", "t", "Nimble", 1),
    bulk(20, "Body"),
  ].join("\n\n");
  const result = clean(body);
  assert.ok(
    only(result, "Stuck").page <= only(result, "Nimble").page,
    "the small float overtook the one in front of it",
  );
});

// --- nothing is ever dropped ------------------------------------------------

test("a float that can never be placed is a diagnostic naming it, not a silent drop", () => {
  // `[h]` and nothing else, on a float taller than a whole page: there is no
  // page on which "here" can ever have room, and the author forbade every
  // other position.
  const result = compileSource(`Opening.\n\n\\begin{figure}[h]\n${bulk(70, "Never")}\n\\caption{Never}\n\\end{figure}`);
  const hit = result.diagnostics.find((d) => d.construct === "figure");
  assert.ok(hit !== undefined, `no diagnostic at all: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.code, "unsupported");
  assert.equal(hit.severity, "error");
  assert.equal(hit.file, "main.tex");
  // The float's *own* line, which is the only line an author can act on.
  assert.equal(hit.line, 5, JSON.stringify(hit));
  assert.match(hit.message, /\[h\] and nothing else/);
  // An error, so the document does not quietly produce a PDF that is missing
  // a figure (D38: errors gate the PDF).
  assert.equal(result.pdf, null);
});

test("a float taller than the whole page is placed on a page of its own and warned about", () => {
  const result = compileSource(`Opening.\n\n${float("figure", "tp", "Giant", 70)}`);
  const hit = result.diagnostics.find((d) => d.code === "overfull-box" && d.construct === "figure");
  assert.ok(hit !== undefined, `no overfull warning: ${JSON.stringify(result.diagnostics)}`);
  // A warning, not an error: a page that renders badly is still a page, and
  // refusing the whole document over one huge figure helps nobody.
  assert.equal(hit.severity, "warning");
  assert.equal(hit.line, 5);
  assert.match(hit.message, /taller than the/);
  // And it is genuinely in the output — the point of not dropping it.
  assert.equal(sightings(result, "Giant").length, 1);
});

test("every float in a document full of them reaches the output exactly once", () => {
  const tags = ["Aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg", "Hh"];
  const body = tags
    .map((tag, i) => `${bulk(6, `T${i}`)}\n\n${float(i % 2 === 0 ? "figure" : "table", "htbp", tag, 8)}`)
    .join("\n\n");
  const result = clean(body);
  for (const tag of tags) only(result, tag);
});

// --- captions ---------------------------------------------------------------

/** The `Figure 3:` number set immediately before a caption's text. */
function numberBesideCaption(result: CompileResult, caption: string): string {
  const at = only(result, caption);
  const page = result.pages.find((p) => p.number === at.page) as Page;
  const runs = glyphRuns(page).filter((run) => run.y === at.y && run.x < at.x);
  const last = runs[runs.length - 1];
  return last === undefined ? "" : last.text;
}

test("a caption is numbered per class, set inside the float, and centred when it fits on one line", () => {
  const result = clean(
    [float("figure", "h", "Fig"), float("table", "h", "Tab"), float("figure", "h", "Fig2")].join("\n\n"),
  );
  assert.equal(numberBesideCaption(result, "Fig"), "1:");
  assert.equal(numberBesideCaption(result, "Tab"), "1:");
  assert.equal(numberBesideCaption(result, "Fig2"), "2:");
  // `\@makecaption` centres a one-line caption in `\hsize`. The word `Figure`
  // starts the line, so it sits right of the left margin by half the slack.
  const label = sightings(result, "Figure")[0] as Sighting;
  assert.ok(label.x > BODY_LEFT + 50, `caption starts at x=${label.x}, not centred`);
});

test("a caption too long for one line is set as a justified paragraph, flush to both margins", () => {
  const long =
    "A caption long enough to need two whole lines of setting, which is what makes it the other branch of " +
    "the caption macro and therefore worth a test of its own right here in this file";
  const result = clean(`\\begin{figure}[h]\nx\n\\caption{${long}}\n\\end{figure}`);
  const label = sightings(result, "Figure")[0] as Sighting;
  assert.equal(label.x, BODY_LEFT, "a paragraph caption starts flush left");
  // Two lines: the label is on the first, and something else is below it.
  const page = result.pages[0] as Page;
  const below = glyphRuns(page).filter((run) => run.y > label.y && run.y < BODY_BOTTOM - 50);
  assert.ok(below.length > 0, "the long caption did not wrap");
});

test("\\ref names the caption's number and \\pageref the page the float actually landed on", () => {
  // The float is deferred to a later page than the `\pageref` that names it,
  // which is the whole reason the marker has to ride inside the float's
  // material rather than sit where the source wrote it.
  const body = [
    "See Figure~\\ref{fig:x} on page~\\pageref{fig:x}.",
    bulk(40, "Body"),
    `\\begin{figure}[t]\n${bulk(30, "Xx")}\n\\caption{Xx}\\label{fig:x}\n\\end{figure}`,
    bulk(10, "Tail"),
  ].join("\n\n");
  const result = clean(body);
  const landed = only(result, "Xx").page;
  assert.ok(landed > 1, "the fixture no longer defers the float, so it proves nothing");
  const page = result.pages[0] as Page;
  const text = glyphRuns(page)
    .map((run) => run.text)
    .join(" ");
  assert.match(text, /See Figure 1 on page /);
  assert.match(text, new RegExp(`page ${landed}\\.`), `\\pageref did not name page ${landed}: ${text}`);
});

test("\\listoffigures prints the page the float landed on, never `??`", () => {
  const result = clean(
    `\\listoffigures\n\n${bulk(40, "Body")}\n\n${float("figure", "t", "Listed", 20)}\n\n${bulk(10, "Tail")}`,
  );
  // "Listed" is set twice on purpose — once as the caption, once as the list
  // entry that quotes it — so the float's own body tag is what locates it.
  const landed = only(result, "Listed0").page;
  const first = result.pages[0] as Page;
  const text = glyphRuns(first)
    .map((run) => run.text)
    .join(" ");
  assert.match(text, /List of Figures/);
  assert.doesNotMatch(text, /\?\?/, "the list of figures still prints an unresolved page number");
  assert.ok(text.includes(String(landed)), `the entry does not name page ${landed}: ${text}`);
});

test("two captions in one float are numbered independently and both are set", () => {
  const result = clean("\\begin{figure}[h]\nx\n\\caption{Early}\n\\caption{Later}\n\\end{figure}");
  assert.equal(numberBesideCaption(result, "Early"), "1:");
  assert.equal(numberBesideCaption(result, "Later"), "2:");
});

// --- what a float can contain -----------------------------------------------

test("a figure holds a real image, placed inside the float and moving with it", () => {
  const result = clean(
    `${bulk(40, "Body")}\n\n\\begin{figure}[t]\n\\includegraphics[width=0.4\\textwidth]{plot.png}\n\\caption{Shot}\n\\end{figure}\n\n${bulk(10, "Tail")}`,
    { "plot.png": image("rgb8.png") },
  );
  const caption = only(result, "Shot");
  assert.ok(caption.page > 1, "the fixture no longer defers, so it proves nothing about moving");
  const page = result.pages.find((p) => p.number === caption.page) as Page;
  const pictures = page.items.filter((item: PlacedItem) => item.kind === "image");
  assert.equal(pictures.length, 1, "the image did not travel with the float it is inside");
  const picture = pictures[0] as Extract<PlacedItem, { kind: "image" }>;
  assert.equal(picture.path, "plot.png");
  // 0.4 of the 468pt measure, and above its own caption.
  assert.ok(Math.abs(picture.width - 0.4 * (BODY_RIGHT - BODY_LEFT)) < 0.01, `width ${picture.width}`);
  assert.ok(picture.y < caption.y, "the image is below the caption it belongs to");
  assert.ok(picture.y >= BODY_TOP, "the image is off the top of the text body");
});

test("a table inside a float is set at the float's own measure and travels with it", () => {
  const body = [
    bulk(40, "Body"),
    "\\begin{table}[t]",
    // Padding so the float is too tall for the page its marker sits on: the
    // grid then has to *travel*, which is the half of this that floats add.
    bulk(20, "Pad"),
    "\\begin{tabular}{|l|r|}",
    "\\hline",
    "Name & Value \\\\",
    "\\hline",
    "alpha & 1 \\\\",
    "\\hline",
    "\\end{tabular}",
    "\\caption{Grid}",
    "\\end{table}",
    bulk(10, "Tail"),
  ].join("\n");
  const result = clean(body);
  const caption = only(result, "Grid");
  assert.ok(caption.page > 1, "the fixture no longer defers, so it proves nothing about moving");
  const page = result.pages.find((p) => p.number === caption.page) as Page;
  // Five `\hline`/`|` rules at least, all on the float's page and above the
  // caption — the grid went where the float went.
  const rules = page.items.filter((item: PlacedItem) => item.kind === "rule");
  assert.ok(rules.length >= 5, `only ${rules.length} rules on the float's page`);
  for (const rule of rules) {
    assert.ok(rule.y < caption.y, "a table rule was left behind on another part of the page");
    assert.ok(rule.x >= BODY_LEFT && rule.x + rule.width <= BODY_RIGHT + 0.01, "the table is off the measure");
  }
});

// --- determinism ------------------------------------------------------------

test("a document full of floats lays out identically on repeated compiles", () => {
  const body = [
    bulk(20, "Body"),
    float("figure", "t", "Det1", 20),
    float("table", "b", "Det2", 10),
    bulk(20, "More"),
    float("figure", "p", "Det3", 30),
    bulk(20, "Rest"),
    float("table", "h", "Det4", 3),
  ].join("\n\n");
  const first = dumpResult(compileSource(body), "main.tex");
  const second = dumpResult(compileSource(body), "main.tex");
  assert.equal(first, second);
  // A second, independently created font provider must not move a thing
  // either: nothing about float placement may depend on shaper cache state.
  const other = compile({ "main.tex": encoder.encode(doc(body)) }, "main.tex", {
    fonts: createLatinModernProvider(loadLatinModernBytes()),
  });
  assert.equal(dumpResult(other, "main.tex"), first);
});

// --- the golden -------------------------------------------------------------

/**
 * A paper-shaped page: a list of figures, prose that cross-references both
 * floats, a `[t]` figure holding a real PNG, and a `[h]` table holding a real
 * `tabular`. Read the dump, not just the diff — it is the only artefact that
 * says the numbers were right in the first place.
 */
goldenTest("floats", compile, { compileOptions: { fonts } });

test("the floats golden compiles cleanly and resolves both of its references", () => {
  const fixture = loadFixture("floats");
  const result = compile(fixture.files, fixture.entrypoint, { fonts });
  assert.deepEqual(
    result.diagnostics.map((d: Diagnostic) => `${d.severity} ${d.code ?? "-"}: ${d.message}`),
    [],
  );
  const text = result.pages.flatMap((page) => glyphRuns(page).map((run) => run.text)).join(" ");
  assert.doesNotMatch(text, /\?\?/, "an unresolved reference survived into the output");
  assert.ok(result.pdf !== null, "a clean float document must still produce a PDF");
});
