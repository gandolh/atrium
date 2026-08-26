import fontkit from "@pdf-lib/fontkit";
import type { FontkitFont, FontkitSubset, SubsetEncodeStream } from "./fontkit-types.ts";
import type { FontHandle } from "../font/handle.ts";
import { toGlyphSpace } from "./numbers.ts";
import { buildToUnicodeCMap } from "./cmap.ts";
import type { ToUnicodeEntry } from "./cmap.ts";

/**
 * Font embedding: one used face becomes one subset, one CID font dictionary and
 * one `/ToUnicode` CMap.
 *
 * **Why this does not use `PDFDocument.embedFont`.** pdf-lib's embedder is
 * driven by *text*: it re-shapes every string with its own fontkit and derives
 * both the glyph sequence and the advances itself. Layout has already done that
 * work, with kerning, and pdf-lib's numbers disagree — measured on
 * `lmroman10-regular`, "The quick brown fox" at 10 pt is 91.15 pt to pdf-lib
 * and 90.31 pt to the font layer, because pdf-lib sums unkerned `advanceWidth`.
 * Re-deriving positions from text would therefore drift every run away from
 * where layout believes it is. So this module drives the subset by *glyph id*
 * and `content.ts` places every glyph explicitly.
 */

/**
 * Obtaining the `EncodeStream` constructor.
 *
 * `Subset.encode(stream)` is synchronous; only the public `encodeStream()`
 * wrapper is not, because it defers the call to a `nextTick`. The engine is a
 * synchronous function (`compile()` returns a `CompileResult`, not a promise),
 * so it needs `encode` — and `encode` needs a stream object the library does
 * not otherwise expose.
 *
 * The one call to `encodeStream()` below exists to get at that constructor. Its
 * pending `nextTick` is defused by shadowing `encode` on the *throwaway* subset
 * it was taken from, so nothing is encoded twice and the real subsets are never
 * touched. The alternative was reimplementing `restructure`'s encoder, which
 * would be a second copy of a byte format we do not own.
 */
let encodeStreamCtor: (new () => SubsetEncodeStream) | null = null;

function subsetEncodeStream(font: FontkitFont): SubsetEncodeStream {
  if (encodeStreamCtor === null) {
    const throwaway = font.createSubset();
    const probe = throwaway.encodeStream();
    throwaway.encode = () => {};
    encodeStreamCtor = probe.constructor as unknown as new () => SubsetEncodeStream;
  }
  return new encodeStreamCtor();
}

/** Accumulating state for one face used by the document. */
export interface FontSubset {
  readonly handle: FontHandle;
  /** Resource name inside `/Font`, e.g. `F0`. */
  readonly resourceName: string;
  /** The six-letter `ABCDEF+` subset tag PDF prepends to `/BaseFont`. */
  readonly tag: string;
  readonly kitFont: FontkitFont;
  readonly subset: FontkitSubset;
  /** Original glyph id → subset glyph id (the code written to the stream). */
  readonly codes: Map<number, number>;
  /** Subset glyph id → advance in font units. */
  readonly widths: Map<number, number>;
  /** Subset glyph id → source characters, for `/ToUnicode`. */
  readonly unicode: Map<number, string>;
}

/**
 * Subset tags only have to be unique *within one file*, so they are derived
 * from the font's position in the document rather than from a random suffix
 * (which is what pdf-lib's `addRandomSuffix` would give, and which would make
 * the output unreproducible). Index-derived also means a golden file names the
 * face it belongs to in reading order.
 */
export function subsetTag(index: number): string {
  let n = index;
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag = String.fromCharCode(0x41 /* 'A' */ + (n % 26)) + tag;
    n = Math.floor(n / 26);
  }
  return tag;
}

export function createFontSubset(handle: FontHandle, index: number): FontSubset {
  const kitFont = fontkit.create(handle.data);
  return {
    handle,
    resourceName: `F${index}`,
    tag: subsetTag(index),
    kitFont,
    subset: kitFont.createSubset(),
    codes: new Map(),
    widths: new Map(),
    unicode: new Map(),
  };
}

/**
 * Include one glyph and return the code the content stream must write for it.
 * The width is captured here, from the *font layer's* `advanceWidth`, so the
 * `/W` array a renderer advances by is by construction the same number layout
 * measured with.
 */
export function subsetCodeFor(font: FontSubset, glyphId: number): number {
  const existing = font.codes.get(glyphId);
  if (existing !== undefined) return existing;

  const code = font.subset.includeGlyph(glyphId);
  font.codes.set(glyphId, code);
  font.widths.set(code, font.handle.advanceWidth(glyphId));
  return code;
}

/**
 * Record what a glyph meant. First writer wins: a glyph reachable from two code
 * points (the hyphen, say) would otherwise flip between them depending on which
 * page a reader happened to be on, and an unstable `/ToUnicode` is worse than a
 * consistently approximate one.
 */
export function recordUnicode(font: FontSubset, code: number, text: string): void {
  if (text.length === 0) return;
  if (font.unicode.has(code)) return;
  font.unicode.set(code, text);
}

export function toUnicodeEntries(font: FontSubset): ToUnicodeEntry[] {
  const entries: ToUnicodeEntry[] = [];
  for (const [code, text] of font.unicode) entries.push({ code, text });
  return entries;
}

export function toUnicodeCMapFor(font: FontSubset): string {
  return buildToUnicodeCMap(toUnicodeEntries(font));
}

/**
 * Byte 3 of a CFF header is `offSize`, which the CFF spec confines to 1–4.
 *
 * `@pdf-lib/fontkit@1.1.1` writes `this.cff.length` there instead — an
 * unrelated number, 6 for every Latin Modern face. Real parsers take their
 * offsets from each INDEX's own `offSize`, so the value is vestigial and the
 * font still *works*; but consumers that validate it reject the whole font
 * program. Measured on the faces this package ships: poppler 22.02 gives
 * "Embedded font file may be invalid" followed by "Couldn't create a font",
 * and renders the page in a substitute face; pdf.js 5.4 — which is what
 * `apps/web` renders with — warns "Unable to detect correct font file
 * Type/Subtype" because its CFF sniffer range-checks exactly this byte.
 *
 * pdf-lib's own `embedFont(…, { subset: true })` produces identical output and
 * fails the same way, so this is upstream rather than something this writer
 * introduced. Correcting one out-of-spec byte in a font program we emit is a
 * smaller thing to own than a CFF subsetter, so it is corrected here.
 */
const CFF_HEADER_OFFSIZE = 3;
const CFF_MAX_OFFSIZE = 4;

/** The subset font file, ready for `FontFile2`/`FontFile3`. */
export function serializeSubset(font: FontSubset): Uint8Array {
  const stream = subsetEncodeStream(font.kitFont);
  font.subset.encode(stream);
  stream.end();
  const bytes = stream.read();
  if (bytes === null || bytes.length === 0) {
    // Only reachable if a fontkit upgrade made `encode` asynchronous again.
    // Loud, because a silently empty font file produces a PDF that opens and
    // renders nothing.
    throw new Error(
      `@pdf-lib/fontkit produced no bytes for the subset of ${font.handle.id}; ` +
        `Subset.encode() is no longer synchronous`,
    );
  }

  if (isCFF(font)) {
    const offSize = bytes[CFF_HEADER_OFFSIZE];
    // Left alone when in range, so a fixed fontkit is not second-guessed.
    if (offSize === undefined || offSize < 1 || offSize > CFF_MAX_OFFSIZE) {
      bytes[CFF_HEADER_OFFSIZE] = CFF_MAX_OFFSIZE;
    }
  }

  return bytes;
}

/** True when the subset must be described as CIDFontType0 (CFF) rather than Type2. */
export function isCFF(font: FontSubset): boolean {
  return Boolean(font.subset.cff);
}

/**
 * `/Flags` for the font descriptor, following pdf-lib and pdfkit: `Symbolic` is
 * always set because a subset addressed through `Identity-H` has no standard
 * encoding to be non-symbolic against.
 */
export function fontFlags(font: FontSubset): number {
  const familyClass = font.kitFont["OS/2"]?.sFamilyClass ?? 0;
  let flags = 0;
  if (font.kitFont.post.isFixedPitch) flags |= 1 << 0;
  if (familyClass >= 1 && familyClass <= 7) flags |= 1 << 1;
  flags |= 1 << 2; // Symbolic
  if (familyClass === 10) flags |= 1 << 3; // Script
  if (font.kitFont.head.macStyle.italic) flags |= 1 << 6;
  return flags;
}

/**
 * The `/W` array. Codes are handed out contiguously from 1, so one run covers
 * every glyph in the subset and the array is `[1 [w1 w2 …]]`.
 */
export function widthsArray(font: FontSubset): (number | number[])[] {
  const upem = font.handle.unitsPerEm;
  const widths: number[] = [];
  for (let code = 1; code <= font.widths.size; code++) {
    const units = font.widths.get(code);
    if (units === undefined) break;
    widths.push(toGlyphSpace(units, upem));
  }
  return widths.length === 0 ? [] : [1, widths];
}

/** `/BaseFont`, tag included. */
export function baseFontName(font: FontSubset): string {
  return `${font.tag}+${font.handle.postscriptName}`;
}

/**
 * The `/FontBBox`, in glyph space. Taken from the parsed face rather than from
 * `FontHandle`, which does not carry a bounding box.
 */
export function fontBBox(font: FontSubset): number[] {
  const upem = font.handle.unitsPerEm;
  const { minX, minY, maxX, maxY } = font.kitFont.bbox;
  return [
    toGlyphSpace(minX, upem),
    toGlyphSpace(minY, upem),
    toGlyphSpace(maxX, upem),
    toGlyphSpace(maxY, upem),
  ];
}

/** Used by the document-id hash, which must not depend on object numbering. */
export function subsetFingerprint(font: FontSubset): string {
  const codes = [...font.codes.entries()].map(([gid, code]) => `${gid}:${code}`).join(",");
  return `${font.handle.id}|${baseFontName(font)}|${font.handle.unitsPerEm}|${codes}`;
}
