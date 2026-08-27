import { PDFContext, PDFHexString, PDFRawStream, PDFString, decodePDFRawStream } from "pdf-lib";
import type { PDFObject, PDFRef } from "pdf-lib";
import type { Diagnostic } from "@ebook-reader/shared";
import type { FontHandle } from "../font/handle.ts";
import type { DecodedImage, ImageStream } from "../image/index.ts";
import { imageStream } from "../image/index.ts";
import type { Page, PlacedImage } from "../layout/page.ts";
import type { SourceRef } from "../diagnostics.ts";
import { error, hasErrors, internalError, wholeFile } from "../diagnostics.ts";
import { buildPageContent } from "./content.ts";
import type { FontRegistry, ImageRegistry } from "./content.ts";
import { roundToOutput, toGlyphSpace } from "./numbers.ts";
import {
  baseFontName,
  createFontSubset,
  fontBBox,
  fontFlags,
  isCFF,
  serializeSubset,
  subsetFingerprint,
  toUnicodeCMapFor,
  widthsArray,
} from "./subset.ts";
import type { FontSubset } from "./subset.ts";
import { documentId, planSerialization, writeDocument } from "./serialize.ts";

/**
 * PDF emission: positioned pages in, bytes out.
 *
 * This is the bottom of the engine. It does no layout, no measurement and no
 * I/O — it receives `Page`s whose every coordinate is already decided and turns
 * them into a PDF 1.7 file with each face embedded as a subset.
 *
 * **It never throws.** `compile()` has a catch-all above it, but relying on that
 * would report an emission failure as an anonymous engine bug; failures are
 * turned into diagnostics here, where there is enough context to name what went
 * wrong. `pdf` is `null` whenever an error-severity diagnostic was produced.
 *
 * **It is deterministic.** The same `Page[]` produces byte-identical output on
 * every run and every machine. That is a requirement, not a nicety — it is what
 * lets a test assert on bytes at all. Three things had to be pinned for it:
 * no creation date (see `creationDate`), a `/ID` hashed from content rather
 * than from a clock (`serialize.ts`), and subset tags derived from a font's
 * position in the document rather than from pdf-lib's random suffix
 * (`subset.ts`).
 */

export interface RenderPdfOptions {
  /**
   * Project-relative path diagnostics are attributed to — the entrypoint, as
   * far as a reader is concerned. Emission failures have no single source line,
   * so they are reported against the file as a whole.
   */
  file?: string;
  /** Reject rather than allocate above this size. Unset means no cap. */
  maxOutputBytes?: number;
  /** `/Producer`. */
  producer?: string;
  /** `/Title`. Omitted when unset. */
  title?: string;
  /**
   * `/CreationDate`, as a PDF date string (`D:YYYYMMDDHHmmSSZ`). **Omitted by
   * default, and that is deliberate**: a clock read here would make the output
   * unreproducible, so a caller that wants a date must supply one it chose.
   */
  creationDate?: string;
  /**
   * Flate-compress content and CMap streams. On by default; tests turn it off
   * to read the operators back out of the file.
   */
  compressStreams?: boolean;
}

export interface RenderPdfResult {
  /** `null` whenever `diagnostics` contains an error. */
  pdf: Uint8Array | null;
  diagnostics: Diagnostic[];
}

const DEFAULT_PRODUCER = "Atrium typesetting engine";

/**
 * pdf-lib's `PDFContext.obj` accepts a plain object literal and converts it, but
 * the shape it accepts is not exported. This is the same type, written out, so
 * that a dictionary can be assembled in a variable before being handed over
 * rather than having to be one expression.
 */
type PdfValue = PdfDict | PdfList | PDFObject | string | number | boolean | null | undefined;
interface PdfDict {
  [key: string]: PdfValue;
}
type PdfList = PdfValue[];

export function renderPdf(pages: readonly Page[], options: RenderPdfOptions = {}): RenderPdfResult {
  const at = wholeFile(options.file ?? "");
  try {
    return emit(pages, options, at);
  } catch (cause) {
    return { pdf: null, diagnostics: [internalError(at.file, cause)] };
  }
}

/** Faces used by the document, in first-use order, parsed once each. */
function collectFonts(pages: readonly Page[], at: SourceRef): {
  subsets: FontSubset[];
  registry: FontRegistry;
  diagnostics: Diagnostic[];
} {
  const subsets: FontSubset[] = [];
  const diagnostics: Diagnostic[] = [];
  // Keyed by `FontHandle.id` rather than by object identity: the id is the
  // stable name of a face, and two providers handing out separate handles for
  // the same file must still produce one embedded font.
  const byId = new Map<string, FontSubset | null>();

  for (const page of pages) {
    for (const item of page.items) {
      if (item.kind !== "glyphrun") continue;
      if (byId.has(item.font.id)) continue;
      try {
        const subset = createFontSubset(item.font, subsets.length);
        subsets.push(subset);
        byId.set(item.font.id, subset);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        diagnostics.push(
          error("missing-font", at, `cannot embed the face \`${item.font.id}\` — ${detail}`),
        );
        // Remembered as failed so the same face is not retried once per run.
        byId.set(item.font.id, null);
      }
    }
  }

  const registry: FontRegistry = {
    use(handle: FontHandle): FontSubset {
      const subset = byId.get(handle.id);
      // Unreachable: a face that failed to parse produced an error diagnostic,
      // and emission stops before any content stream is built.
      if (!subset) throw new Error(`font \`${handle.id}\` was not collected before emission`);
      return subset;
    },
  };

  return { subsets, registry, diagnostics };
}

function embedFont(context: PDFContext, font: FontSubset, compress: boolean): PDFRef {
  const upem = font.handle.unitsPerEm;
  const cff = isCFF(font);
  const bytes = serializeSubset(font);
  const name = baseFontName(font);

  const fontFileRef = context.register(
    context.flateStream(
      bytes,
      cff
        ? { Subtype: "CIDFontType0C" }
        : // `Length1` is the uncompressed length, required for a TrueType-
          // flavoured font program and merely absent from pdf-lib's writer.
          { Length1: bytes.length },
    ),
  );

  const descriptor: PdfDict = {
    Type: "FontDescriptor",
    FontName: name,
    Flags: fontFlags(font),
    FontBBox: fontBBox(font).map(roundToOutput),
    ItalicAngle: roundToOutput(font.kitFont.italicAngle),
    Ascent: roundToOutput(toGlyphSpace(font.handle.ascent, upem)),
    // `FontHandle.descent` is positive-downwards; PDF wants it negative.
    Descent: roundToOutput(-toGlyphSpace(font.handle.descent, upem)),
    CapHeight: roundToOutput(toGlyphSpace(font.handle.capHeight, upem)),
    XHeight: roundToOutput(toGlyphSpace(font.handle.xHeight, upem)),
    // Nobody computes this honestly, including pdf-lib and pdfkit; a required
    // key with a value no reader consults.
    StemV: 0,
  };
  descriptor[cff ? "FontFile3" : "FontFile2"] = fontFileRef;
  const descriptorRef = context.register(context.obj(descriptor));

  const cidFont: PdfDict = {
    Type: "Font",
    Subtype: cff ? "CIDFontType0" : "CIDFontType2",
    BaseFont: name,
    CIDSystemInfo: {
      Registry: PDFString.of("Adobe"),
      Ordering: PDFString.of("Identity"),
      Supplement: 0,
    },
    FontDescriptor: descriptorRef,
    DW: 1000,
    W: widthsArray(font).map((entry) =>
      Array.isArray(entry) ? entry.map(roundToOutput) : entry,
    ),
  };
  // Meaningless for a CFF-flavoured CIDFont, whose charset already maps CID to
  // glyph; only Type2 needs to be told the mapping is the identity.
  if (!cff) cidFont.CIDToGIDMap = "Identity";
  const cidFontRef = context.register(context.obj(cidFont));

  const cmap = toUnicodeCMapFor(font);
  const toUnicodeRef = context.register(
    compress ? context.flateStream(cmap) : context.stream(cmap),
  );

  return context.register(
    context.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: name,
      Encoding: "Identity-H",
      DescendantFonts: [cidFontRef],
      ToUnicode: toUnicodeRef,
    }),
  );
}

/** An image the document places, and the resource name it is embedded under. */
interface EmbeddedImage {
  /** `/XObject` key on the shared resource dictionary — `Im0`, `Im1`, … */
  resourceName: string;
  /** The file-map key the bytes came from; the identity emission dedupes on. */
  path: string;
  image: DecodedImage;
}

/**
 * Images the document places, in first-use order, one entry per **path**.
 *
 * Deduplicating by path rather than by placement is the whole point: a logo on
 * every page is one set of bytes in the file and forty `Do` operators. Two
 * different files with identical bytes are two entries, which costs space no
 * real document notices and avoids hashing every image to find out.
 *
 * First-use order makes the resource names a function of the document rather
 * than of a hash-map iteration order, which is one of the things emission's
 * determinism rests on.
 */
function collectImages(pages: readonly Page[]): { entries: EmbeddedImage[]; registry: ImageRegistry } {
  const entries: EmbeddedImage[] = [];
  const byPath = new Map<string, EmbeddedImage>();
  for (const page of pages) {
    for (const item of page.items) {
      if (item.kind !== "image") continue;
      const placed: PlacedImage = item;
      if (byPath.has(placed.path)) continue;
      const entry: EmbeddedImage = {
        resourceName: `Im${entries.length}`,
        path: placed.path,
        image: placed.image,
      };
      entries.push(entry);
      byPath.set(placed.path, entry);
    }
  }
  return {
    entries,
    registry: {
      use(path: string): string | undefined {
        return byPath.get(path)?.resourceName;
      },
    },
  };
}

/**
 * zlib inflate, borrowed from pdf-lib rather than written here.
 *
 * pdf-lib's decompressor is reachable only through a stream object, so this
 * builds the smallest one that means "these bytes are Flate-encoded" and asks
 * for them back. It is not a hack for its own sake: the engine has no
 * compression code and is not going to grow any, and pdf-lib's is the same
 * implementation that compresses every other stream in the file.
 *
 * Only PNG colour types 4 and 6 (interleaved alpha) ever need it — see
 * `image/index.ts`'s `splitPngAlpha`.
 */
function inflate(context: PDFContext, data: Uint8Array): Uint8Array {
  const dict = context.obj({ Filter: "FlateDecode", Length: data.length });
  return decodePDFRawStream(PDFRawStream.of(dict, data)).decode();
}

/** `/ColorSpace`, as pdf-lib's object model wants it. */
function colorSpaceValue(stream: ImageStream): PdfValue {
  if (stream.colorSpace.kind === "device") return stream.colorSpace.name;
  // `[/Indexed /DeviceRGB hival <RGB triples>]`. The lookup table goes in as a
  // hex string rather than a stream because a palette is at most 768 bytes and
  // an inline string is one object fewer to write.
  return ["Indexed", "DeviceRGB", stream.colorSpace.hival, PDFHexString.of(toHex(stream.colorSpace.lookup))];
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
  return out;
}

/**
 * One image `XObject`, and its `/SMask` before it when the image has alpha.
 *
 * A JPEG and a non-alpha PNG arrive here **already compressed in a filter PDF
 * speaks** (`DCTDecode`, and `FlateDecode` with PNG's own scanline predictors),
 * so their bytes are written through untouched; only the split-alpha path hands
 * over raw samples for the writer to compress.
 */
function embedImageStream(context: PDFContext, stream: ImageStream, compress: boolean): PDFRef {
  const dict: PdfDict = {
    Type: "XObject",
    Subtype: "Image",
    Width: stream.width,
    Height: stream.height,
    BitsPerComponent: stream.bitsPerComponent,
    ColorSpace: colorSpaceValue(stream),
  };
  if (stream.smask !== null) dict.SMask = embedImageStream(context, stream.smask, compress);

  if (stream.filter === null) {
    // Raw samples. `compress` off is what lets a test read a content stream
    // back; an uncompressed image stream is equally valid, just larger.
    return context.register(
      compress ? context.flateStream(stream.data, dict) : context.stream(stream.data, dict),
    );
  }

  dict.Filter = stream.filter;
  if (stream.decodeParms !== null) {
    dict.DecodeParms = {
      // 15 is "PNG prediction, and the algorithm is per-scanline in the data".
      Predictor: 15,
      Colors: stream.decodeParms.colors,
      BitsPerComponent: stream.decodeParms.bitsPerComponent,
      Columns: stream.decodeParms.columns,
    };
  }
  return context.register(context.stream(stream.data, dict));
}

/**
 * What makes two documents differing only in an image get different `/ID`s.
 * The pixel grid and the byte length are enough to tell any two real figures
 * apart without hashing megabytes of pixels, and the `/ID` is a fingerprint
 * rather than a security claim.
 */
function imageFingerprint(entry: EmbeddedImage): string {
  const image = entry.image;
  return `${entry.resourceName}:${entry.path}:${image.format}:${image.pixelWidth}x${image.pixelHeight}:${image.bytes.length}`;
}

function emit(
  pages: readonly Page[],
  options: RenderPdfOptions,
  at: SourceRef,
): RenderPdfResult {
  const diagnostics: Diagnostic[] = [];

  if (pages.length === 0) {
    // A PDF must have at least one page; a page builder that produced none has
    // a bug, and saying so is more useful than emitting an unopenable file.
    diagnostics.push(error("internal", at, "cannot emit a PDF with no pages"));
    return { pdf: null, diagnostics };
  }

  const compress = options.compressStreams ?? true;
  const fonts = collectFonts(pages, at);
  diagnostics.push(...fonts.diagnostics);
  if (hasErrors(diagnostics)) return { pdf: null, diagnostics };

  const images = collectImages(pages);

  const streams: string[] = [];
  for (const page of pages) {
    const content = buildPageContent(page, fonts.registry, images.registry, at);
    diagnostics.push(...content.diagnostics);
    streams.push(content.stream);
  }
  if (hasErrors(diagnostics)) return { pdf: null, diagnostics };

  const context = PDFContext.create();
  // Reserved first so that the catalog and the page tree are objects 1 and 2 —
  // conventional, and it lets page leaves name their parent before it exists.
  const catalogRef = context.nextRef();
  const pagesRef = context.nextRef();

  const contentRefs = streams.map((stream) =>
    context.register(compress ? context.flateStream(stream) : context.stream(stream)),
  );

  // Fonts are embedded after the content streams because subsetting only knows
  // which glyphs are needed once every page has been walked.
  const fontEntries: PdfDict = {};
  for (const font of fonts.subsets) {
    fontEntries[font.resourceName] = embedFont(context, font, compress);
  }

  // Images after the fonts, for the same reason the fonts come after the content
  // streams: the order objects are registered in is the order they are written,
  // and keeping it a function of the document is what makes the bytes
  // reproducible.
  const imageEntries: PdfDict = {};
  for (const entry of images.entries) {
    imageEntries[entry.resourceName] = embedImageStream(
      context,
      imageStream(entry.image, (data) => inflate(context, data)),
      compress,
    );
  }

  // One shared resource dictionary. A page naming a font it does not use costs
  // nothing, and the alternative is a per-page dictionary that differs only in
  // ways no reader can observe.
  //
  // `/XObject` appears only when the document has images, so a document without
  // any produces exactly the bytes it produced before images existed.
  const resources: PdfDict = { Font: fontEntries };
  if (images.entries.length > 0) resources.XObject = imageEntries;
  const resourcesRef = context.register(context.obj(resources));

  const pageRefs = pages.map((page, index) =>
    context.register(
      context.obj({
        Type: "Page",
        Parent: pagesRef,
        MediaBox: [0, 0, roundToOutput(page.width), roundToOutput(page.height)],
        Resources: resourcesRef,
        Contents: contentRefs[index]!,
      }),
    ),
  );

  context.assign(
    pagesRef,
    context.obj({ Type: "Pages", Kids: pageRefs, Count: pageRefs.length }),
  );
  context.assign(catalogRef, context.obj({ Type: "Catalog", Pages: pagesRef }));

  const info: PdfDict = {
    Producer: PDFString.of(options.producer ?? DEFAULT_PRODUCER),
  };
  if (options.title !== undefined) info.Title = PDFString.of(options.title);
  if (options.creationDate !== undefined) {
    info.CreationDate = PDFString.of(options.creationDate);
    info.ModDate = PDFString.of(options.creationDate);
  }
  const infoRef = context.register(context.obj(info));

  const id = documentId([
    ...streams,
    ...fonts.subsets.map(subsetFingerprint),
    ...images.entries.map(imageFingerprint),
    ...pages.map((page) => `${page.number}:${page.width}x${page.height}`),
  ]);

  context.trailerInfo.Root = catalogRef;
  context.trailerInfo.Info = infoRef;
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);

  const plan = planSerialization(context);
  const cap = options.maxOutputBytes;
  if (cap !== undefined && plan.size > cap) {
    diagnostics.push(
      error(
        "limit-exceeded",
        at,
        `the PDF would be ${plan.size} bytes, over the ${cap}-byte maxOutputBytes cap`,
      ),
    );
    return { pdf: null, diagnostics };
  }

  return { pdf: writeDocument(plan), diagnostics };
}
