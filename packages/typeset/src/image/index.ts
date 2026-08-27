import type { Diagnostic } from "../diagnostics.ts";
import { diagnostic, error, unsupported, wholeFile } from "../diagnostics.ts";
import type { ImageInline, ImageSizing } from "../doc/model.ts";
import type { LengthContext } from "../layout/design.ts";
import { resolveDocumentLength } from "../layout/design.ts";
import type { HBox, ImageNode } from "../layout/model.ts";

/**
 * `\includegraphics`: PNG and JPEG bytes to an intrinsic size, the sizing keys
 * applied, and a description of the PDF `XObject` `pdf/render.ts` embeds.
 *
 * **The engine performs no I/O (D38), and that is not negotiable here either.**
 * An image is an *input*: it arrives in `compile()`'s file map like the `.tex`
 * itself, which is why `ImageContext` carries `files` rather than a path this
 * module could open. Adding a filesystem read to this file would break the one
 * security property the engine has.
 *
 * **Nothing here throws.** `compile()` is documented never to throw, and an
 * image is the one input a *document* controls the bytes of, so this file is
 * the likeliest place a malformed input could take the engine down. Every
 * failure — an absent name, a format we do not implement, a chunk length that
 * runs off the end of the file — leaves a `Diagnostic` naming the file and
 * returns `null`.
 *
 * ## What is supported, and what is a diagnostic
 *
 * **PNG** (signature-checked, every chunk CRC-verified):
 *
 * - colour types 0 (grey), 2 (RGB) and 3 (palette), bit depths 1–16 as the
 *   format allows them. These are embedded **verbatim**: a PDF image with
 *   `/Filter /FlateDecode` and `/DecodeParms /Predictor 15` is byte-for-byte a
 *   PNG's zlib-compressed, per-scanline-filtered `IDAT` data, so the bytes go
 *   into the file untouched and no pixel is ever decoded here.
 * - colour types 4 (grey+alpha) and 6 (RGBA) at bit depth 8 or 16. PDF has no
 *   interleaved alpha channel, so these are the one case that *is* decoded:
 *   inflate, undo the scanline filters, and split the samples into an image
 *   plus a `/SMask`. The inflate is pdf-lib's (injected — see `Inflate`), so
 *   this file still contains no compression code.
 * - `pHYs` resolution, when it is given in metres, sets the intrinsic size.
 *   Absent, or given as a bare aspect ratio, the pixel grid is read at 72 dpi
 *   — one pixel to one point — which is what `graphicx` does.
 *
 * PNG diagnostics: **interlaced** (Adam7) images, **transparency chunks**
 * (`tRNS`, whose colour-key and palette-alpha forms PDF cannot express as a
 * `/Decode` array), and an alpha colour type at a bit depth other than 8 or 16.
 * A bad CRC, a chunk length past the end of the file, a missing `IHDR`/`IDAT`
 * and a missing `IEND` are all *corruption* and say so.
 *
 * **JPEG** (`DCTDecode`, embedded verbatim — a PDF image stream *is* a JPEG
 * datastream):
 *
 * - baseline and extended-sequential Huffman (`SOF0`, `SOF1`), 8 bits per
 *   component, 1 component (grey) or 3 (YCbCr → `DeviceRGB`). The `SOF` need
 *   not be the first marker; every segment is walked until it is found.
 * - `JFIF` (`APP0`) density in dpi or dots-per-cm, and `Exif` (`APP1`)
 *   `XResolution`/`YResolution` when there is no JFIF density. **JFIF wins**
 *   where both are present, because it is the density field of the JPEG
 *   interchange format itself and it is what `pdftex` reads; when the two
 *   disagree that is an `info` naming both numbers, so a surprising size has a
 *   trail rather than being a mystery.
 *
 * JPEG diagnostics: **progressive** (`SOF2`) — PDF's `DCTDecode` is specified
 * for the sequential modes and real readers reject progressive data —
 * arithmetic/lossless/hierarchical `SOF`s, **CMYK** (4-component) data, whose
 * correct rendering needs the Adobe `APP14` inversion heuristics and would
 * otherwise be silently colour-inverted, a precision other than 8 bits, and a
 * datastream with no `EOI` (truncated).
 *
 * Everything else that a person might reasonably write — PDF, EPS, SVG, GIF,
 * TIFF, BMP, WebP — is recognised **by signature** and named in an
 * `unsupported` diagnostic, so "why is my figure missing" always has an answer.
 */

/** The project as `compile()` received it: project-relative path → raw bytes. */
export type ImageFiles = Readonly<Record<string, Uint8Array>>;

/** The formats brief 39 implements. Anything else is a diagnostic naming it. */
export type ImageFormat = "png" | "jpeg";

/**
 * An image's own size, as its bytes declare it — before any sizing key is
 * applied. `width`/`height` are in PDF points: a raster image has pixels and a
 * resolution, and turning that into points is decode's job so nothing
 * downstream has to think about DPI.
 */
export interface DecodedImage {
  format: ImageFormat;
  /** Intrinsic width in points. */
  width: number;
  /** Intrinsic height in points. */
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  /** The bytes, unchanged, ready for `pdf/render.ts` to embed as an `XObject`. */
  bytes: Uint8Array;
}

/**
 * What `placeImage` needs beyond the node itself.
 *
 * `design`/`measure`/`size` are exactly `LengthContext`, so a `width=` key is
 * resolved with `resolveDocumentLength` from `layout/design.ts` — the same
 * function a `p{}` column uses, so the two cannot disagree about what
 * `0.8\textwidth` means.
 */
export interface ImageContext extends LengthContext {
  files: ImageFiles;
  /** Where diagnostics go. Appended to, never replaced. */
  diagnostics: Diagnostic[];
  /** The entrypoint, for a diagnostic with no better position than the document. */
  file: string;
  /** Formats already reported for a given path, so one bad image is one diagnostic. */
  reported: Set<string>;
}

/**
 * One pixel to one point, which is `graphicx`'s reading of an image that
 * declares no resolution of its own. PDF's unit is 1/72 inch, so this is the
 * same thing as "assume 72 dpi".
 */
const DEFAULT_DPI = 72;

/** Metres to inches, for a `pHYs` chunk's pixels-per-metre. */
const METRE_IN_INCHES = 39.37007874015748;

/**
 * A ceiling on the pixel grid an image may declare, checked **before** any
 * buffer is sized from it. A PNG header is 25 bytes and can claim a 4-billion-
 * pixel side; without this, a 100-byte file could ask for a terabyte of
 * scanline buffer. 40 megapixels is about six times a full-page 300-dpi
 * photograph, so nothing a person would put in a document comes near it.
 */
const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Extensions `\includegraphics{plot}` may mean, in the order `graphicx`'s
 * pdftex driver tries them, restricted to the two formats this engine reads.
 * The bare name is tried first, so `\includegraphics{plot.png}` never looks for
 * `plot.png.png`.
 */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".PNG", ".JPG", ".JPEG"];

/**
 * Extensions worth recognising only to give a better diagnostic: if
 * `\includegraphics{plot}` finds `plot.eps` and nothing else, "this engine does
 * not implement EPS" is the true answer and "no such file" is a misleading one.
 */
const KNOWN_UNSUPPORTED_EXTENSIONS: readonly { ext: string; format: string }[] = [
  { ext: ".pdf", format: "PDF" },
  { ext: ".eps", format: "EPS" },
  { ext: ".ps", format: "PostScript" },
  { ext: ".svg", format: "SVG" },
  { ext: ".gif", format: "GIF" },
  { ext: ".tif", format: "TIFF" },
  { ext: ".tiff", format: "TIFF" },
  { ext: ".bmp", format: "BMP" },
  { ext: ".webp", format: "WebP" },
];

// ---------------------------------------------------------------------------
// Placement — the seam `layout/vlist.ts` calls
// ---------------------------------------------------------------------------

/**
 * **THE SEAM.** One image, placed: an `HBox` of the requested size holding
 * whatever node kind carries the embedded picture, or `null` when it could not
 * be placed at all.
 *
 * Returning an `HBox` rather than appending to a list is deliberate: an image
 * is horizontal material, so it takes part in line breaking exactly like a
 * word, and a box is the only thing the line breaker needs from it.
 *
 * The box has **zero depth**: LaTeX sets a graphic sitting on the baseline, so
 * its whole extent is height and a line containing one is as tall as the
 * picture. Its `width`/`height` are the *placed* size, so line breaking and the
 * overfull-box check see the real thing.
 *
 * `image` is never mutated — the document model is laid out up to three times
 * and each pass must read exactly what the first did. Everything derived here
 * (the resolved file name, the decoded size, the placed size) is recomputed per
 * pass from `ctx`, which is the only thing that can differ between them.
 *
 * Every failure is one `Diagnostic` per bad file per pass, attributed to the
 * `\includegraphics` that asked for it: `ctx.reported` is the latch, and
 * `layout/vlist.ts` hands the same set to every call in a pass.
 */
export function placeImage(image: ImageInline, ctx: ImageContext): HBox | null {
  const report = (d: Diagnostic, key: string): null => {
    // One diagnostic per bad file, not one per placement. Two `\includegraphics`
    // of the same broken figure is one problem, and a reader fixing it fixes it
    // once.
    if (ctx.reported.has(key)) return null;
    ctx.reported.add(key);
    ctx.diagnostics.push(d);
    return null;
  };

  const found = resolveImageFile(image.path, ctx.files);
  if (found.kind === "unsupported") {
    return report(
      unsupported(
        image.loc,
        "\\includegraphics",
        `\`${found.path}\` is ${found.format}; only PNG and JPEG are implemented`,
      ),
      found.path,
    );
  }
  if (found.kind === "missing") {
    const detail =
      image.path.length === 0
        ? "no file name was given"
        : `\`${image.path}\` is not one of the project's files`;
    return report(
      error("missing-file", image.loc, `\\includegraphics cannot find its image — ${detail}`, "\\includegraphics"),
      `missing:${image.path}`,
    );
  }

  // Decode reports against the *image* file, which has no line to point at.
  // Re-homing every diagnostic onto the `\includegraphics` that asked for it is
  // what makes the editor able to jump to it: the message already names the
  // image (that is decode's contract), so nothing is lost by moving the
  // position, and a position a reader can click on is gained.
  const decodeDiagnostics: Diagnostic[] = [];
  const decoded = decodeImage(found.bytes, found.path, decodeDiagnostics);
  for (const d of decodeDiagnostics) {
    // `code` is always set by every path in `decodeImage`; `syntax` is the
    // fallback rather than `internal` because a malformed image is the
    // document's problem and mislabelling it as an engine bug would send a
    // reader looking in the wrong place.
    const rehomed = diagnostic(d.severity, d.code ?? "syntax", image.loc, d.message, "\\includegraphics");
    // The message is part of the key so that a file with two distinct problems
    // (a resolution disagreement *and* a corrupt chunk) reports both.
    report(rehomed, `${found.path}#${d.code ?? ""}#${d.message}`);
  }
  if (decoded === null) return null;

  const placed = placedImageSize(decoded, image.sizing, ctx);
  if (placed === null) {
    return report(
      error(
        "syntax",
        image.loc,
        `\\includegraphics cannot place \`${found.path}\` — the width and height its sizing keys ask for are not both positive, finite lengths`,
        "\\includegraphics",
      ),
      `size:${found.path}`,
    );
  }

  const node: ImageNode = {
    kind: "image",
    width: placed.width,
    height: placed.height,
    depth: 0,
    path: found.path,
    image: decoded,
  };
  // Packed by hand rather than through `hpack`: the box holds exactly one rigid
  // node, so there is no glue to set and its size is the node's by definition.
  return {
    kind: "hbox",
    width: placed.width,
    height: placed.height,
    depth: 0,
    shift: 0,
    glueSet: null,
    content: [node],
  };
}

/** What `resolveImageFile` found, if anything. */
export type ResolvedImageFile =
  | { kind: "found"; path: string; bytes: Uint8Array }
  /** A format this engine does not read, recognised so the diagnostic can say so. */
  | { kind: "unsupported"; path: string; format: string }
  | { kind: "missing" };

/**
 * `\includegraphics{plot}` against the file map, the way `graphicx` resolves a
 * name: the bare name first, then each extension the driver knows.
 *
 * `Object.prototype.hasOwnProperty` rather than `path in files` or a truthiness
 * test, because `files` is a plain object a caller built: `\includegraphics
 * {constructor}` would otherwise "find" a function on `Object.prototype`.
 */
export function resolveImageFile(path: string, files: ImageFiles): ResolvedImageFile {
  if (path.length === 0) return { kind: "missing" };
  const at = (name: string): Uint8Array | null =>
    Object.prototype.hasOwnProperty.call(files, name) ? (files[name] as Uint8Array) : null;

  const exact = at(path);
  if (exact !== null) return { kind: "found", path, bytes: exact };
  for (const ext of IMAGE_EXTENSIONS) {
    const bytes = at(path + ext);
    if (bytes !== null) return { kind: "found", path: path + ext, bytes };
  }
  for (const { ext, format } of KNOWN_UNSUPPORTED_EXTENSIONS) {
    if (at(path + ext) !== null) return { kind: "unsupported", path: path + ext, format };
  }
  return { kind: "missing" };
}

/**
 * The sizing keys, in LaTeX's order of precedence: `width`/`height` win over
 * `scale`, one of the two alone scales the other to keep the aspect ratio, and
 * neither means the intrinsic size.
 *
 * `null` when the answer is not a pair of positive, finite lengths — a
 * `scale=0`, a `width=-1in`, a `width=0.5\textwidth` on a page design whose
 * `\textwidth` came out zero. Placing a zero-width picture would make the
 * figure silently vanish, which is the one outcome D38 rules out.
 */
export function placedImageSize(
  decoded: DecodedImage,
  sizing: ImageSizing,
  ctx: LengthContext,
): { width: number; height: number } | null {
  const intrinsicW = decoded.width;
  const intrinsicH = decoded.height;
  let width: number | null = null;
  let height: number | null = null;

  if (sizing.width !== null || sizing.height !== null) {
    // `scale=` beside either of these is ignored, as `graphicx` ignores it. The
    // clash is already a warning where the keys are read (`doc/build.ts`), so
    // it is not reported a second time here.
    width = sizing.width === null ? null : resolveDocumentLength(sizing.width, ctx);
    height = sizing.height === null ? null : resolveDocumentLength(sizing.height, ctx);
    if (width !== null && height === null) height = (width * intrinsicH) / intrinsicW;
    else if (height !== null && width === null) width = (height * intrinsicW) / intrinsicH;
  } else if (sizing.scale !== null) {
    width = intrinsicW * sizing.scale;
    height = intrinsicH * sizing.scale;
  } else {
    width = intrinsicW;
    height = intrinsicH;
  }

  if (width === null || height === null) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// Decode — bytes to an intrinsic size
// ---------------------------------------------------------------------------

/**
 * **THE OTHER HALF OF THE SEAM**, split out because `pdf/render.ts` needs it
 * too: bytes in, intrinsic size out, with no page design involved.
 *
 * Diagnostics are attributed to the *image* file, whole-file, because that is
 * the only position this function knows; every message names `path`, and
 * `placeImage` re-homes them onto the `\includegraphics` line. Returns `null`
 * after reporting an error; never throws.
 */
export function decodeImage(
  bytes: Uint8Array,
  path: string,
  diagnostics: Diagnostic[],
): DecodedImage | null {
  const at = wholeFile(path);
  const signature = sniff(bytes);

  switch (signature.kind) {
    case "png":
      return decodePng(bytes, path, diagnostics);
    case "jpeg":
      return decodeJpeg(bytes, path, diagnostics);
    case "empty":
      diagnostics.push(error("syntax", at, `\`${path}\` is empty — there are no image bytes to read`));
      return null;
    case "unknown":
      diagnostics.push(
        error(
          "syntax",
          at,
          `\`${path}\` is not a PNG or a JPEG: its first bytes match no image format this engine recognises, so it is either corrupt or not an image`,
        ),
      );
      return null;
    case "other":
      diagnostics.push(
        unsupported(
          at,
          "\\includegraphics",
          `\`${path}\` is ${signature.format}; only PNG and JPEG are implemented`,
        ),
      );
      return null;
  }
}

/** What a file's leading bytes say it is. */
type Sniffed =
  | { kind: ImageFormat }
  | { kind: "empty" }
  | { kind: "unknown" }
  /** A format this engine recognises only in order to refuse it by name. */
  | { kind: "other"; format: string };

/**
 * **The signature decides the format, not the extension** — a JPEG saved as `plot.png` is embedded correctly, and a
 * `.png` holding an HTML error page is reported as not-an-image rather than as
 * a corrupt PNG.
 */
function sniff(bytes: Uint8Array): Sniffed {
  const other = (format: string): Sniffed => ({ kind: "other", format });
  if (bytes.length === 0) return { kind: "empty" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "png" };
  // Any JPEG interchange stream starts SOI; the third byte is the first marker.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "jpeg" };
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return other("PDF");
  // `%!PS`, and the binary DOS EPS wrapper that carries a PostScript section.
  if (startsWith(bytes, [0x25, 0x21, 0x50, 0x53])) return other("PostScript or EPS");
  if (startsWith(bytes, [0xc5, 0xd0, 0xd3, 0xc6])) return other("EPS");
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return other("GIF");
  if (startsWith(bytes, [0x42, 0x4d])) return other("BMP");
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return other("TIFF");
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return other("WebP");
  }
  // SVG is XML, so it has no fixed signature: an `<?xml` prologue, an optional
  // doctype and any amount of whitespace or comments can precede `<svg`. The
  // leading text is enough to tell it from a raster file.
  const head = asciiHead(bytes, 512);
  if (/^\s*(?:<\?xml|<!DOCTYPE\s+svg|<svg)/i.test(head)) return other("SVG");
  return { kind: "unknown" };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** The first bytes as Latin-1 text, for the one format that has no signature. */
function asciiHead(bytes: Uint8Array, limit: number): string {
  let out = "";
  for (let i = 0; i < Math.min(limit, bytes.length); i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** Big-endian, by multiplication: `a << 24` is negative once `a >= 128`. */
function readU32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] as number) * 0x1000000 +
    (bytes[at + 1] as number) * 0x10000 +
    (bytes[at + 2] as number) * 0x100 +
    (bytes[at + 3] as number)
  );
}

function readU16(bytes: Uint8Array, at: number): number {
  return (bytes[at] as number) * 0x100 + (bytes[at + 1] as number);
}

// --- PNG --------------------------------------------------------------------

/** PNG colour types, from the format's own numbering (IHDR byte 9). */
const PNG_GREY = 0;
const PNG_RGB = 2;
const PNG_PALETTE = 3;
const PNG_GREY_ALPHA = 4;
const PNG_RGBA = 6;

/** Samples per pixel for each colour type. Palette indices count as one. */
function pngChannels(colorType: number): number {
  switch (colorType) {
    case PNG_GREY:
    case PNG_PALETTE:
      return 1;
    case PNG_RGB:
      return 3;
    case PNG_GREY_ALPHA:
      return 2;
    case PNG_RGBA:
      return 4;
    default:
      return 0;
  }
}

/** A PNG's header and the chunks that matter, gathered in one pass. */
interface PngFile {
  pixelWidth: number;
  pixelHeight: number;
  bitDepth: number;
  colorType: number;
  /** Concatenated `IDAT` data — zlib, with a filter byte before each scanline. */
  idat: Uint8Array;
  /** `PLTE`, for colour type 3. */
  palette: Uint8Array | null;
  /** Dots per inch from `pHYs`, or `null` when the file declares none. */
  dpiX: number | null;
  dpiY: number | null;
}

function decodePng(bytes: Uint8Array, path: string, diagnostics: Diagnostic[]): DecodedImage | null {
  const png = readPng(bytes, path, diagnostics);
  if (png === null) return null;
  const dpiX = png.dpiX ?? DEFAULT_DPI;
  const dpiY = png.dpiY ?? DEFAULT_DPI;
  return {
    format: "png",
    width: (png.pixelWidth * 72) / dpiX,
    height: (png.pixelHeight * 72) / dpiY,
    pixelWidth: png.pixelWidth,
    pixelHeight: png.pixelHeight,
    bytes,
  };
}

/**
 * The chunk walk. Every chunk's **CRC is verified**, which is what makes
 * "corrupt" a real answer rather than a hope: colour types 0/2/3 are embedded
 * without ever being decoded, so a bit-flip inside `IDAT` would otherwise reach
 * a reader as a broken picture with nothing anywhere saying why.
 */
function readPng(bytes: Uint8Array, path: string, diagnostics: Diagnostic[]): PngFile | null {
  const at = wholeFile(path);
  const corrupt = (detail: string): null => {
    diagnostics.push(error("syntax", at, `\`${path}\` is not a readable PNG — ${detail}`));
    return null;
  };

  let header: { width: number; height: number; bitDepth: number; colorType: number } | null = null;
  let palette: Uint8Array | null = null;
  let dpiX: number | null = null;
  let dpiY: number | null = null;
  let sawTransparency = false;
  let sawEnd = false;
  const idatParts: Uint8Array[] = [];
  let idatLength = 0;

  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      return corrupt(`a chunk header at byte ${offset} runs past the end of the ${bytes.length}-byte file`);
    }
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      return corrupt(
        `the chunk at byte ${offset} declares ${length} bytes of data, which runs past the end of the ${bytes.length}-byte file (the file is truncated)`,
      );
    }
    const type = asciiHead(bytes.subarray(offset + 4, offset + 8), 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const declared = readU32(bytes, offset + 8 + length);
    const actual = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (declared !== actual) {
      return corrupt(
        `the ${type} chunk at byte ${offset} fails its checksum (the file declares ${declared}, its bytes give ${actual}), so the image data is damaged`,
      );
    }

    if (type === "IHDR") {
      if (length !== 13) return corrupt(`its IHDR chunk is ${length} bytes rather than 13`);
      const width = readU32(data, 0);
      const height = readU32(data, 4);
      const bitDepth = data[8] as number;
      const colorType = data[9] as number;
      const compression = data[10] as number;
      const filterMethod = data[11] as number;
      const interlace = data[12] as number;
      if (width === 0 || height === 0) return corrupt(`it declares a ${width}x${height} pixel grid`);
      if (width * height > MAX_IMAGE_PIXELS) {
        diagnostics.push(
          error(
            "limit-exceeded",
            at,
            `\`${path}\` declares a ${width}x${height} pixel grid, over the ${MAX_IMAGE_PIXELS}-pixel cap this engine will place`,
          ),
        );
        return null;
      }
      if (pngChannels(colorType) === 0) return corrupt(`colour type ${colorType} is not one the format defines`);
      if (!isValidPngBitDepth(colorType, bitDepth)) {
        return corrupt(`bit depth ${bitDepth} is not one the format allows for colour type ${colorType}`);
      }
      if (compression !== 0) return corrupt(`compression method ${compression} is not the deflate the format defines`);
      if (filterMethod !== 0) return corrupt(`filter method ${filterMethod} is not the one the format defines`);
      if (interlace !== 0) {
        diagnostics.push(
          unsupported(
            at,
            "\\includegraphics",
            `\`${path}\` is an interlaced (Adam7) PNG, which this engine does not implement; save it without interlacing`,
          ),
        );
        return null;
      }
      header = { width, height, bitDepth, colorType };
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      sawTransparency = true;
    } else if (type === "pHYs") {
      if (length !== 9) return corrupt(`its pHYs chunk is ${length} bytes rather than 9`);
      // Unit 1 is metres; unit 0 declares a pixel *aspect ratio* only and says
      // nothing about physical size, so it leaves the default 72 dpi standing.
      if (data[8] === 1) {
        const ppmX = readU32(data, 0);
        const ppmY = readU32(data, 4);
        if (ppmX > 0) dpiX = ppmX / METRE_IN_INCHES;
        if (ppmY > 0) dpiY = ppmY / METRE_IN_INCHES;
      }
    } else if (type === "IDAT") {
      idatParts.push(data);
      idatLength += data.length;
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }

    offset = end;
  }

  if (header === null) return corrupt("it has no IHDR chunk");
  if (idatParts.length === 0) return corrupt("it has no IDAT chunk, so it carries no image data");
  // An `IEND` is how a PNG says it is complete. A file cut off at a chunk
  // boundary passes every check above, so this is the one that catches it.
  if (!sawEnd) return corrupt("it has no IEND chunk (the file is truncated)");
  if (header.colorType === PNG_PALETTE && palette === null) {
    return corrupt("it is a palette image with no PLTE chunk");
  }

  if (sawTransparency) {
    // PDF's `/SMask` is a full alpha *image*; `tRNS` is either one transparent
    // colour (types 0 and 2) or a per-palette-entry alpha table (type 3).
    // Neither maps onto a `/Decode` array, and honouring them means synthesising
    // a mask from decoded pixels — which is real work with a real chance of
    // being quietly wrong, so it is refused rather than dropped.
    diagnostics.push(
      unsupported(
        at,
        "\\includegraphics",
        `\`${path}\` carries a tRNS transparency chunk, which this engine does not implement; save it as RGBA (PNG colour type 6) if the transparency matters, or without transparency if it does not`,
      ),
    );
    return null;
  }
  if (
    (header.colorType === PNG_GREY_ALPHA || header.colorType === PNG_RGBA) &&
    header.bitDepth !== 8 &&
    header.bitDepth !== 16
  ) {
    diagnostics.push(
      unsupported(
        at,
        "\\includegraphics",
        `\`${path}\` has an alpha channel at ${header.bitDepth} bits per sample; this engine splits alpha out at 8 or 16 bits only`,
      ),
    );
    return null;
  }

  return {
    pixelWidth: header.width,
    pixelHeight: header.height,
    bitDepth: header.bitDepth,
    colorType: header.colorType,
    idat: concat(idatParts, idatLength),
    palette,
    dpiX,
    dpiY,
  };
}

/** Table 11.1 of the PNG specification: which depths each colour type allows. */
function isValidPngBitDepth(colorType: number, bitDepth: number): boolean {
  switch (colorType) {
    case PNG_GREY:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
    case PNG_PALETTE:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
    default:
      return bitDepth === 8 || bitDepth === 16;
  }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * PNG's CRC-32 (the IEEE polynomial, reflected), built once on first use.
 *
 * Written out rather than taken from a library because the engine has no
 * runtime dependency to take it from, and because it is nine lines.
 */
let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crcTable[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- JPEG -------------------------------------------------------------------

/**
 * The `SOF` markers, by what PDF can do with them. `DCTDecode` is specified for
 * the sequential Huffman modes; everything else is a datastream a reader is
 * entitled to reject, so it is named rather than embedded and hoped for.
 */
const JPEG_SUPPORTED_SOF: Readonly<Record<number, string>> = { 0xc0: "baseline", 0xc1: "extended sequential" };
const JPEG_OTHER_SOF: Readonly<Record<number, string>> = {
  0xc2: "progressive",
  0xc3: "lossless",
  0xc5: "differential sequential",
  0xc6: "differential progressive",
  0xc7: "differential lossless",
  0xc9: "arithmetic-coded extended sequential",
  0xca: "arithmetic-coded progressive",
  0xcb: "arithmetic-coded lossless",
  0xcd: "arithmetic-coded differential sequential",
  0xce: "arithmetic-coded differential progressive",
  0xcf: "arithmetic-coded differential lossless",
};

/** What the marker walk found. */
interface JpegFile {
  pixelWidth: number;
  pixelHeight: number;
  components: number;
  precision: number;
  dpiX: number;
  dpiY: number;
}

function decodeJpeg(bytes: Uint8Array, path: string, diagnostics: Diagnostic[]): DecodedImage | null {
  const jpeg = readJpeg(bytes, path, diagnostics);
  if (jpeg === null) return null;
  return {
    format: "jpeg",
    width: (jpeg.pixelWidth * 72) / jpeg.dpiX,
    height: (jpeg.pixelHeight * 72) / jpeg.dpiY,
    pixelWidth: jpeg.pixelWidth,
    pixelHeight: jpeg.pixelHeight,
    bytes,
  };
}

function readJpeg(bytes: Uint8Array, path: string, diagnostics: Diagnostic[]): JpegFile | null {
  const at = wholeFile(path);
  const corrupt = (detail: string): null => {
    diagnostics.push(error("syntax", at, `\`${path}\` is not a readable JPEG — ${detail}`));
    return null;
  };

  let sof: { marker: number; precision: number; height: number; width: number; components: number } | null = null;
  let jfif: { dpiX: number; dpiY: number } | null = null;
  let exif: { dpiX: number; dpiY: number } | null = null;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    // Any number of `0xFF` fill bytes may precede a marker.
    if (bytes[offset] !== 0xff) return corrupt(`the byte at ${offset} is not the 0xFF a marker must start with`);
    let marker = bytes[offset + 1] as number;
    offset += 2;
    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset] as number;
      offset += 1;
    }
    // Standalone markers: `TEM`, the restart markers, `SOI` and `EOI` carry no
    // segment, so there is no length to skip.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) continue;
    if (marker === 0xd9) break;
    if (offset + 2 > bytes.length) return corrupt(`the segment at byte ${offset} has no length (the file is truncated)`);
    const length = readU16(bytes, offset);
    if (length < 2) return corrupt(`the segment at byte ${offset} declares a ${length}-byte length`);
    if (offset + length > bytes.length) {
      return corrupt(
        `the segment at byte ${offset} declares ${length} bytes, which runs past the end of the ${bytes.length}-byte file (the file is truncated)`,
      );
    }
    const data = bytes.subarray(offset + 2, offset + length);

    if (marker === 0xe0) jfif = jfif ?? readJfifDensity(data);
    else if (marker === 0xe1) exif = exif ?? readExifDensity(data);
    else if (JPEG_SUPPORTED_SOF[marker] !== undefined || JPEG_OTHER_SOF[marker] !== undefined) {
      if (data.length < 6) return corrupt(`its SOF segment is ${data.length} bytes, too short to hold a frame header`);
      sof = {
        marker,
        precision: data[0] as number,
        height: readU16(data, 1),
        width: readU16(data, 3),
        components: data[5] as number,
      };
      // Metadata can follow the frame header (`APP` segments after `SOF` are
      // legal), so the walk continues — but the frame is what it was after.
      if (JPEG_OTHER_SOF[marker] !== undefined) break;
    } else if (marker === 0xda) {
      // Entropy-coded data follows, which is not marker-structured; nothing
      // after this point is worth walking.
      break;
    }

    offset += length;
  }

  if (sof === null) return corrupt("it has no SOF segment, so it declares no image size (the file is truncated)");
  const other = JPEG_OTHER_SOF[sof.marker];
  if (other !== undefined) {
    diagnostics.push(
      unsupported(
        at,
        "\\includegraphics",
        `\`${path}\` is a ${other} JPEG; PDF's DCTDecode filter is specified for the sequential Huffman modes, so save it as a baseline JPEG`,
      ),
    );
    return null;
  }
  if (sof.width === 0 || sof.height === 0) return corrupt(`it declares a ${sof.width}x${sof.height} pixel grid`);
  if (sof.width * sof.height > MAX_IMAGE_PIXELS) {
    diagnostics.push(
      error(
        "limit-exceeded",
        at,
        `\`${path}\` declares a ${sof.width}x${sof.height} pixel grid, over the ${MAX_IMAGE_PIXELS}-pixel cap this engine will place`,
      ),
    );
    return null;
  }
  if (sof.precision !== 8) {
    diagnostics.push(
      unsupported(
        at,
        "\\includegraphics",
        `\`${path}\` stores ${sof.precision} bits per component; this engine embeds 8-bit JPEG data only`,
      ),
    );
    return null;
  }
  if (sof.components === 4) {
    diagnostics.push(
      unsupported(
        at,
        "\\includegraphics",
        `\`${path}\` is a CMYK (4-component) JPEG; whether its samples are inverted depends on the Adobe APP14 marker, and guessing wrong inverts every colour in the figure — convert it to RGB`,
      ),
    );
    return null;
  }
  if (sof.components !== 1 && sof.components !== 3) {
    diagnostics.push(
      unsupported(
        at,
        "\\includegraphics",
        `\`${path}\` has ${sof.components} colour components; this engine embeds 1-component (grey) and 3-component (colour) JPEG data`,
      ),
    );
    return null;
  }
  // A JPEG has no per-segment checksum, so a truncated one is only detectable
  // structurally. `EOI` is how the datastream says it is complete; searching for
  // it rather than requiring it at the very end tolerates the trailing bytes
  // some cameras and editors append.
  if (!hasJpegEnd(bytes)) {
    return corrupt("it has no EOI marker, so the compressed data is incomplete (the file is truncated)");
  }

  const density = chooseJpegDensity(jfif, exif, path, diagnostics);
  return {
    pixelWidth: sof.width,
    pixelHeight: sof.height,
    components: sof.components,
    precision: sof.precision,
    dpiX: density.dpiX,
    dpiY: density.dpiY,
  };
}

function hasJpegEnd(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 2; i >= 2; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return true;
  }
  return false;
}

/**
 * JFIF wins where both are present, because it is the density field of the JPEG
 * interchange format itself and it is what `pdftex` — the reference for what
 * `\includegraphics{plot.jpg}` comes out sized as — reads. A disagreement is an
 * `info` rather than a silent choice: a figure that comes out half the expected
 * size then has a trail leading to the file's own contradictory metadata.
 */
function chooseJpegDensity(
  jfif: { dpiX: number; dpiY: number } | null,
  exif: { dpiX: number; dpiY: number } | null,
  path: string,
  diagnostics: Diagnostic[],
): { dpiX: number; dpiY: number } {
  if (jfif !== null && exif !== null && !sameDensity(jfif, exif)) {
    diagnostics.push(
      diagnostic(
        "info",
        "syntax",
        wholeFile(path),
        `\`${path}\` declares two different resolutions — ${density(jfif)} in its JFIF header and ${density(exif)} in its Exif metadata; the JFIF one is used, so the figure may not be the size the Exif value implies`,
      ),
    );
  }
  return jfif ?? exif ?? { dpiX: DEFAULT_DPI, dpiY: DEFAULT_DPI };
}

function sameDensity(a: { dpiX: number; dpiY: number }, b: { dpiX: number; dpiY: number }): boolean {
  // A tolerance, because both sides are often the same intent rounded twice:
  // 11811 pixels per metre and 300 dpi are the same 300 dpi.
  return Math.abs(a.dpiX - b.dpiX) < 0.5 && Math.abs(a.dpiY - b.dpiY) < 0.5;
}

function density(d: { dpiX: number; dpiY: number }): string {
  const round = (v: number): string => String(Math.round(v * 100) / 100);
  return d.dpiX === d.dpiY ? `${round(d.dpiX)} dpi` : `${round(d.dpiX)}x${round(d.dpiY)} dpi`;
}

/**
 * `APP0`: `"JFIF\0"`, version (2), density units (1), X and Y density (2 each).
 * Units 1 is dots per inch and 2 is dots per centimetre; units 0 declares a
 * pixel aspect ratio and no physical size at all.
 */
function readJfifDensity(data: Uint8Array): { dpiX: number; dpiY: number } | null {
  if (data.length < 12) return null;
  if (!startsWith(data, [0x4a, 0x46, 0x49, 0x46, 0x00])) return null;
  const units = data[7] as number;
  const x = readU16(data, 8);
  const y = readU16(data, 10);
  if (x === 0 || y === 0) return null;
  if (units === 1) return { dpiX: x, dpiY: y };
  if (units === 2) return { dpiX: x * 2.54, dpiY: y * 2.54 };
  return null;
}

/**
 * `APP1`: `"Exif\0\0"` then a TIFF header — byte order, magic, the offset of
 * IFD0 — and IFD0's entries, of which three matter: `XResolution` (0x011A) and
 * `YResolution` (0x011B), both RATIONAL, and `ResolutionUnit` (0x0128), where 2
 * is inches and 3 centimetres.
 *
 * Only IFD0 is read. A `ResolutionUnit` of 1 ("none") is a ratio rather than a
 * density, exactly like JFIF's units 0, and yields nothing.
 */
function readExifDensity(data: Uint8Array): { dpiX: number; dpiY: number } | null {
  if (data.length < 14) return null;
  if (!startsWith(data, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00])) return null;
  const tiff = data.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (at: number): number =>
    little ? (tiff[at] as number) + (tiff[at + 1] as number) * 0x100 : readU16(tiff, at);
  const u32 = (at: number): number =>
    little
      ? (tiff[at] as number) +
        (tiff[at + 1] as number) * 0x100 +
        (tiff[at + 2] as number) * 0x10000 +
        (tiff[at + 3] as number) * 0x1000000
      : readU32(tiff, at);

  if (u16(2) !== 0x2a) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  let xNumerator: number | null = null;
  let xDenominator = 1;
  let yNumerator: number | null = null;
  let yDenominator = 1;
  let unit = 2;

  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    const tag = u16(entry);
    const type = u16(entry + 2);
    if (tag === 0x0128 && type === 3) {
      unit = u16(entry + 8);
      continue;
    }
    if (tag !== 0x011a && tag !== 0x011b) continue;
    // RATIONAL: two 32-bit values, always out of line because they need 8 bytes.
    if (type !== 5) continue;
    const value = u32(entry + 8);
    if (value + 8 > tiff.length) return null;
    if (tag === 0x011a) {
      xNumerator = u32(value);
      xDenominator = u32(value + 4);
    } else {
      yNumerator = u32(value);
      yDenominator = u32(value + 4);
    }
  }

  if (xNumerator === null || yNumerator === null) return null;
  if (xDenominator === 0 || yDenominator === 0) return null;
  const perUnitX = xNumerator / xDenominator;
  const perUnitY = yNumerator / yDenominator;
  if (perUnitX <= 0 || perUnitY <= 0) return null;
  if (unit === 3) return { dpiX: perUnitX * 2.54, dpiY: perUnitY * 2.54 };
  if (unit === 2) return { dpiX: perUnitX, dpiY: perUnitY };
  return null;
}

// ---------------------------------------------------------------------------
// Embedding — the description `pdf/render.ts` turns into an XObject
// ---------------------------------------------------------------------------

/** A PDF image colour space, as far as this engine emits them. */
export type ImageColorSpace =
  | { kind: "device"; name: "DeviceGray" | "DeviceRGB" }
  /** `[/Indexed /DeviceRGB hival <lookup>]` — a PNG's `PLTE` table. */
  | { kind: "indexed"; hival: number; lookup: Uint8Array };

/** `/DecodeParms` for data that is still carrying PNG's scanline predictors. */
export interface PngPredictor {
  colors: number;
  bitsPerComponent: number;
  columns: number;
}

/**
 * One PDF image `XObject`, described without a single PDF object — so the
 * format knowledge lives here and the object graph lives in `pdf/render.ts`.
 */
export interface ImageStream {
  /** `/Width` and `/Height`, in samples. */
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: ImageColorSpace;
  data: Uint8Array;
  /**
   * `/Filter`. `null` means `data` is raw samples and the writer may compress
   * it however it likes — the only case is a PNG whose alpha had to be split
   * out, because that path has already inflated the data.
   */
  filter: "DCTDecode" | "FlateDecode" | null;
  decodeParms: PngPredictor | null;
  /** `/SMask`: the alpha channel, as its own single-channel image. */
  smask: ImageStream | null;
}

/**
 * zlib inflate, injected. `pdf/render.ts` supplies pdf-lib's — the engine has
 * no compression code of its own and this file will not grow any, and taking it
 * as a parameter is also what keeps pdf-lib out of the *layout* import graph.
 */
export type Inflate = (data: Uint8Array) => Uint8Array;

/**
 * The `XObject` for a decoded image.
 *
 * Only ever called with an image `decodeImage` accepted, so anything
 * unrepresentable here is an engine bug rather than a bad document: it throws,
 * and `renderPdf`'s catch turns it into an `internal` diagnostic. That is the
 * right split — a document's fault is a diagnostic at layout time with a line
 * number, and a fault of ours is not something to paper over at emission time.
 */
export function imageStream(image: DecodedImage, inflate: Inflate): ImageStream {
  if (image.format === "jpeg") return jpegStream(image);
  return pngStream(image, inflate);
}

function jpegStream(image: DecodedImage): ImageStream {
  const jpeg = readJpeg(image.bytes, "", []);
  if (jpeg === null) throw new Error("a JPEG that decoded for layout no longer parses for emission");
  return {
    width: jpeg.pixelWidth,
    height: jpeg.pixelHeight,
    bitsPerComponent: 8,
    // YCbCr is what a 3-component JFIF stream holds, and `DCTDecode` converts
    // it to RGB itself; the colour space names what comes *out* of the filter.
    colorSpace: { kind: "device", name: jpeg.components === 1 ? "DeviceGray" : "DeviceRGB" },
    // A PDF image stream with `/DCTDecode` *is* a JPEG datastream, so the file's
    // own bytes go in untouched: no decode, no recompression, no quality lost.
    data: image.bytes,
    filter: "DCTDecode",
    decodeParms: null,
    smask: null,
  };
}

function pngStream(image: DecodedImage, inflate: Inflate): ImageStream {
  const png = readPng(image.bytes, "", []);
  if (png === null) throw new Error("a PNG that decoded for layout no longer parses for emission");
  const channels = pngChannels(png.colorType);

  if (png.colorType === PNG_GREY_ALPHA || png.colorType === PNG_RGBA) {
    return splitPngAlpha(png, channels, inflate);
  }

  // The verbatim path. PDF's `/Predictor 15` is PNG's per-scanline filtering,
  // by construction — the PDF specification took it from PNG — so the zlib
  // stream in `IDAT` is exactly what a `/FlateDecode` image stream wants, filter
  // bytes and all. Nothing is decoded, nothing is recompressed.
  return {
    width: png.pixelWidth,
    height: png.pixelHeight,
    bitsPerComponent: png.bitDepth,
    colorSpace:
      png.colorType === PNG_PALETTE
        ? {
            kind: "indexed",
            // `hival` is the largest index, so a 4-entry palette gives 3.
            hival: Math.max(0, Math.floor((png.palette as Uint8Array).length / 3) - 1),
            lookup: png.palette as Uint8Array,
          }
        : { kind: "device", name: png.colorType === PNG_GREY ? "DeviceGray" : "DeviceRGB" },
    data: png.idat,
    filter: "FlateDecode",
    decodeParms: { colors: channels, bitsPerComponent: png.bitDepth, columns: png.pixelWidth },
    smask: null,
  };
}

/**
 * Colour types 4 and 6: inflate, undo the scanline filters, and deinterleave.
 *
 * PDF has no interleaved alpha channel — transparency is a separate
 * single-channel `/SMask` image — so this is the one PNG that cannot be handed
 * over as it arrived. The samples come out unfiltered and uncompressed; the
 * writer flates them again.
 */
function splitPngAlpha(png: PngFile, channels: number, inflate: Inflate): ImageStream {
  const sampleBytes = png.bitDepth / 8;
  const bytesPerPixel = channels * sampleBytes;
  const stride = png.pixelWidth * bytesPerPixel;
  const raw = inflate(png.idat);
  const expected = png.pixelHeight * (stride + 1);
  if (raw.length < expected) {
    throw new Error(
      `\`IDAT\` inflated to ${raw.length} bytes where ${expected} were needed for a ${png.pixelWidth}x${png.pixelHeight} image`,
    );
  }
  const pixels = unfilterScanlines(raw, png.pixelWidth, png.pixelHeight, bytesPerPixel);

  const colorChannels = channels - 1;
  const colorBytes = colorChannels * sampleBytes;
  const pixelCount = png.pixelWidth * png.pixelHeight;
  const color = new Uint8Array(pixelCount * colorBytes);
  const alpha = new Uint8Array(pixelCount * sampleBytes);
  for (let i = 0; i < pixelCount; i++) {
    const from = i * bytesPerPixel;
    for (let b = 0; b < colorBytes; b++) color[i * colorBytes + b] = pixels[from + b] as number;
    for (let b = 0; b < sampleBytes; b++) alpha[i * sampleBytes + b] = pixels[from + colorBytes + b] as number;
  }

  const mask: ImageStream = {
    width: png.pixelWidth,
    height: png.pixelHeight,
    bitsPerComponent: png.bitDepth,
    colorSpace: { kind: "device", name: "DeviceGray" },
    data: alpha,
    filter: null,
    decodeParms: null,
    smask: null,
  };
  return {
    width: png.pixelWidth,
    height: png.pixelHeight,
    bitsPerComponent: png.bitDepth,
    colorSpace: { kind: "device", name: colorChannels === 1 ? "DeviceGray" : "DeviceRGB" },
    data: color,
    filter: null,
    decodeParms: null,
    smask: mask,
  };
}

/**
 * PNG's five scanline filters (specification chapter 9), undone in place into a
 * fresh buffer of `height * stride` bytes with the filter bytes dropped.
 *
 * `a` is the pixel to the left, `b` the one above, `c` the one above-left; all
 * three are zero outside the image. The arithmetic is deliberately per-byte and
 * modulo 256 — that is how the filters are defined, and it is why a 16-bit
 * image needs no separate case here.
 */
export function unfilterScanlines(
  raw: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(height * stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at] as number;
    at += 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[at + x] as number;
      const a = x >= bytesPerPixel ? (out[row + x - bytesPerPixel] as number) : 0;
      const b = y > 0 ? (out[previous + x] as number) : 0;
      const c = y > 0 && x >= bytesPerPixel ? (out[previous + x - bytesPerPixel] as number) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4:
          restored = value + paeth(a, b, c);
          break;
        default:
          // Unreachable for a CRC-verified PNG: the filter byte is part of the
          // checksummed `IDAT` data and the format defines only 0 to 4.
          throw new Error(`PNG scanline filter ${filter} is not one the format defines`);
      }
      out[row + x] = restored & 0xff;
    }
    at += stride;
  }
  return out;
}

/** PNG's Paeth predictor: whichever of `a`, `b`, `c` is nearest `a + b - c`. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
