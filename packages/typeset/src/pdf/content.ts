import type { Diagnostic } from "@ebook-reader/shared";
import type { FontHandle } from "../font/handle.ts";
import type { GlyphRun, Page, PlacedImage, PlacedRule } from "../layout/page.ts";
import type { SourceRef } from "../diagnostics.ts";
import { error } from "../diagnostics.ts";
import { formatNumber, roundToOutput, toGlyphSpace } from "./numbers.ts";
import { recordUnicode, subsetCodeFor } from "./subset.ts";
import type { FontSubset } from "./subset.ts";

/**
 * The content stream: PDF operators for one page.
 *
 * **This is the one place that converts coordinates.** Layout is y-down from
 * the page's top-left; PDF is y-up from the bottom-left. Every `y` that reaches
 * a byte goes through `pdfY()` below and nowhere else.
 *
 * **Glyphs are placed explicitly, not drawn as text.** See `subset.ts` for the
 * measurement that forced it. The mechanism: the `/W` array gives a renderer
 * each glyph's *unkerned* advance, and a `TJ` array carries the difference
 * between that and the advance layout actually chose. The renderer's pen and
 * layout's pen therefore agree at every glyph, and — because the adjustment is
 * recomputed from the exact running position each time rather than accumulated
 * — five-decimal rounding cannot drift over a long line.
 *
 * `TJ` also keeps the run a single text-showing operation, which is what text
 * extractors follow to recover word boundaries. Per-glyph `Td` would be equally
 * exact and considerably worse to copy out of.
 */

export interface FontRegistry {
  /** The subset for this face, created on first use, in document order. */
  use(handle: FontHandle): FontSubset;
}

/**
 * The resource name (`Im0`) an image's `XObject` was registered under.
 * `pdf/render.ts` embeds the images before any content stream is built, so this
 * is a lookup and never a failure — an unknown path is an engine bug and says
 * so rather than emitting a `Do` for a resource that is not in the dictionary.
 */
export interface ImageRegistry {
  use(path: string): string | undefined;
}

export interface PageContent {
  /** The uncompressed operator text. */
  stream: string;
  diagnostics: Diagnostic[];
}

function pdfY(page: Page, y: number): number {
  return page.height - y;
}

function allFinite(values: readonly number[]): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

/**
 * The source characters each glyph stands for.
 *
 * A cluster is a UTF-16 index into the run's text; a glyph covers from its own
 * cluster to the next *different* one. Several glyphs sharing a cluster (a
 * decomposed accent) give the characters to the first and nothing to the rest,
 * because duplicating them would paste the letter twice.
 */
function clusterTexts(run: GlyphRun): string[] {
  const texts: string[] = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i]!;
    const previous = i > 0 ? run.glyphs[i - 1]! : undefined;
    if (previous !== undefined && previous.cluster === glyph.cluster) {
      texts.push("");
      continue;
    }

    let end = run.text.length;
    for (let j = i + 1; j < run.glyphs.length; j++) {
      const next = run.glyphs[j]!;
      if (next.cluster !== glyph.cluster) {
        end = next.cluster;
        break;
      }
    }
    texts.push(end > glyph.cluster ? run.text.slice(glyph.cluster, end) : "");
  }
  return texts;
}

function hexCode(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, "0");
}

function emitRule(rule: PlacedRule, page: Page, out: string[]): void {
  // `rule.y` is the top edge and the rectangle grows downwards, so the PDF
  // rectangle's origin is its *bottom* edge.
  const x = formatNumber(rule.x);
  const y = formatNumber(pdfY(page, rule.y + rule.height));
  out.push(`${x} ${y} ${formatNumber(rule.width)} ${formatNumber(rule.height)} re f`);
}

/**
 * An image is painted by scaling the unit square: PDF's image space is always
 * one unit wide and one unit tall with its origin at the *bottom* left, so the
 * `cm` below is the whole of the placement — `width` and `height` on the
 * diagonal, and the bottom-left corner as the translation.
 *
 * `q`/`Q` bracket it because `cm` multiplies the current transformation matrix:
 * without the save and restore, the second image on a page would be placed
 * inside the first one's coordinate system.
 */
function emitImage(item: PlacedImage, page: Page, resource: string, out: string[]): void {
  const x = formatNumber(item.x);
  // `item.y` is the top edge and the picture grows downwards, so the PDF origin
  // is its bottom edge — the same conversion `emitRule` makes.
  const y = formatNumber(pdfY(page, item.y + item.height));
  out.push("q");
  out.push(`${formatNumber(item.width)} 0 0 ${formatNumber(item.height)} ${x} ${y} cm`);
  out.push(`/${resource} Do`);
  out.push("Q");
}

function emitRun(run: GlyphRun, page: Page, font: FontSubset, out: string[]): void {
  const upem = run.font.unitsPerEm;
  const texts = clusterTexts(run);

  out.push("BT");
  out.push(`/${font.resourceName} ${formatNumber(run.size)} Tf`);
  out.push(`1 0 0 1 ${formatNumber(run.x)} ${formatNumber(pdfY(page, run.y))} Tm`);

  // `penExact` is where layout says the next glyph starts, relative to the run.
  // `viewerX` is where a renderer's pen actually is after the bytes emitted so
  // far. Every adjustment is `penExact - viewerX`, so the two never diverge.
  let penExact = 0;
  let viewerX = 0;
  let rise = 0;

  let items: string[] = [];
  let pending = "";

  const flushGlyphs = (): void => {
    if (pending.length > 0) {
      items.push(`<${pending}>`);
      pending = "";
    }
  };
  const flushArray = (): void => {
    flushGlyphs();
    if (items.length > 0) {
      out.push(`[${items.join(" ")}] TJ`);
      items = [];
    }
  };

  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i]!;

    // A vertical offset is text rise; it does not move the pen horizontally, so
    // `penExact` and `viewerX` carry across the operator boundary unchanged.
    if (glyph.yOffset !== rise) {
      flushArray();
      rise = glyph.yOffset;
      out.push(`${formatNumber(rise)} Ts`);
    }

    const wanted = penExact + glyph.xOffset;
    const delta = wanted - viewerX;
    if (delta !== 0) {
      // A `TJ` number is *subtracted* from the pen, in thousandths of the text
      // space unit, and then scaled by the type size.
      const adjustment = roundToOutput((-delta * 1000) / run.size);
      if (adjustment !== 0) {
        flushGlyphs();
        items.push(formatNumber(adjustment));
        viewerX += (-adjustment / 1000) * run.size;
      }
    }

    const code = subsetCodeFor(font, glyph.id);
    recordUnicode(font, code, texts[i]!);
    pending += hexCode(code);

    // What the renderer will advance by: the `/W` entry for this glyph.
    viewerX += (toGlyphSpace(run.font.advanceWidth(glyph.id), upem) / 1000) * run.size;
    penExact += glyph.advance;
  }

  flushArray();
  if (rise !== 0) out.push("0 Ts");
  out.push("ET");
}

export function buildPageContent(
  page: Page,
  registry: FontRegistry,
  images: ImageRegistry,
  at: SourceRef,
): PageContent {
  const diagnostics: Diagnostic[] = [];
  // Fill colour is explicit rather than inherited: a content stream's initial
  // graphics state is black by spec, but saying so costs three bytes and makes
  // the stream readable on its own.
  const out: string[] = ["0 g"];

  // A backstop, and `internal` on purpose. The one thing a *document* can do
  // to produce an impossible page — `\usepackage[paperwidth=0pt]{geometry}` —
  // is refused where the option is read (`applyGeometry` in `layout/design.ts`)
  // and reported there as the author's error, with the line it is on. Anything
  // still reaching here is a `PageDesign` no document asked for: an engine bug.
  if (!allFinite([page.width, page.height]) || page.width <= 0 || page.height <= 0) {
    diagnostics.push(
      error("internal", at, `page ${page.number} has a non-finite or empty media box`),
    );
    return { stream: "", diagnostics };
  }

  for (const item of page.items) {
    if (item.kind === "rule") {
      if (!allFinite([item.x, item.y, item.width, item.height])) {
        diagnostics.push(
          error("internal", at, `page ${page.number} carries a rule with a non-finite dimension`),
        );
        continue;
      }
      if (item.width === 0 || item.height === 0) continue;
      emitRule(item, page, out);
      continue;
    }

    if (item.kind === "image") {
      if (!allFinite([item.x, item.y, item.width, item.height])) {
        diagnostics.push(
          error("internal", at, `page ${page.number} carries an image with a non-finite dimension`),
        );
        continue;
      }
      // A zero-sized image paints nothing, and `placeImage` refuses to produce
      // one; skipping rather than emitting keeps a degenerate `cm` out of the
      // stream either way.
      if (item.width === 0 || item.height === 0) continue;
      const resource = images.use(item.path);
      if (resource === undefined) {
        diagnostics.push(
          error("internal", at, `page ${page.number} names the image \`${item.path}\`, which was not embedded`),
        );
        continue;
      }
      emitImage(item, page, resource, out);
      continue;
    }

    if (!allFinite([item.x, item.y, item.size])) {
      diagnostics.push(
        error("internal", at, `page ${page.number} carries a glyph run with a non-finite position`),
      );
      continue;
    }
    // A zero or negative size would divide by zero in the `TJ` adjustment and
    // renders nothing anyway.
    if (item.size <= 0 || item.glyphs.length === 0) continue;
    emitRun(item, page, registry.use(item.font), out);
  }

  out.push("");
  return { stream: out.join("\n"), diagnostics };
}
