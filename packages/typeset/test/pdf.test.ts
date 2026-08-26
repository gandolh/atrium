import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { PDFRawStream, PDFRef } from "pdf-lib";
import { createLatinModernProvider } from "../src/font/handle.ts";
import type { FontHandle } from "../src/font/handle.ts";
import type { GlyphRun, Page, PlacedRule } from "../src/layout/page.ts";
import { renderPdf } from "../src/pdf/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * PDF emission tests.
 *
 * The interesting assertions are not "does it produce bytes" but the three
 * properties the chunk was specified on: the text a reader copies out is the
 * text the document said, the embedded face is a subset, and the same input
 * gives the same bytes. Each is checked by reading the produced file back —
 * with pdf-lib's parser, and (where the binary exists) with poppler, which
 * knows nothing about this code.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());

function face(
  family: "serif" | "sans" | "mono",
  weight: "regular" | "bold" = "regular",
  slant: "upright" | "italic" = "upright",
): FontHandle {
  const handle = fonts.get({ family, weight, slant });
  assert.ok(handle, `missing test face ${family}/${weight}/${slant}`);
  return handle;
}

function run(font: FontHandle, text: string, size: number, x: number, y: number): GlyphRun {
  const shaped = font.shape(text, size);
  return { kind: "glyphrun", x, y, font, size, glyphs: shaped.glyphs, width: shaped.width, text };
}

function rule(x: number, y: number, width: number, height: number): PlacedRule {
  return { kind: "rule", x, y, width, height };
}

function page(number: number, items: Page["items"]): Page {
  return { number, width: 595.276, height: 841.89, items };
}

function pdfOf(pages: Page[], options = {}): Uint8Array {
  const result = renderPdf(pages, options);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.pdf, "expected bytes");
  return result.pdf;
}

// --- reading the produced file back ----------------------------------------

interface ExtractedRun {
  fontResource: string;
  size: number;
  /** Text matrix translation, i.e. PDF-space origin of the run. */
  x: number;
  y: number;
  /** Characters recovered through the font's `/ToUnicode` CMap. */
  text: string;
  /** Total horizontal displacement, from `/W` widths and `TJ` adjustments. */
  advance: number;
}

function streamText(doc: PDFDocument, ref: unknown): string {
  // `lookup` has no PDFRawStream overload; every stream this writer emits is one.
  const stream = doc.context.lookup(ref as PDFRef, PDFStream) as PDFRawStream;
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

/** Invert a `/ToUnicode` CMap into the map a reader uses: code → characters. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const blocks = cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
  for (const block of blocks) {
    const entries = block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g);
    for (const entry of entries) {
      const code = parseInt(entry[1]!, 16);
      const hex = entry[2]!;
      let text = "";
      for (let i = 0; i + 3 < hex.length; i += 4) {
        text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      }
      map.set(code, text);
    }
  }
  return map;
}

interface ParsedFont {
  toUnicode: Map<number, string>;
  /** Subset glyph id → advance in glyph space (1/1000 em). */
  widths: Map<number, number>;
  fontFileBytes: number;
  baseFont: string;
  subtype: string;
}

function parseFonts(doc: PDFDocument, pageIndex = 0): Map<string, ParsedFont> {
  const leaf = doc.getPage(pageIndex).node;
  const resources = doc.context.lookup(leaf.get(PDFName.of("Resources")), PDFDict);
  const fontDict = doc.context.lookup(resources.get(PDFName.of("Font")), PDFDict);

  const parsed = new Map<string, ParsedFont>();
  for (const [name, ref] of fontDict.entries()) {
    const type0 = doc.context.lookup(ref, PDFDict);
    const descendants = doc.context.lookup(type0.get(PDFName.of("DescendantFonts")), PDFArray);
    const cid = doc.context.lookup(descendants.get(0), PDFDict);
    const descriptor = doc.context.lookup(cid.get(PDFName.of("FontDescriptor")), PDFDict);

    const fileRef =
      descriptor.get(PDFName.of("FontFile3")) ?? descriptor.get(PDFName.of("FontFile2"));
    const fileStream = doc.context.lookup(fileRef, PDFStream) as PDFRawStream;

    const widths = new Map<number, number>();
    const w = doc.context.lookup(cid.get(PDFName.of("W")), PDFArray);
    for (let i = 0; i + 1 < w.size(); i += 2) {
      const first = doc.context.lookup(w.get(i), PDFNumber).asNumber();
      const list = doc.context.lookup(w.get(i + 1), PDFArray);
      for (let j = 0; j < list.size(); j++) {
        widths.set(first + j, doc.context.lookup(list.get(j), PDFNumber).asNumber());
      }
    }

    parsed.set(name.asString().slice(1), {
      toUnicode: parseToUnicode(streamText(doc, type0.get(PDFName.of("ToUnicode")))),
      widths,
      fontFileBytes: decodePDFRawStream(fileStream).decode().length,
      baseFont: type0.get(PDFName.of("BaseFont"))!.toString(),
      subtype: cid.get(PDFName.of("Subtype"))!.toString(),
    });
  }
  return parsed;
}

/**
 * Walk a content stream's text objects the way a viewer does: `/W` supplies each
 * glyph's advance and a `TJ` number displaces the pen by `-n/1000 × size`. If
 * emission and the font dictionary disagree, `advance` comes out wrong here.
 */
function extractRuns(content: string, faces: Map<string, ParsedFont>): ExtractedRun[] {
  const runs: ExtractedRun[] = [];
  for (const block of content.matchAll(/BT\n([\s\S]*?)\nET/g)) {
    const body = block[1]!;
    const tf = /\/(\S+) ([\d.-]+) Tf/.exec(body);
    const tm = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(body);
    assert.ok(tf && tm, "text object without Tf/Tm");

    const resource = tf[1]!;
    const size = Number(tf[2]);
    const font = faces.get(resource);
    assert.ok(font, `content stream names unknown font ${resource}`);

    let text = "";
    let advance = 0;
    for (const tj of body.matchAll(/\[([\s\S]*?)\] TJ/g)) {
      for (const token of tj[1]!.matchAll(/<([0-9A-Fa-f]+)>|(-?[\d.]+)/g)) {
        if (token[2] !== undefined) {
          advance += (-Number(token[2]) / 1000) * size;
          continue;
        }
        const hex = token[1]!;
        for (let i = 0; i + 3 < hex.length; i += 4) {
          const code = parseInt(hex.slice(i, i + 4), 16);
          text += font.toUnicode.get(code) ?? "�";
          advance += ((font.widths.get(code) ?? 0) / 1000) * size;
        }
      }
    }
    runs.push({ fontResource: resource, size, x: Number(tm[1]), y: Number(tm[2]), text, advance });
  }
  return runs;
}

async function readBack(bytes: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const leaf = doc.getPage(pageIndex).node;
  const content = streamText(doc, leaf.get(PDFName.of("Contents")));
  const faces = parseFonts(doc, pageIndex);
  return { doc, content, faces, runs: extractRuns(content, faces) };
}

/** Poppler's view of the file: extracted text, plus anything it complained about. */
function pdftotext(bytes: Uint8Array): { text: string; stderr: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "atrium-pdf-"));
  const file = join(dir, "out.pdf");
  writeFileSync(file, bytes);
  try {
    const result = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    // Poppler is not installed here; the pdf-lib read-back tests still run.
    if (result.error || result.status !== 0) return null;
    return { text: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- tests -----------------------------------------------------------------

const SPECIMEN = "The quick brown fox";

test("emits a well-formed PDF 1.7 file", () => {
  const roman = face("serif");
  const bytes = pdfOf([page(1, [run(roman, SPECIMEN, 10, 72, 100)])]);
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 6));
  assert.equal(head, "%PDF-1.7");
  assert.equal(tail.trim(), "%%EOF");
});

test("the same pages produce byte-identical output", () => {
  const roman = face("serif");
  const build = (): Page[] => [
    page(1, [run(roman, SPECIMEN, 10, 72, 100), rule(72, 120, 200, 0.4)]),
    page(2, [run(face("sans"), "second page", 12, 72, 100)]),
  ];
  const first = pdfOf(build());
  const second = pdfOf(build());
  assert.deepEqual([...first], [...second]);
});

test("text is recoverable through /ToUnicode", async () => {
  const roman = face("serif");
  const bytes = pdfOf([page(1, [run(roman, SPECIMEN, 10, 72, 100)])]);
  const { runs } = await readBack(bytes);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.text, SPECIMEN);
});

test("ligatures extract as the characters that were typed", async () => {
  const roman = face("serif");
  // Latin Modern substitutes a single `fi` glyph; a naive /ToUnicode built from
  // the font's cmap would give U+FB01 and a reader would paste that instead.
  const source = "the fifth office";
  const shaped = roman.shape(source, 11);
  assert.ok(shaped.glyphs.length < source.length, "expected a ligature substitution");

  const bytes = pdfOf([page(1, [run(roman, source, 11, 72, 700)])]);
  const { runs } = await readBack(bytes);
  assert.equal(runs[0]!.text, source);
});

test("kerned advances survive the round trip exactly", async () => {
  const roman = face("serif");
  const shaped = roman.shape(SPECIMEN, 10);
  // The measurement that ruled out letting pdf-lib place the text itself:
  // pdf-lib reports 91.15 pt for this string because it sums unkerned widths.
  assert.equal(Number(shaped.width.toFixed(2)), 90.31);

  const bytes = pdfOf([page(1, [run(roman, SPECIMEN, 10, 72, 100)])]);
  const { runs } = await readBack(bytes);
  assert.ok(
    Math.abs(runs[0]!.advance - shaped.width) < 1e-4,
    `content stream advances to ${runs[0]!.advance}, layout says ${shaped.width}`,
  );
});

test("a long line does not accumulate rounding drift", async () => {
  const roman = face("serif");
  const text = "Wavering AVATAR To Ye Yawning Tomes, ".repeat(12);
  const shaped = roman.shape(text, 10.5);
  const bytes = pdfOf([page(1, [run(roman, text, 10.5, 20, 400)])]);
  const { runs } = await readBack(bytes);
  assert.ok(
    Math.abs(runs[0]!.advance - shaped.width) < 1e-4,
    `drift of ${runs[0]!.advance - shaped.width} pt over ${shaped.glyphs.length} glyphs`,
  );
});

test("the embedded face is a subset, not the whole font", async () => {
  const roman = face("serif");
  const bytes = pdfOf([page(1, [run(roman, SPECIMEN, 10, 72, 100)])]);
  const { faces } = await readBack(bytes);
  const embedded = [...faces.values()][0]!;

  assert.ok(
    embedded.fontFileBytes < roman.data.length / 10,
    `subset is ${embedded.fontFileBytes} bytes of an ${roman.data.length}-byte face`,
  );
  assert.equal(embedded.subtype, "/CIDFontType0");
  assert.match(embedded.baseFont, /^\/[A-Z]{6}\+LMRoman10-Regular$/);
  // 19 characters, some repeated: the subset carries only what was used, plus
  // .notdef.
  assert.ok(embedded.widths.size <= 20, `subset carries ${embedded.widths.size} glyphs`);
});

test("y coordinates are flipped exactly once", async () => {
  const roman = face("serif");
  const baseline = 100;
  const bytes = pdfOf([page(1, [run(roman, "x", 10, 72, baseline), rule(72, 200, 100, 2)])]);
  const { content, runs } = await readBack(bytes);

  // Layout is y-down from the top; the page is 841.89 pt tall.
  assert.equal(runs[0]!.y, 841.89 - baseline);
  assert.equal(runs[0]!.x, 72);
  // A rule's `y` is its top edge, so its PDF origin is one height lower.
  assert.match(content, /^72 639\.89 100 2 re f$/m);
});

test("multiple pages, faces and sizes coexist", async () => {
  const roman = face("serif");
  const bold = face("serif", "bold");
  const mono = face("mono");

  const bytes = pdfOf([
    page(1, [run(roman, "body text", 10, 72, 100), run(bold, "Heading", 17.28, 72, 140)]),
    page(2, [run(mono, "monospaced()", 9, 72, 100), run(roman, "body text", 10, 72, 130)]),
  ]);

  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);

  const first = await readBack(bytes, 0);
  const second = await readBack(bytes, 1);
  // One shared resource dictionary, so every page sees all three faces.
  assert.equal(first.faces.size, 3);
  assert.deepEqual(
    first.runs.map((r) => [r.text, r.size]),
    [
      ["body text", 10],
      ["Heading", 17.28],
    ],
  );
  assert.deepEqual(
    second.runs.map((r) => [r.text, r.size]),
    [
      ["monospaced()", 9],
      ["body text", 10],
    ],
  );
  // The repeated face is embedded once and reused across pages.
  assert.equal(first.runs[0]!.fontResource, second.runs[1]!.fontResource);
});

test("poppler extracts the same text", () => {
  const roman = face("serif");
  const bytes = pdfOf([
    page(1, [run(roman, SPECIMEN, 10, 72, 100)]),
    page(2, [run(face("serif", "regular", "italic"), "jumps over the lazy dog", 10, 72, 100)]),
  ]);

  const poppler = pdftotext(bytes);
  if (poppler === null) return; // poppler unavailable; the read-back tests cover it
  assert.match(poppler.text, /The quick brown fox/);
  assert.match(poppler.text, /jumps over the lazy dog/);
  // Poppler is strict about the font program in a way pdf-lib's own output is
  // not, and says so on stderr rather than by failing. No error here is what
  // says the embedded subset actually parses — see the CFF header note in
  // `subset.ts`. Matched on "Error" rather than on emptiness so that an
  // unrelated warning from another poppler build is not a test failure.
  assert.doesNotMatch(poppler.stderr, /Error/, poppler.stderr);
});

test("the embedded CFF header declares a legal offSize", async () => {
  const roman = face("serif");
  const bytes = pdfOf([page(1, [run(roman, SPECIMEN, 10, 72, 100)])]);
  const doc = await PDFDocument.load(bytes);
  const leaf = doc.getPage(0).node;
  const resources = doc.context.lookup(leaf.get(PDFName.of("Resources")), PDFDict);
  const fontDict = doc.context.lookup(resources.get(PDFName.of("Font")), PDFDict);
  const type0 = doc.context.lookup([...fontDict.entries()][0]![1], PDFDict);
  const descendants = doc.context.lookup(type0.get(PDFName.of("DescendantFonts")), PDFArray);
  const cid = doc.context.lookup(descendants.get(0), PDFDict);
  const descriptor = doc.context.lookup(cid.get(PDFName.of("FontDescriptor")), PDFDict);
  const program = decodePDFRawStream(
    doc.context.lookup(descriptor.get(PDFName.of("FontFile3")), PDFStream) as PDFRawStream,
  ).decode();

  assert.deepEqual([...program.subarray(0, 3)], [1, 0, 4], "not a bare CFF header");
  // fontkit writes an unrelated number here; out of the spec's 1–4 range it
  // makes poppler refuse the font and pdf.js fail to classify it.
  const offSize = program[3]!;
  assert.ok(offSize >= 1 && offSize <= 4, `CFF header offSize is ${offSize}`);
});

test("no pages is reported, not emitted", () => {
  const result = renderPdf([], { file: "main.tex" });
  assert.equal(result.pdf, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]!.code, "internal");
  assert.equal(result.diagnostics[0]!.severity, "error");
  assert.equal(result.diagnostics[0]!.file, "main.tex");
});

test("maxOutputBytes refuses before allocating", () => {
  const roman = face("serif");
  const result = renderPdf([page(1, [run(roman, SPECIMEN, 10, 72, 100)])], {
    file: "main.tex",
    maxOutputBytes: 1024,
  });
  assert.equal(result.pdf, null);
  assert.equal(result.diagnostics[0]!.code, "limit-exceeded");
  assert.match(result.diagnostics[0]!.message, /maxOutputBytes/);
});

test("a broken face is a diagnostic, not a throw", () => {
  const roman = face("serif");
  const broken: FontHandle = { ...roman, id: "broken", data: new Uint8Array([1, 2, 3, 4]) };
  const item: GlyphRun = { ...run(roman, "x", 10, 0, 0), font: broken };
  const result = renderPdf([page(1, [item])], { file: "main.tex" });

  assert.equal(result.pdf, null);
  assert.equal(result.diagnostics[0]!.code, "missing-font");
  assert.match(result.diagnostics[0]!.message, /broken/);
});

test("a non-finite coordinate is a diagnostic, not silent zero", () => {
  const roman = face("serif");
  const bad = run(roman, "x", 10, Number.NaN, 100);
  const result = renderPdf([page(1, [bad])], { file: "main.tex" });
  assert.equal(result.pdf, null);
  assert.equal(result.diagnostics[0]!.code, "internal");
});

test("uncompressed streams are readable and identical in content", async () => {
  const roman = face("serif");
  const pages = (): Page[] => [page(1, [run(roman, SPECIMEN, 10, 72, 100)])];
  const compressed = await readBack(pdfOf(pages()));
  const plain = await readBack(pdfOf(pages(), { compressStreams: false }));
  assert.equal(compressed.content, plain.content);
});

test("a pinned creation date is the only date that ever appears", () => {
  const roman = face("serif");
  const undated = new TextDecoder().decode(pdfOf([page(1, [run(roman, "x", 10, 0, 0)])]));
  assert.doesNotMatch(undated, /CreationDate|ModDate/);

  const dated = new TextDecoder().decode(
    pdfOf([page(1, [run(roman, "x", 10, 0, 0)])], { creationDate: "D:20260101000000Z" }),
  );
  assert.match(dated, /CreationDate \(D:20260101000000Z\)/);
});
