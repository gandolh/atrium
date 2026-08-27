import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  compile,
  createLatinModernProvider,
  decodeImage,
  defaultDesign,
  placeImage,
  placedImageSize,
  renderPdf,
  resolveImageFile,
} from "../src/index.ts";
import type {
  CompileResult,
  DecodedImage,
  Diagnostic,
  ImageContext,
  ImageInline,
  ImageSizing,
  Page,
  PlacedImage,
} from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Brief 39, chunk 39.2: `\includegraphics` puts a real PNG or JPEG into the PDF
 * at the right size, and every way that can go wrong is a diagnostic naming the
 * file rather than a crash.
 *
 * The tests are in the order the work was done, because that is also the order
 * of increasing blast radius:
 *
 * 1. **decode alone** — bytes to an intrinsic size. This is the piece most
 *    likely to be quietly wrong (a DPI read from the wrong chunk is a figure
 *    that is 4.17 times too big and *looks* deliberate), so it is tested
 *    against real files produced by ImageMagick rather than against fixtures
 *    this engine wrote itself.
 * 2. **the sizing keys** — `width`, `height`, `scale` and their precedence.
 * 3. **placement** through a whole `compile()`.
 * 4. **embedding** — the `XObject`s, and that the PDF a real reader gets is
 *    valid and byte-identical between two runs.
 *
 * There is no golden dump here on purpose: `test/harness.ts`'s dump format has
 * no line for a placed image (it belongs to brief 37 and predates this chunk),
 * and asserting on `Page.items` directly says more about a figure's geometry
 * than a transcript would.
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();
const IMAGE_DIR = join(import.meta.dirname, "fixtures", "images");

/** A fixture's bytes. These are real files; see the header on each test. */
function image(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(IMAGE_DIR, name)));
}

interface Decoded {
  decoded: DecodedImage | null;
  diagnostics: Diagnostic[];
}

function decode(bytes: Uint8Array, name = "fig.png"): Decoded {
  const diagnostics: Diagnostic[] = [];
  const decoded = decodeImage(bytes, name, diagnostics);
  return { decoded, diagnostics };
}

/** The one decoded image a test expects, with its diagnostics asserted empty. */
function decodeOk(name: string): DecodedImage {
  const { decoded, diagnostics } = decode(image(name), name);
  assert.deepEqual(diagnostics.map((d) => d.message), [], `${name} produced diagnostics`);
  assert.ok(decoded !== null, `${name} did not decode`);
  return decoded;
}

/** The one diagnostic a failing decode is required to produce. */
function decodeFails(bytes: Uint8Array, name: string): Diagnostic {
  const { decoded, diagnostics } = decode(bytes, name);
  assert.equal(decoded, null, `${name} decoded when it should not have`);
  const errors = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 1, `${name}: ${JSON.stringify(diagnostics)}`);
  const hit = errors[0] as Diagnostic;
  // Whatever went wrong, a reader has to be able to tell *which file* it was.
  assert.match(hit.message, new RegExp(escape(name)), "the diagnostic does not name the file");
  return hit;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A near-equality on points: the fixtures' DPI is itself a rounded number. */
function closeTo(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} is not about ${expected}`);
}

// ---------------------------------------------------------------------------
// 1. decode: PNG
// ---------------------------------------------------------------------------

/**
 * `rgb8.png` is a 4x3 truecolour 8-bit PNG with no `pHYs` chunk. No declared
 * resolution means 72 dpi — one pixel to one point — which is what `graphicx`
 * assumes and therefore the number a person comparing against pdflatex sees.
 */
test("a truecolour PNG with no resolution is read at one pixel to the point", () => {
  const decoded = decodeOk("rgb8.png");
  assert.equal(decoded.format, "png");
  assert.equal(decoded.pixelWidth, 4);
  assert.equal(decoded.pixelHeight, 3);
  closeTo(decoded.width, 4, "width");
  closeTo(decoded.height, 3, "height");
  // The bytes come back *unchanged* — decode's contract, and what lets emission
  // embed a PNG's own `IDAT` without recompressing it.
  assert.deepEqual(decoded.bytes, image("rgb8.png"));
});

/**
 * `gray8-300dpi.png` is 8x8 greyscale with `pHYs` declaring 11811 pixels per
 * metre, which is 300 dpi rounded once by ImageMagick. 8 pixels at 300 dpi is
 * 8/300 inch, or 1.92 points — so a `pHYs` chunk read from the wrong offset, or
 * ignored, would give 8 points and be off by more than four times.
 */
test("a PNG pHYs chunk in metres sets the intrinsic size", () => {
  const decoded = decodeOk("gray8-300dpi.png");
  assert.equal(decoded.pixelWidth, 8);
  closeTo(decoded.width, 1.92, "width");
  closeTo(decoded.height, 1.92, "height");
});

test("a palette PNG and a 16-bit PNG both decode to their pixel grid", () => {
  const palette = decodeOk("palette.png");
  assert.equal(palette.pixelWidth, 6);
  assert.equal(palette.pixelHeight, 4);
  const deep = decodeOk("gray16.png");
  assert.equal(deep.pixelWidth, 4);
  assert.equal(deep.pixelHeight, 4);
});

test("an RGBA PNG decodes; its alpha is emission's problem, not decode's", () => {
  const decoded = decodeOk("rgba8.png");
  assert.equal(decoded.pixelWidth, 4);
  assert.equal(decoded.pixelHeight, 3);
});

/**
 * The two shapes the sub-byte and 16-bit paths take, kept because each one is a
 * separate branch of emission: a 2-bit palette image is passed through with
 * `/BitsPerComponent 2` and PNG prediction, and a 16-bit RGBA image is the
 * deepest thing the alpha split has to deinterleave (two bytes per sample).
 */
test("a 2-bit palette PNG and a 16-bit RGBA PNG both decode", () => {
  const palette = decodeOk("palette2bit.png");
  assert.equal(palette.pixelWidth, 8);
  assert.equal(palette.pixelHeight, 4);
  const deep = decodeOk("rgba16.png");
  assert.equal(deep.pixelWidth, 4);
  assert.equal(deep.pixelHeight, 3);
});

// ---------------------------------------------------------------------------
// 2. decode: JPEG
// ---------------------------------------------------------------------------

/**
 * `photo.jpg` carries a JFIF header with density units 0, which declares a pixel
 * *aspect ratio* and no physical size at all — so, like a PNG with no `pHYs`, it
 * is read at 72 dpi.
 */
test("a baseline JPEG with no real density is read at one pixel to the point", () => {
  const decoded = decodeOk("photo.jpg");
  assert.equal(decoded.format, "jpeg");
  assert.equal(decoded.pixelWidth, 8);
  assert.equal(decoded.pixelHeight, 8);
  closeTo(decoded.width, 8, "width");
});

test("a greyscale JPEG decodes like a colour one", () => {
  const decoded = decodeOk("gray.jpg");
  assert.equal(decoded.pixelWidth, 8);
  closeTo(decoded.width, 8, "width");
});

test("a JFIF density in dpi sets the intrinsic size", () => {
  const decoded = decodeOk("photo-300dpi.jpg");
  closeTo(decoded.width, 1.92, "width");
});

/**
 * `exif-150dpi.jpg` has its `APP0` removed and an `APP1` `Exif` block spliced
 * in, so the resolution is only reachable by walking a TIFF IFD — and the `SOF`
 * is several segments further in, which is the case the marker walk exists for.
 */
test("an Exif XResolution is read when there is no JFIF density", () => {
  const decoded = decodeOk("exif-150dpi.jpg");
  assert.equal(decoded.pixelWidth, 8);
  closeTo(decoded.width, (8 * 72) / 150, "width");
});

/**
 * `jfif-vs-exif.jpg` says 300 dpi in JFIF and 150 dpi in Exif. JFIF wins — it
 * is the density field of the JPEG interchange format itself and it is what
 * pdftex reads — and the disagreement is an `info`, because a figure that comes
 * out half the expected size needs a trail leading to the file's own
 * contradictory metadata.
 */
test("when JFIF and Exif disagree about resolution, JFIF wins and says so", () => {
  const { decoded, diagnostics } = decode(image("jfif-vs-exif.jpg"), "both.jpg");
  assert.ok(decoded !== null);
  closeTo(decoded.width, 1.92, "width (the JFIF 300 dpi reading)");
  assert.equal(diagnostics.length, 1);
  const hit = diagnostics[0] as Diagnostic;
  assert.equal(hit.severity, "info", "a contradiction inside a file is not the document's error");
  assert.match(hit.message, /both\.jpg/);
  assert.match(hit.message, /300 dpi/);
  assert.match(hit.message, /150 dpi/);
});

/**
 * The signature decides, not the name. A JPEG saved as `plot.png` is what a
 * person gets from "save as" more often than anyone would like, and embedding it
 * correctly is strictly better than refusing it on the strength of four letters.
 */
test("the format comes from the file's signature, not from its extension", () => {
  const decoded = decodeOk("photo.jpg");
  const asPng = decode(image("photo.jpg"), "plot.png");
  assert.ok(asPng.decoded !== null);
  assert.equal(asPng.decoded.format, "jpeg");
  assert.equal(asPng.decoded.pixelWidth, decoded.pixelWidth);
});

// ---------------------------------------------------------------------------
// 3. decode: every way it can fail
// ---------------------------------------------------------------------------

test("an interlaced PNG is a diagnostic naming interlacing, not a wrong size", () => {
  const hit = decodeFails(image("interlaced.png"), "interlaced.png");
  assert.equal(hit.code, "unsupported");
  assert.match(hit.message, /interlaced|Adam7/i);
});

test("a progressive JPEG is a diagnostic naming progressive", () => {
  const hit = decodeFails(image("progressive.jpg"), "progressive.jpg");
  assert.equal(hit.code, "unsupported");
  assert.match(hit.message, /progressive/i);
});

/**
 * A CMYK JPEG's samples may or may not be inverted depending on an Adobe
 * `APP14` marker, and guessing wrong inverts every colour in the figure. A
 * refusal that says so beats a picture in photographic negative.
 */
test("a CMYK JPEG is a diagnostic naming CMYK", () => {
  const hit = decodeFails(image("cmyk.jpg"), "cmyk.jpg");
  assert.equal(hit.code, "unsupported");
  assert.match(hit.message, /CMYK/);
});

test("a truncated PNG is a diagnostic naming the file", () => {
  const hit = decodeFails(image("rgb8.png").slice(0, 40), "cut.png");
  assert.equal(hit.code, "syntax");
  assert.match(hit.message, /truncated|past the end/);
});

/**
 * The case that would otherwise be *silently* wrong: colour types 0, 2 and 3 go
 * into the PDF without a pixel being decoded, so a bit-flip inside `IDAT` would
 * reach a reader as a broken picture with nothing anywhere saying why. Every
 * chunk's CRC is checked for exactly this.
 */
test("a PNG with damaged image data fails its checksum and says the data is damaged", () => {
  const bytes = image("rgb8.png");
  // Byte 8+8+13+4 = the first byte of the chunk after IHDR's header, i.e. well
  // inside the IDAT payload of this small file.
  const damaged = bytes.slice();
  const at = damaged.length - 20;
  damaged[at] = (damaged[at] as number) ^ 0xff;
  const hit = decodeFails(damaged, "damaged.png");
  assert.equal(hit.code, "syntax");
  assert.match(hit.message, /checksum|damaged/);
});

test("a PNG with no IEND is a diagnostic: a file cut at a chunk boundary is still truncated", () => {
  const bytes = image("rgb8.png");
  // IEND is the last 12 bytes of any PNG, and dropping exactly those leaves
  // every remaining chunk intact and correctly checksummed.
  const hit = decodeFails(bytes.slice(0, bytes.length - 12), "noend.png");
  assert.equal(hit.code, "syntax");
  assert.match(hit.message, /IEND|truncated/);
});

test("a JPEG with no EOI is a diagnostic naming the file", () => {
  const bytes = image("photo.jpg");
  const hit = decodeFails(bytes.slice(0, bytes.length - 40), "cut.jpg");
  assert.equal(hit.code, "syntax");
  assert.match(hit.message, /truncated|EOI/);
});

test("bytes that are not an image at all are a diagnostic naming the file", () => {
  const hit = decodeFails(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), "junk.png");
  assert.equal(hit.code, "syntax");
  assert.match(hit.message, /not a PNG or a JPEG/);
});

test("an empty file is a diagnostic, not a zero-by-zero image", () => {
  const hit = decodeFails(new Uint8Array(0), "empty.png");
  assert.equal(hit.code, "syntax");
});

/**
 * Brief 39's Out list, each recognised by signature so the diagnostic can name
 * the format. "This engine does not implement EPS" is an answer; "no such file"
 * and a blank space are not.
 */
const UNSUPPORTED_FORMATS: readonly { name: string; bytes: Uint8Array; format: RegExp }[] = [
  { name: "fig.pdf", bytes: encoder.encode("%PDF-1.7\n1 0 obj\n"), format: /PDF/ },
  { name: "fig.eps", bytes: encoder.encode("%!PS-Adobe-3.0 EPSF-3.0\n"), format: /EPS|PostScript/ },
  { name: "fig.svg", bytes: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), format: /SVG/ },
  { name: "x.svg", bytes: encoder.encode('<?xml version="1.0"?>\n<svg/>'), format: /SVG/ },
  { name: "fig.gif", bytes: encoder.encode("GIF89a\u0001\u0000"), format: /GIF/ },
  { name: "fig.bmp", bytes: encoder.encode("BM\u0000\u0000\u0000\u0000"), format: /BMP/ },
  { name: "fig.tif", bytes: new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]), format: /TIFF/ },
  {
    name: "fig.webp",
    bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
    format: /WebP/,
  },
];

test("every unsupported image format is a diagnostic naming the format", () => {
  for (const { name, bytes, format } of UNSUPPORTED_FORMATS) {
    const hit = decodeFails(new Uint8Array(bytes), name);
    assert.equal(hit.code, "unsupported", name);
    assert.match(hit.message, format, name);
  }
});

/**
 * The fuzz case, and the one this file exists to make impossible: `decodeImage`
 * is the only place a *document* controls the bytes the engine parses, so it is
 * the likeliest place a malformed input could take the whole compile down.
 */
test("decodeImage never throws, whatever the bytes are", () => {
  const sources = [image("rgb8.png"), image("photo.jpg"), image("rgba8.png")];
  // A deterministic pseudo-random walk: truncations, single-byte corruptions and
  // spliced prefixes over every fixture, which between them hit every branch of
  // both parsers with garbage.
  let seed = 12345;
  const next = (limit: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  for (let i = 0; i < 600; i++) {
    const source = sources[next(sources.length)] as Uint8Array;
    const bytes = source.slice(0, 1 + next(source.length));
    const flips = next(4);
    for (let f = 0; f < flips && bytes.length > 0; f++) {
      const at = next(bytes.length);
      bytes[at] = next(256);
    }
    const diagnostics: Diagnostic[] = [];
    const decoded = decodeImage(bytes, "fuzz.png", diagnostics);
    // Either it decoded, or it said why. Never nothing, and never a throw.
    if (decoded === null) {
      assert.ok(diagnostics.length > 0, `no diagnostic for ${bytes.length} bytes, seed ${seed}`);
    }
    for (const d of diagnostics) assert.notEqual(d.code, "internal");
  }
});

// ---------------------------------------------------------------------------
// 4. the sizing keys
// ---------------------------------------------------------------------------

const design = defaultDesign();
const lengths = { design, measure: design.textWidth, size: 10 };

function sizing(over: Partial<ImageSizing> = {}): ImageSizing {
  return { width: null, height: null, scale: null, ...over };
}

/** A 4x3-point intrinsic image — the aspect ratio is 4:3, so it is checkable. */
function sized(over: Partial<ImageSizing>): { width: number; height: number } {
  const decoded = decodeOk("rgb8.png");
  const placed = placedImageSize(decoded, sizing(over), lengths);
  assert.ok(placed !== null, "the size was refused");
  return placed;
}

test("no sizing key at all means the intrinsic size", () => {
  assert.deepEqual(sized({}), { width: 4, height: 3 });
});

test("width alone preserves the aspect ratio", () => {
  const placed = sized({ width: { kind: "points", value: 144 } });
  assert.equal(placed.width, 144);
  closeTo(placed.height, 108, "height");
});

test("height alone preserves the aspect ratio", () => {
  const placed = sized({ height: { kind: "points", value: 60 } });
  assert.equal(placed.height, 60);
  closeTo(placed.width, 80, "width");
});

test("width and height together are taken exactly, aspect ratio or not", () => {
  const placed = sized({
    width: { kind: "points", value: 100 },
    height: { kind: "points", value: 100 },
  });
  assert.deepEqual(placed, { width: 100, height: 100 });
});

test("scale multiplies the intrinsic size", () => {
  assert.deepEqual(sized({ scale: 12 }), { width: 48, height: 36 });
});

/** LaTeX's own precedence: `graphicx` resolves `scale` only when nothing else set a size. */
test("width beats scale", () => {
  const placed = sized({ width: { kind: "points", value: 40 }, scale: 100 });
  assert.equal(placed.width, 40);
  closeTo(placed.height, 30, "height");
});

test("height beats scale, and still keeps the aspect ratio", () => {
  const placed = sized({ height: { kind: "points", value: 30 }, scale: 100 });
  closeTo(placed.width, 40, "width");
});

test("a \\textwidth-relative width resolves against the page design", () => {
  const placed = sized({ width: { kind: "relative", factor: 0.5, of: "textwidth" } });
  closeTo(placed.width, design.textWidth / 2, "width");
  closeTo(placed.height, (design.textWidth / 2) * (3 / 4), "height");
});

test("a font-relative height resolves against the type size in force", () => {
  const placed = placedImageSize(decodeOk("rgb8.png"), sizing({ height: { kind: "font", value: 2, unit: "em" } }), {
    ...lengths,
    size: 12,
  });
  assert.ok(placed !== null);
  closeTo(placed.height, 24, "height");
});

/**
 * A zero or negative size is refused rather than placed. A zero-width picture is
 * a figure that silently vanished, which is the one outcome the loud-failure
 * contract rules out; `placeImage` turns this `null` into a diagnostic.
 */
test("a size that is not positive and finite is refused", () => {
  const decoded = decodeOk("rgb8.png");
  for (const over of [
    { scale: 0 },
    { scale: -2 },
    { width: { kind: "points" as const, value: 0 } },
    { width: { kind: "points" as const, value: -10 } },
    { height: { kind: "points" as const, value: Number.NaN } },
  ]) {
    assert.equal(placedImageSize(decoded, sizing(over), lengths), null, JSON.stringify(over));
  }
});

// ---------------------------------------------------------------------------
// 5. placement through the seam and through compile()
// ---------------------------------------------------------------------------

function imageInline(path: string, over: Partial<ImageSizing> = {}): ImageInline {
  return {
    kind: "image",
    path,
    sizing: sizing(over),
    style: { font: { family: "serif", weight: "regular", slant: "upright" }, underline: false },
    loc: { file: "main.tex", line: 4 },
  };
}

function imageCtx(files: Record<string, Uint8Array>, diagnostics: Diagnostic[]): ImageContext {
  return { ...lengths, files, diagnostics, file: "main.tex", reported: new Set<string>() };
}

test("placeImage returns a box of the placed size holding the picture", () => {
  const diagnostics: Diagnostic[] = [];
  const ctx = imageCtx({ "fig.png": image("rgb8.png") }, diagnostics);
  const box = placeImage(imageInline("fig.png", { width: { kind: "points", value: 144 } }), ctx);
  assert.deepEqual(diagnostics, []);
  assert.ok(box !== null);
  assert.equal(box.kind, "hbox");
  assert.equal(box.width, 144);
  closeTo(box.height, 108, "height");
  // Zero depth: LaTeX sets a graphic sitting *on* the baseline.
  assert.equal(box.depth, 0);
  assert.equal(box.content.length, 1);
  const node = box.content[0];
  assert.ok(node !== undefined && node.kind === "image");
  assert.equal(node.path, "fig.png");
  assert.equal(node.depth, 0);
  assert.equal(node.image.format, "png");
});

/** The document model is laid out up to three times; every pass must read the same node. */
test("placeImage mutates nothing on the image node", () => {
  const inline = imageInline("fig.png", { scale: 3 });
  const before = JSON.stringify(inline);
  const ctx = imageCtx({ "fig.png": image("rgb8.png") }, []);
  placeImage(inline, ctx);
  placeImage(inline, ctx);
  assert.equal(JSON.stringify(inline), before);
});

test("\\includegraphics{plot} finds plot.png, the way graphicx resolves a bare name", () => {
  const files = { "figures/plot.png": image("rgb8.png") };
  assert.deepEqual(resolveImageFile("figures/plot", files), {
    kind: "found",
    path: "figures/plot.png",
    bytes: files["figures/plot.png"],
  });
  // The bare name first, so an explicit `.png` never looks for `plot.png.png`.
  assert.equal(resolveImageFile("figures/plot.png", files).kind, "found");
  assert.equal(resolveImageFile("nothing", files).kind, "missing");
  // `constructor` is on `Object.prototype`; a truthiness test would "find" it.
  assert.equal(resolveImageFile("constructor", files).kind, "missing");
});

test("an unknown path is missing-file, naming what was asked for", () => {
  const diagnostics: Diagnostic[] = [];
  const ctx = imageCtx({}, diagnostics);
  assert.equal(placeImage(imageInline("nope.png"), ctx), null);
  assert.equal(diagnostics.length, 1);
  const hit = diagnostics[0] as Diagnostic;
  assert.equal(hit.code, "missing-file");
  assert.equal(hit.construct, "\\includegraphics");
  // Re-homed onto the `\includegraphics`, not onto the image file: a diagnostic
  // a reader can click on.
  assert.equal(hit.file, "main.tex");
  assert.equal(hit.line, 4);
  assert.match(hit.message, /nope\.png/);
});

test("a name that only resolves to an unsupported format says which format", () => {
  const diagnostics: Diagnostic[] = [];
  const ctx = imageCtx({ "plot.eps": encoder.encode("%!PS-Adobe-3.0 EPSF-3.0\n") }, diagnostics);
  assert.equal(placeImage(imageInline("plot"), ctx), null);
  const hit = diagnostics[0] as Diagnostic;
  assert.equal(hit.code, "unsupported");
  assert.match(hit.message, /plot\.eps/);
  assert.match(hit.message, /EPS/);
});

test("one bad file is one diagnostic, however many times it is placed", () => {
  const diagnostics: Diagnostic[] = [];
  const ctx = imageCtx({ "bad.png": new Uint8Array([1, 2, 3, 4]) }, diagnostics);
  for (let i = 0; i < 5; i++) assert.equal(placeImage(imageInline("bad.png"), ctx), null);
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
});

test("a size the sizing keys make impossible is a diagnostic, not a zero-width box", () => {
  const diagnostics: Diagnostic[] = [];
  const ctx = imageCtx({ "fig.png": image("rgb8.png") }, diagnostics);
  assert.equal(placeImage(imageInline("fig.png", { scale: 0 }), ctx), null);
  assert.equal(diagnostics.length, 1);
  assert.equal((diagnostics[0] as Diagnostic).code, "syntax");
  assert.match((diagnostics[0] as Diagnostic).message, /positive/);
});

// --- through a whole compile ------------------------------------------------

const IMAGE_FILES = [
  "rgb8.png",
  "rgba8.png",
  "rgba16.png",
  "gray8-300dpi.png",
  "palette.png",
  "palette2bit.png",
  "gray16.png",
  "photo.jpg",
  "gray.jpg",
] as const;

function project(body: string, extra: Record<string, Uint8Array> = {}): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    "main.tex": encoder.encode(`\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`),
    ...extra,
  };
  for (const name of IMAGE_FILES) files[name] = image(name);
  return files;
}

function compileBody(body: string, extra: Record<string, Uint8Array> = {}): CompileResult {
  return compile(project(body, extra), "main.tex", { fonts });
}

function placedImages(pages: readonly Page[]): PlacedImage[] {
  const out: PlacedImage[] = [];
  for (const page of pages) {
    for (const item of page.items) if (item.kind === "image") out.push(item);
  }
  return out;
}

/**
 * `compile()` cannot produce a PDF while `doc/build.ts`'s interim
 * `NOTICE-39.2` still reports every `\includegraphics` as an error, so the
 * end-to-end assertions here are on `result.pages` — the positioned layout —
 * and the PDF is rendered from those pages with the same `renderPdf` call
 * `compile()` makes. When the notice is deleted, `result.pdf` is that PDF.
 */
function pdfFor(result: CompileResult, compressStreams = true): Uint8Array {
  const rendered = renderPdf(result.pages, { file: "main.tex", compressStreams });
  assert.deepEqual(rendered.diagnostics, [], "emission failed");
  assert.ok(rendered.pdf !== null);
  return rendered.pdf;
}

test("an \\includegraphics is placed on the page at the size its keys ask for", () => {
  const result = compileBody("\\includegraphics[width=2in]{rgb8.png}");
  const images = placedImages(result.pages);
  assert.equal(images.length, 1);
  const placed = images[0] as PlacedImage;
  assert.equal(placed.path, "rgb8.png");
  assert.equal(placed.width, 144);
  closeTo(placed.height, 108, "height");
  // Inside the text body, and on the first page.
  assert.ok(placed.x >= design.marginLeft - 0.01);
  assert.ok(placed.y >= design.marginTop - 0.01);
  assert.equal(result.diagnostics.some((d) => d.code === "internal"), false);
});

test("every supported format reaches the page", () => {
  const body = IMAGE_FILES.map((name) => `\\includegraphics[width=1in]{${name}}\n`).join("");
  const result = compileBody(body);
  const images = placedImages(result.pages);
  assert.deepEqual(
    images.map((i) => i.path).sort(),
    [...IMAGE_FILES].sort(),
  );
  for (const placed of images) assert.equal(placed.width, 72);
  assert.equal(result.diagnostics.some((d) => d.code === "internal"), false);
});

test("a missing image reports missing-file and the rest of the document still sets", () => {
  const result = compileBody("Before.\n\n\\includegraphics{absent.png}\n\nAfter.");
  const hit = result.diagnostics.find((d) => d.code === "missing-file");
  assert.ok(hit !== undefined);
  assert.equal(hit.construct, "\\includegraphics");
  assert.equal(hit.file, "main.tex");
  assert.ok(hit.line > 0, "the diagnostic points at no line");
  assert.equal(placedImages(result.pages).length, 0);
  assert.ok(result.pages.length >= 1);
  const text = result.pages
    .flatMap((page) => page.items)
    .map((item) => (item.kind === "glyphrun" ? item.text : ""))
    .join(" ");
  assert.match(text, /Before/);
  assert.match(text, /After/);
});

test("a corrupt image inside a real document is a diagnostic, never a crash", () => {
  const result = compileBody("\\includegraphics{broken.png}", {
    "broken.png": image("rgb8.png").slice(0, 30),
  });
  const hit = result.diagnostics.find((d) => d.code === "syntax" && /broken\.png/.test(d.message));
  assert.ok(hit !== undefined, JSON.stringify(result.diagnostics));
  assert.equal(hit.construct, "\\includegraphics");
  assert.equal(result.diagnostics.some((d) => d.code === "internal"), false);
});

test("an image wider than the measure is an overfull box, which is the existing report", () => {
  const result = compileBody("\\includegraphics[width=20in]{rgb8.png}");
  assert.ok(result.diagnostics.some((d) => d.code === "overfull-box"));
  assert.equal(placedImages(result.pages).length, 1);
});

// ---------------------------------------------------------------------------
// 6. embedding
// ---------------------------------------------------------------------------

/** The uncompressed PDF as Latin-1 text, so a test can read its operators. */
function asText(pdf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < pdf.length; i++) out += String.fromCharCode(pdf[i] as number);
  return out;
}

test("each image becomes one XObject, painted by scaling the unit square", () => {
  const result = compileBody("\\includegraphics[width=2in]{rgb8.png}");
  const text = asText(pdfFor(result, false));
  assert.match(text, /\/Subtype \/Image/);
  assert.match(text, /\/XObject <</);
  // `w 0 0 h x y cm` then `Do`, bracketed by `q`/`Q` so one image's transform
  // cannot leak into the next.
  assert.match(text, /q\n144 0 0 108 [\d.]+ [\d.]+ cm\n\/Im0 Do\nQ/);
});

test("the same file placed twice is one XObject and two Do operators", () => {
  const result = compileBody(
    "\\includegraphics[width=1in]{rgb8.png}\n\\includegraphics[width=2in]{rgb8.png}",
  );
  assert.equal(placedImages(result.pages).length, 2);
  const text = asText(pdfFor(result, false));
  assert.equal((text.match(/\/Im0 Do/g) ?? []).length, 2);
  assert.equal((text.match(/\/Subtype \/Image/g) ?? []).length, 1);
  assert.equal(text.includes("/Im1"), false);
});

/**
 * A JPEG goes in **verbatim**: a PDF image stream with `/DCTDecode` *is* a JPEG
 * datastream, so there is no decode, no recompression and no quality lost. The
 * file's own bytes are findable in the PDF, which is the strongest form that
 * claim can be tested in.
 */
test("a JPEG is embedded verbatim as DCTDecode", () => {
  const result = compileBody("\\includegraphics[width=1in]{photo.jpg}");
  const text = asText(pdfFor(result, false));
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.match(text, /\/ColorSpace \/DeviceRGB/);
  assert.ok(text.includes(asText(image("photo.jpg"))), "the JPEG's own bytes are not in the file");
});

test("a greyscale JPEG is embedded as DeviceGray", () => {
  const text = asText(pdfFor(compileBody("\\includegraphics[width=1in]{gray.jpg}"), false));
  assert.match(text, /\/ColorSpace \/DeviceGray/);
});

/**
 * A non-alpha PNG also goes in verbatim: PDF's `/Predictor 15` is PNG's own
 * per-scanline filtering (the PDF specification took it from PNG), so the zlib
 * stream in `IDAT` is exactly what a `/FlateDecode` image stream wants.
 */
test("a PNG's IDAT is embedded verbatim, with PNG prediction declared", () => {
  const result = compileBody("\\includegraphics[width=1in]{rgb8.png}");
  const text = asText(pdfFor(result, false));
  assert.match(text, /\/Filter \/FlateDecode/);
  assert.match(text, /\/Predictor 15/);
  assert.match(text, /\/Colors 3/);
  assert.match(text, /\/Columns 4/);
});

test("a palette PNG becomes an Indexed colour space carrying its PLTE table", () => {
  const text = asText(pdfFor(compileBody("\\includegraphics[width=1in]{palette.png}"), false));
  assert.match(text, /\/ColorSpace \[ \/Indexed \/DeviceRGB 3 </);
  assert.match(text, /\/Colors 1/);
});

test("a 16-bit PNG keeps its 16 bits per component", () => {
  const text = asText(pdfFor(compileBody("\\includegraphics[width=1in]{gray16.png}"), false));
  assert.match(text, /\/BitsPerComponent 16/);
});

test("a sub-byte palette PNG keeps its bit depth, predictor and all", () => {
  const text = asText(pdfFor(compileBody("\\includegraphics[width=1in]{palette2bit.png}"), false));
  assert.match(text, /\/BitsPerComponent 2/);
  assert.match(text, /\/Predictor 15/);
  assert.match(text, /\/Colors 1/);
  assert.match(text, /\/Columns 8/);
});

test("a 16-bit RGBA PNG splits into a 16-bit image and a 16-bit SMask", () => {
  const text = asText(pdfFor(compileBody("\\includegraphics[width=1in]{rgba16.png}"), false));
  assert.equal((text.match(/\/BitsPerComponent 16/g) ?? []).length, 2);
  // 4x3 pixels: three 16-bit colour samples and one 16-bit alpha sample each.
  assert.match(text, /\/Length 72/);
  assert.match(text, /\/Length 24/);
});

/**
 * The one PNG that has to be decoded: PDF has no interleaved alpha, so an RGBA
 * image is inflated, unfiltered, and split into a `DeviceRGB` image plus a
 * single-channel `/SMask`.
 */
test("an RGBA PNG is split into an image and an SMask", () => {
  const result = compileBody("\\includegraphics[width=1in]{rgba8.png}");
  const text = asText(pdfFor(result, false));
  assert.match(text, /\/SMask \d+ \d+ R/);
  assert.equal((text.match(/\/Subtype \/Image/g) ?? []).length, 2, "the mask is an image of its own");
  // 4x3 pixels, 3 colour bytes and 1 alpha byte each, both streams uncompressed.
  assert.match(text, /\/Length 36/);
  assert.match(text, /\/Length 12/);
});

test("a document with no images has no /XObject entry at all", () => {
  const result = compile(
    { "main.tex": encoder.encode("\\documentclass{article}\n\\begin{document}\nPlain prose.\n\\end{document}\n") },
    "main.tex",
    { fonts },
  );
  assert.ok(result.pdf !== null);
  assert.equal(asText(result.pdf).includes("/XObject"), false);
});

test("the PDF a reader gets is valid, and its images are in the page's resources", async () => {
  const body = IMAGE_FILES.map((name) => `\\includegraphics[width=1in]{${name}}\n`).join("");
  const pdf = pdfFor(compileBody(body));
  const document = await PDFDocument.load(pdf);
  assert.equal(document.getPageCount(), 1);
  const resources = document.getPage(0).node.Resources();
  assert.ok(resources !== undefined);
  // The dictionary's own keys are enough: `/XObject` present means the page can
  // resolve the `Do` operators in its content stream.
  const keys = resources.keys().map((key) => key.asString());
  assert.ok(keys.includes("/XObject"), keys.join(" "));
});

// ---------------------------------------------------------------------------
// 7. determinism
// ---------------------------------------------------------------------------

/**
 * The same requirement brief 37 put on emission, now with images in the file:
 * two compiles of the same project produce byte-identical output. Without it no
 * test can assert on bytes at all.
 */
test("the same document with images produces byte-identical PDFs twice", () => {
  const body = IMAGE_FILES.map((name) => `\\includegraphics[width=1in]{${name}}\n`).join("");
  const first = pdfFor(compileBody(body));
  const second = pdfFor(compileBody(body));
  assert.deepEqual(first, second);
});

test("two documents differing only in their image differ in their bytes", () => {
  const a = pdfFor(compileBody("\\includegraphics[width=1in]{rgb8.png}"));
  const b = pdfFor(compileBody("\\includegraphics[width=1in]{gray.jpg}"));
  assert.notDeepEqual(a, b);
  // And the `/ID` is a fingerprint of the content, so it moved too.
  assert.notEqual(idOf(asText(a)), idOf(asText(b)));
});

function idOf(text: string): string {
  const match = /\/ID \[ <([0-9A-F]+)>/.exec(text);
  assert.ok(match !== null, "no /ID in the file");
  return match[1] as string;
}
