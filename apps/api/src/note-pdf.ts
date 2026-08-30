import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { getStroke } from "perfect-freehand";
import { PAGE_ASPECT, type NotePage, type Stroke, type TextBox } from "@ebook-reader/shared";

/**
 * Note → PDF (brief 49). One PDF page per note page, all vector.
 *
 * ## Why this lives on the server
 *
 * A note page is already a rasterisation-free vector description — normalized
 * `strokes` + `texts` (`packages/shared/src/notes.ts`) — which is exactly what a
 * PDF wants. `apps/web` carries no PDF writer and three briefs (15/16/17) were
 * spent trimming its payload, while the API already has `pdf-lib` in the tree
 * via `@ebook-reader/typeset`. So the conversion happens here.
 *
 * It deliberately does NOT go through the LaTeX engine: `packages/typeset` sets
 * documents from LaTeX and a note is not one. What is borrowed from brief 40's
 * `packages/typeset/src/pdf/svg.ts` is the *approach* — bake the geometry into
 * the emitted numbers, round to a fixed grid so the bytes are deterministic,
 * and let one place own the y-axis flip (here that place is `pdf-lib`'s
 * `drawSvgPath`, which applies `scale(s, -s)` for us).
 *
 * ## Matching the editor
 *
 * The ink outlines are rebuilt with the SAME `perfect-freehand` options the
 * editor uses (`apps/web/src/notes/NoteEditor.tsx`), including the ×1000
 * working space: perfect-freehand's smoothing degenerates on normalized 0..1
 * coordinates, so geometry is computed at `STROKE_VB` scale and then mapped
 * into points. An outline is a FILLED path, not a stroked line — stroking it
 * would draw both of its edges.
 *
 * Stroke order is preserved exactly, which is what keeps a highlighter under
 * the pen it crosses; the highlighter's translucency rides on a real PDF
 * ExtGState (`/ca`), so it stays vector.
 *
 * ## The sheet is fixed light, in every theme
 *
 * A deliberate brief-26 call: the paper is a light surface whatever the desk
 * around it looks like, so dark ink stays legible. The exported sheet therefore
 * hard-codes the light values of the theme-independent `--note-sheet*` tokens
 * from `apps/web/src/styles/globals.css` rather than accepting any colour from
 * the caller. No chrome token, dark or sepia, can reach this file.
 */

/** A4 width in points; the height follows from `PAGE_ASPECT`, not from A4. */
const PAGE_WIDTH_PT = 595.28;
const PAGE_HEIGHT_PT = PAGE_WIDTH_PT * PAGE_ASPECT;

/** The editor's scaled working space — see the note on perfect-freehand above. */
const STROKE_VB = 1000;
/** viewBox units → points. */
const VB_TO_PT = PAGE_WIDTH_PT / STROKE_VB;

/** Ruling geometry, mirroring `NoteEditor.tsx`: ~1/24 of the page width. */
const RULE_STEP = STROKE_VB / 24;
const RULE_WIDTH_VB = 1.2;

// The light sheet, mirrored from globals.css `--note-sheet` / `--note-sheet-rule`
// / `--note-sheet-ink`. Fixed in every theme by design (see the header).
const SHEET_COLOR = rgb(0xfd / 255, 0xfc / 255, 0xfa / 255);
const RULE_COLOR = rgb(0xd9 / 255, 0xd3 / 255, 0xc4 / 255);
const SHEET_INK_COLOR = rgb(0x1a / 255, 0x19 / 255, 0x17 / 255);

/** The editor's highlighter opacity (`fillOpacity={0.4}`). */
const HIGHLIGHTER_OPACITY = 0.4;
/** Tailwind's `leading-snug`, which the text boxes are rendered with. */
const TEXT_LINE_HEIGHT = 1.375;
/**
 * Baseline offset from a line box's top, as a multiple of the font size:
 * half-leading `(1.375 − 1)/2` plus a typical ascent of ~0.75em. The editor
 * positions a textarea by its top-left corner; `drawText` positions by the
 * first baseline, and this is the bridge between the two.
 */
const BASELINE_FROM_TOP = 0.94;

/**
 * Fixed-grid rounding before formatting, for the same reason
 * `packages/typeset/src/pdf/numbers.ts` does it: `(0.1 + 0.2)` must not reach
 * the file as `0.30000000000000004`, and `toFixed` also guarantees no
 * exponential notation reaches pdf-lib's path parser (which cannot read one).
 * Three decimals of a 1000-unit viewBox is ~0.0006pt.
 */
function num(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  if (rounded === 0) return "0";
  const fixed = rounded.toFixed(3);
  let end = fixed.length;
  while (fixed.charCodeAt(end - 1) === 0x30) end--;
  if (fixed.charCodeAt(end - 1) === 0x2e) end--;
  return fixed.slice(0, end);
}

/**
 * `#rgb` / `#rrggbb` / `rgb(r,g,b)` → a pdf-lib colour. Stroke colours are
 * persisted note *content* (resolved from the ink tokens at pick time), so this
 * has to read whatever a stored note carries; anything unreadable falls back to
 * the sheet's default ink rather than throwing away the stroke.
 */
export function parseInkColor(css: string): RGB {
  const text = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]! : h;
    return rgb(
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
    );
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (fn) {
    const clamp = (v: string) => Math.min(1, Math.max(0, Number(v) / 255));
    return rgb(clamp(fn[1]!), clamp(fn[2]!), clamp(fn[3]!));
  }
  return SHEET_INK_COLOR;
}

/** An SVG path string from a perfect-freehand outline — the editor's algorithm. */
function outlineToPath(outline: number[][]): string {
  if (!outline.length) return "";
  const parts: string[] = ["M", num(outline[0]![0]!), num(outline[0]![1]!), "Q"];
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]! as [number, number];
    const [x1, y1] = outline[(i + 1) % outline.length]! as [number, number];
    parts.push(num(x0), num(y0), num((x0 + x1) / 2), num((y0 + y1) / 2));
  }
  parts.push("Z");
  return parts.join(" ");
}

/**
 * The filled outline of one stroke, in `STROKE_VB` space.
 *
 * Every option here must stay identical to `strokePath` in `NoteEditor.tsx` —
 * including `thinning: 0` for the highlighter, which is what gives it a flat
 * chisel edge instead of a pressure-tapered nib. Exported so a caller can
 * inspect the geometry without building a document.
 */
export function strokeOutlinePath(stroke: Stroke): string {
  if (stroke.points.length === 0) return "";
  const realPressure = stroke.points.some((p) => p[2] > 0 && p[2] !== 0.5);
  const scaled = stroke.points.map((p) => [p[0] * STROKE_VB, p[1] * STROKE_VB, p[2]]);
  const outline = getStroke(scaled, {
    size: stroke.size * STROKE_VB,
    thinning: stroke.tool === "highlighter" ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !realPressure,
  });
  return outlineToPath(outline);
}

/** The page's background ruling, from the same geometry the editor rules with. */
function drawTemplate(page: PDFPage, template: NotePage["template"]): void {
  if (template === "blank") return;
  const thickness = RULE_WIDTH_VB * VB_TO_PT;
  const hVb = STROKE_VB * PAGE_ASPECT;
  // Horizontal rules (ruled + grid), starting one step down like the editor.
  for (let y = RULE_STEP; y < hVb - 1; y += RULE_STEP) {
    const yPt = PAGE_HEIGHT_PT - y * VB_TO_PT;
    page.drawLine({
      start: { x: 0, y: yPt },
      end: { x: PAGE_WIDTH_PT, y: yPt },
      thickness,
      color: RULE_COLOR,
    });
  }
  // Vertical rules (grid only).
  if (template === "grid") {
    for (let x = RULE_STEP; x < STROKE_VB - 1; x += RULE_STEP) {
      const xPt = x * VB_TO_PT;
      page.drawLine({
        start: { x: xPt, y: PAGE_HEIGHT_PT },
        end: { x: xPt, y: 0 },
        thickness,
        color: RULE_COLOR,
      });
    }
  }
}

/**
 * Drop what the standard fonts' WinAnsi encoding cannot represent.
 *
 * A note is free text and `Helvetica` is a WinAnsi font, so an emoji or a CJK
 * character would make `drawText` throw and take the whole export with it. One
 * unrepresentable glyph must cost that glyph, not the document.
 */
function toWinAnsi(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || ch === " ") {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

/** One text box at its normalized position, `size` scaled by the page width. */
function drawTextBox(page: PDFPage, box: TextBox, font: PDFFont): void {
  const text = toWinAnsi(font, box.text).replace(/\r/g, "");
  if (!text.trim()) return;
  const size = box.size * PAGE_WIDTH_PT;
  page.drawText(text, {
    x: box.x * PAGE_WIDTH_PT,
    // `y` is normalized against the page WIDTH too (the editor's `toNorm`
    // divides both axes by width so the aspect ratio is preserved).
    y: PAGE_HEIGHT_PT - (box.y * PAGE_WIDTH_PT + BASELINE_FROM_TOP * size),
    size,
    font,
    color: SHEET_INK_COLOR,
    lineHeight: size * TEXT_LINE_HEIGHT,
    maxWidth: box.w * PAGE_WIDTH_PT,
  });
}

/** Paint one note page onto one PDF page: sheet, ruling, ink, text — in that order. */
function drawNotePage(page: PDFPage, notePage: NotePage, font: PDFFont): void {
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_WIDTH_PT,
    height: PAGE_HEIGHT_PT,
    color: SHEET_COLOR,
  });
  drawTemplate(page, notePage.template ?? "blank");

  // Stroke order is the page's own order — that is what puts a highlighter
  // under the pen it crosses. Do not sort by tool.
  for (const stroke of notePage.strokes) {
    const d = strokeOutlinePath(stroke);
    if (!d) continue;
    page.drawSvgPath(d, {
      // `drawSvgPath` flips y for us, so the origin is the page's TOP-left.
      x: 0,
      y: PAGE_HEIGHT_PT,
      scale: VB_TO_PT,
      color: parseInkColor(stroke.color),
      opacity: stroke.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
    });
  }

  for (const box of notePage.texts) drawTextBox(page, box, font);
}

/**
 * Render a whole note to PDF bytes.
 *
 * A note with no pages still yields a one-page document: a zero-page PDF is not
 * a valid file, and "you exported an empty notebook" is better told by a blank
 * sheet than by an error.
 */
export async function renderNotePdf(title: string, pages: NotePage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title || "Untitled note");
  doc.setProducer("Atrium");
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const sheets: NotePage[] = pages.length
    ? pages
    : [{ strokes: [], texts: [], template: "blank" }];
  for (const notePage of sheets) {
    drawNotePage(doc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]), notePage, font);
  }
  return doc.save();
}

/**
 * An ASCII filename for `Content-Disposition`. The header's plain `filename=`
 * parameter is a latin-1 token, so a title with an em-dash or a CJK character
 * has to degrade rather than travel raw; the route pairs this with a `filename*`
 * carrying the real UTF-8 name.
 */
export function pdfFilename(title: string): string {
  const ascii = title
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\/:*?<>|]/g, "")
    .trim()
    .slice(0, 80);
  return `${ascii || "note"}.pdf`;
}
