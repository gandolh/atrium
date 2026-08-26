import { PDFCrossRefSection, PDFTrailer, PDFTrailerDict } from "pdf-lib";
import type { PDFContext, PDFHeader, PDFObject, PDFRef } from "pdf-lib";

/**
 * Serialising a `PDFContext` to bytes, synchronously.
 *
 * pdf-lib's own `PDFWriter.serializeToBuffer()` is `async` — not because it
 * waits on anything, but because it yields to the macro task queue every
 * `objectsPerTick` objects so a browser stays responsive. `compile()` is a
 * synchronous function that returns a `CompileResult`, so a promise cannot be
 * unwrapped anywhere above here. This is the same algorithm with the yields
 * removed; every byte is still produced by pdf-lib's own object serialisers, so
 * dictionaries, names, strings and streams are encoded by the library.
 *
 * Splitting `plan` from `write` also lets `renderPdf` check `maxOutputBytes`
 * against the exact final size *before* allocating a buffer of it — the whole
 * point of the cap being that a runaway document must not be able to exhaust
 * memory on its way to being rejected.
 */

export interface SerializationPlan {
  size: number;
  readonly header: PDFHeader;
  readonly indirectObjects: [PDFRef, PDFObject][];
  readonly xref: PDFCrossRefSection;
  readonly trailerDict: PDFTrailerDict;
  readonly trailer: PDFTrailer;
}

function copyAsciiInto(text: string, buffer: Uint8Array, offset: number): number {
  for (let i = 0; i < text.length; i++) buffer[offset + i] = text.charCodeAt(i);
  return text.length;
}

function trailerDictFor(context: PDFContext): PDFTrailerDict {
  return PDFTrailerDict.of(
    context.obj({
      Size: context.largestObjectNumber + 1,
      Root: context.trailerInfo.Root,
      Encrypt: context.trailerInfo.Encrypt,
      Info: context.trailerInfo.Info,
      ID: context.trailerInfo.ID,
    }),
  );
}

export function planSerialization(context: PDFContext): SerializationPlan {
  const header = context.header;
  let size = header.sizeInBytes() + 2;

  const xref = PDFCrossRefSection.create();
  const indirectObjects = context.enumerateIndirectObjects();

  for (const entry of indirectObjects) {
    const [ref, object] = entry;
    xref.addEntry(ref, size);
    // `N G R` becomes `N G obj\n` (+3); the object is followed by
    // `\nendobj\n\n` (+9). Identical arithmetic to pdf-lib's writer, and it
    // must stay identical or the buffer is the wrong length.
    size += ref.sizeInBytes() + 3 + object.sizeInBytes() + 9;
  }

  const xrefOffset = size;
  size += xref.sizeInBytes() + 1;

  const trailerDict = trailerDictFor(context);
  size += trailerDict.sizeInBytes() + 2;

  const trailer = PDFTrailer.forLastCrossRefSectionOffset(xrefOffset);
  size += trailer.sizeInBytes();

  return { size, header, indirectObjects, xref, trailerDict, trailer };
}

export function writeDocument(plan: SerializationPlan): Uint8Array {
  const buffer = new Uint8Array(plan.size);
  let offset = 0;

  offset += plan.header.copyBytesInto(buffer, offset);
  offset += copyAsciiInto("\n\n", buffer, offset);

  for (const entry of plan.indirectObjects) {
    const [ref, object] = entry;
    offset += copyAsciiInto(`${ref.objectNumber} ${ref.generationNumber} obj\n`, buffer, offset);
    offset += object.copyBytesInto(buffer, offset);
    offset += copyAsciiInto("\nendobj\n\n", buffer, offset);
  }

  offset += plan.xref.copyBytesInto(buffer, offset);
  offset += copyAsciiInto("\n", buffer, offset);
  offset += plan.trailerDict.copyBytesInto(buffer, offset);
  offset += copyAsciiInto("\n\n", buffer, offset);
  plan.trailer.copyBytesInto(buffer, offset);

  return buffer;
}

/**
 * A deterministic `/ID`.
 *
 * PDF recommends a file identifier, and the usual way to make one is a hash of
 * the creation time — which is exactly what must not appear here if the same
 * input is to produce the same bytes. This hashes the document's *content*
 * instead: four FNV-1a passes with different offset bases, giving sixteen
 * bytes. It identifies, it does not authenticate; a hash of this strength is
 * appropriate for the former and would not be for the latter.
 */
export function documentId(parts: readonly string[]): string {
  const PRIME = 0x01000193;
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let hex = "";
  for (const seed of seeds) {
    let hash = seed >>> 0;
    for (const part of parts) {
      for (let i = 0; i < part.length; i++) {
        const unit = part.charCodeAt(i);
        hash = Math.imul(hash ^ (unit & 0xff), PRIME) >>> 0;
        hash = Math.imul(hash ^ (unit >>> 8), PRIME) >>> 0;
      }
      // A separator, so that ["ab", "c"] and ["a", "bc"] do not collide.
      hash = Math.imul(hash ^ 0xff, PRIME) >>> 0;
    }
    hex += hash.toString(16).toUpperCase().padStart(8, "0");
  }
  return hex;
}
