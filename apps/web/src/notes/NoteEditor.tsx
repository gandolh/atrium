import { getStroke } from "perfect-freehand";
import { usePinch } from "@use-gesture/react";
import { EASE_PAPER_CSS, usePrefersReducedMotion } from "../lib/motion";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  HIGHLIGHTER_SCALE,
  NOTE_NIBS,
  NOTE_TOOLS,
  NOTE_TOOL_LABELS,
  PAGE_ASPECT,
  PAGE_TEMPLATES,
  STROKE_VB,
  nibPassPoints,
  strokeNibPasses,
  type NoteNib,
  type NotePage,
  type NoteTool,
  type PageTemplate,
  type Stroke,
  type StrokePoint,
  type TextBox,
} from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { cssToken } from "../lib/tokens";
import { fetchNotePdf } from "./notes-api";
import { useNote, useSaveNote } from "./use-notes";

/**
 * The note editor (brief 26) — a paged notebook page with vector ink
 * (perfect-freehand) + movable typed text boxes. Coordinates are normalized to
 * the page box (width 1, height PAGE_ASPECT) so a note drawn on a phone renders
 * identically on a monitor. Autosaves (debounced PATCH) like the reader's
 * progress flush.
 *
 * The page sheet is deliberately a light "paper" surface in every theme (a
 * sheet of paper looks the same; the desk around it changes) so dark ink stays
 * legible in dark mode; the surrounding chrome themes normally.
 */

/**
 * What the pointer does on the sheet. The stored ink kinds (`NoteTool`) plus
 * two *modes* that leave nothing behind of their own — the eraser removes
 * strokes and the text tool places boxes, so neither is a stroke `tool` value.
 */
type Tool = NoteTool | "eraser" | "text";

const INK_TOOLS = new Set<string>(NOTE_TOOLS);
/** Is the active tool one that lays down ink (rather than erase / text)? */
function isInkTool(tool: Tool): tool is NoteTool {
  return INK_TOOLS.has(tool);
}

// The pen palette. A stroke's colour is PERSISTED into the note, so it has to
// be stored as a concrete value rather than a `var()` — but the values still
// live in globals.css like every other colour, and are resolved at pick time
// (lib/tokens.ts). Like the sheet itself they hold in every theme: a note is
// document content, not chrome. The names double as the swatches' accessible
// labels (the old ones read the raw hex aloud).
const INKS = [
  { name: "Ink", token: "--note-ink-default" },
  { name: "Blue", token: "--note-ink-blue" },
  { name: "Red", token: "--note-ink-red" },
  { name: "Green", token: "--note-ink-green" },
  { name: "Amber", token: "--note-ink-amber" },
] as const;
// Nib widths as a fraction of page width (resolution-independent).
const THICKNESS = [0.004, 0.007, 0.012] as const;
const ERASE_RADIUS = 0.02;
// `STROKE_VB` (the scaled-up geometry space that keeps perfect-freehand from
// degenerating on normalized 0..1 coordinates) and `HIGHLIGHTER_SCALE` now come
// from @ebook-reader/shared, alongside the nib parameter table the PDF exporter
// reads from the same place. Storage is still normalized; the SVG below uses
// the same viewBox.

// Pinch-to-zoom bounds for the page sheet (mobile). 1 = fit-to-column (the
// resting layout); the sheet never zooms out past that.
const MAX_ZOOM = 4;

const BLANK_PAGE: NotePage = { strokes: [], texts: [], template: "blank" };

// Ruling geometry + color live in the scaled viewBox space (STROKE_VB wide) so
// lines scale with the sheet. The paper is a fixed light surface in every theme
// (see the sheet background below), so the ruling is a token that is likewise
// theme-independent by design — `--note-sheet-rule` in globals.css.
const RULE_COLOR = "var(--note-sheet-rule)";
const RULE_STEP = STROKE_VB / 24; // line spacing as ~1/24 of the page width

/** Build an SVG path string from a perfect-freehand outline. */
function outlineToPath(outline: number[][]): string {
  if (!outline.length) return "";
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...outline[0], "Q"] as (string | number)[],
  );
  d.push("Z");
  return d.join(" ");
}

/** One filled path of a stroke: an outline in viewBox space plus its opacity. */
type StrokeLayer = { d: string; opacity: number };

/**
 * The filled outlines of a stroke, computed in the scaled viewBox space — one
 * per nib pass. The pen, fountain pen and highlighter are a single layer; the
 * pencil is three, and its stacked opacities are what read as graphite.
 *
 * The `perfect-freehand` options are NOT written here. They live once in
 * `packages/shared/src/notes.ts` because `apps/api/src/note-pdf.ts` rebuilds
 * the same geometry for the PDF export (brief 49) — a nib added to only one of
 * the two would export as a plain pen with no error and no diagnostic.
 */
function strokeLayers(stroke: Stroke): StrokeLayer[] {
  if (stroke.points.length === 0) return [];
  const layers: StrokeLayer[] = [];
  for (const pass of strokeNibPasses(stroke)) {
    const d = outlineToPath(getStroke(nibPassPoints(stroke.points, pass), pass.options));
    if (d) layers.push({ d, opacity: pass.opacity });
  }
  return layers;
}

/* ------------------------------------------------------------------ export */
/*
 * Export (brief 49). The PDF is rendered by the API — `apps/web` carries no PDF
 * writer and briefs 15/16/17 were spent trimming its payload, while the server
 * already has pdf-lib. The PNG is the exception and is produced HERE, because
 * the browser already holds the exact geometry on screen and rasterising it
 * costs no new dependency on either side: the page is re-serialised as a
 * standalone SVG and drawn once into a canvas.
 *
 * Both exports are a sheet of paper, so both use the theme-independent
 * `--note-sheet*` tokens (they are defined once at `:root` and never remapped
 * by `data-theme` — see globals.css). A dark session exports the same light
 * sheet as a light one.
 */

/** Ruling line positions in viewBox space, shared by the sheet and the PNG. */
function ruleLines(template: PageTemplate): { horizontal: number[]; vertical: number[] } {
  const horizontal: number[] = [];
  const vertical: number[] = [];
  if (template === "blank") return { horizontal, vertical };
  const h = STROKE_VB * PAGE_ASPECT;
  // Start one step down so the top edge is clear.
  for (let y = RULE_STEP; y < h - 1; y += RULE_STEP) horizontal.push(y);
  if (template === "grid") {
    for (let x = RULE_STEP; x < STROKE_VB - 1; x += RULE_STEP) vertical.push(x);
  }
  return { horizontal, vertical };
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Greedy word wrap at `maxWidth`, measured in the same font the text box is
 * rendered in. The sheet wraps its text boxes with a `<textarea>`; a standalone
 * SVG has no line-breaking of its own, so the export has to do it explicitly or
 * long text would run off the sheet.
 */
function wrapLines(text: string, fontSize: number, fontFamily: string, maxWidth: number): string[] {
  const ctx = document.createElement("canvas").getContext("2d");
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!ctx) {
      lines.push(paragraph);
      continue;
    }
    ctx.font = `${fontSize}px ${fontFamily}`;
    let current = "";
    for (const word of paragraph.split(/(\s+)/)) {
      const next = current + word;
      if (current && ctx.measureText(next).width > maxWidth) {
        lines.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = next;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * One page as a self-contained SVG document. Colours are resolved to literals
 * because a `var()` cannot cross into a detached SVG, and no font file is
 * referenced (an `<img>`-rasterised SVG loads no external resources) — the text
 * boxes name the UI family and fall back to a generic sans.
 */
function pageToSvg(page: NotePage): string {
  const w = STROKE_VB;
  const h = STROKE_VB * PAGE_ASPECT;
  const sheet = cssToken("--note-sheet") || "#fdfcfa";
  const rule = cssToken("--note-sheet-rule") || "#d9d3c4";
  const ink = cssToken("--note-sheet-ink") || "#1a1917";
  const family = `${cssToken("--font-ui") || "sans-serif"}, sans-serif`;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="${sheet}"/>`,
  ];

  const { horizontal, vertical } = ruleLines(page.template ?? "blank");
  if (horizontal.length || vertical.length) {
    parts.push(`<g stroke="${rule}" stroke-width="1.2">`);
    for (const y of horizontal) parts.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}"/>`);
    for (const x of vertical) parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}"/>`);
    parts.push(`</g>`);
  }

  // Page order, unchanged — that is what keeps a highlighter under the pen. A
  // multi-pass nib emits several paths, in their own order, inside that.
  for (const stroke of page.strokes) {
    for (const layer of strokeLayers(stroke)) {
      parts.push(
        `<path d="${layer.d}" fill="${xmlEscape(stroke.color)}" fill-opacity="${layer.opacity}"/>`,
      );
    }
  }

  for (const box of page.texts) {
    if (!box.text.trim()) continue;
    const size = box.size * STROKE_VB;
    const lines = wrapLines(box.text, size, family, box.w * STROKE_VB);
    // 0.94em below the box top is the first baseline: half of `leading-snug`'s
    // extra leading plus a typical ascent.
    let y = box.y * STROKE_VB + size * 0.94;
    for (const line of lines) {
      parts.push(
        `<text x="${box.x * STROKE_VB}" y="${y}" font-family="${xmlEscape(family)}" font-size="${size}" fill="${ink}">${xmlEscape(line)}</text>`,
      );
      y += size * 1.375;
    }
  }

  parts.push(`</svg>`);
  return parts.join("");
}

/** Hand a blob to the browser as a download and release the object URL. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A filesystem-safe name from the note title. */
function exportFilename(title: string, suffix: string): string {
  const base = title.replace(/["\\/:*?<>|]/g, "").trim().slice(0, 80);
  return `${base || "note"}${suffix}`;
}

/** Width in pixels of the rasterised page — ~170dpi against an A4 sheet. */
const PNG_WIDTH = 1400;

/** Rasterise one page to PNG at `PNG_WIDTH` and download it. */
async function downloadPagePng(page: NotePage, filename: string): Promise<void> {
  const svg = pageToSvg(page);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The page could not be rendered"));
    // A data URL keeps the image same-origin, so the canvas is never tainted.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = PNG_WIDTH;
  canvas.height = Math.round(PNG_WIDTH * PAGE_ASPECT);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The page could not be rendered");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The page could not be rendered");
  downloadBlob(blob, filename);
}

/**
 * The page's background ruling, drawn behind the ink in the same scaled viewBox
 * space (so it scales with the sheet, `preserveAspectRatio="none"` like the ink
 * layer). `blank` renders nothing.
 */
function PageBackground({ template }: { template: PageTemplate }) {
  if (template === "blank") return null;
  const w = STROKE_VB;
  const h = STROKE_VB * PAGE_ASPECT;
  // One geometry source for the sheet and for both exports (`ruleLines`), so a
  // ruled page cannot rule differently on paper than it does on screen.
  const { horizontal, vertical } = ruleLines(template);
  const lines: ReactNode[] = [
    ...horizontal.map((y) => <line key={`h${y}`} x1={0} y1={y} x2={w} y2={y} />),
    ...vertical.map((x) => <line key={`v${x}`} x1={x} y1={0} x2={x} y2={h} />),
  ];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
      stroke={RULE_COLOR}
      strokeWidth={1.2}
      aria-hidden="true"
    >
      {lines}
    </svg>
  );
}

export function NoteEditor({ id }: { id: string }) {
  // Same mechanism as every other page-level component (NotesList,
  // LibraryHome, Discover) — without it, `data-theme` freezes at whatever
  // NotesList's cleanup left behind when it unmounts on navigation into the
  // editor, so switching to dark right before opening a note could leave the
  // editor chrome light. `NoteEditor` itself is the theme-application site
  // here, so it needs the hook too, not just its siblings.
  useApplyTheme();
  const navigate = useNavigate();
  const query = useNote(id);
  const save = useSaveNote(id);

  const [title, setTitle] = useState("");
  const [pages, setPages] = useState<NotePage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // The tool bar keeps ONE ink-nib slot (see `Toolbar`), so the last nib the
  // user picked has to survive a trip through the eraser or the text tool.
  const [tool, setTool] = useState<Tool>("pen");
  const [nib, setNib] = useState<NoteNib>("pen");
  const [color, setColor] = useState<string>(() => cssToken(INKS[0].token));
  const [thickness, setThickness] = useState(1);

  // Export state (brief 49): which format is in flight, and the last failure.
  const [exporting, setExporting] = useState<null | "pdf" | "png">(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Undo/redo stacks of page snapshots (structural changes only).
  const undoRef = useRef<NotePage[][]>([]);
  const redoRef = useRef<NotePage[][]>([]);
  const [histTick, setHistTick] = useState(0);

  // Seed local editing state once the note arrives (never re-seed — the editor
  // owns the open note; a refetch must not clobber in-flight edits).
  useEffect(() => {
    if (query.data && !loaded) {
      setTitle(query.data.title);
      setPages(query.data.pages.length ? query.data.pages : [BLANK_PAGE]);
      setLoaded(true);
    }
  }, [query.data, loaded]);

  const page = pages[pageIndex] ?? BLANK_PAGE;

  const snapshot = useCallback(() => {
    undoRef.current.push(structuredClone(pages));
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
    setHistTick((t) => t + 1);
  }, [pages]);

  const mutatePage = useCallback(
    (fn: (p: NotePage) => NotePage) => {
      setPages((prev) => prev.map((p, i) => (i === pageIndex ? fn(p) : p)));
    },
    [pageIndex],
  );

  // Page background is a per-page property; changing it is an undoable structural
  // edit like adding a page.
  const setPageTemplate = useCallback(
    (t: PageTemplate) => {
      if ((pages[pageIndex]?.template ?? "blank") === t) return;
      snapshot();
      mutatePage((p) => ({ ...p, template: t }));
    },
    [pages, pageIndex, snapshot, mutatePage],
  );

  function undo() {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(structuredClone(pages));
    setPages(prev);
    setPageIndex((i) => Math.min(i, prev.length - 1));
    setHistTick((t) => t + 1);
  }
  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(structuredClone(pages));
    setPages(next);
    setHistTick((t) => t + 1);
  }

  // --- Autosave (debounced) + flush on unmount/hide -------------------------
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    dirtyRef.current = true;
    const t = setTimeout(() => {
      if (dirtyRef.current) {
        save.mutate({ title: title.trim() || "Untitled note", pages });
        dirtyRef.current = false;
      }
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, pages, loaded]);

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const flush = () => {
      if (dirtyRef.current) {
        saveRef.current.mutate({ title: title.trim() || "Untitled note", pages });
        dirtyRef.current = false;
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, pages]);

  // --- Export (brief 49) ----------------------------------------------------
  // The PDF is rendered by the server from the STORED note, so a pending
  // autosave has to land first — otherwise the download is silently a few
  // seconds stale. The PNG reads the in-memory page and needs no such flush.
  async function exportPdf() {
    setExportError(null);
    setExporting("pdf");
    try {
      const name = title.trim() || "Untitled note";
      await save.mutateAsync({ title: name, pages });
      dirtyRef.current = false;
      downloadBlob(await fetchNotePdf(id), exportFilename(name, ".pdf"));
    } catch {
      setExportError("Couldn't export this note.");
    } finally {
      setExporting(null);
    }
  }

  async function exportPng() {
    setExportError(null);
    setExporting("png");
    try {
      const name = title.trim() || "Untitled note";
      await downloadPagePng(page, exportFilename(name, `-page-${pageIndex + 1}.png`));
    } catch {
      setExportError("Couldn't export this page.");
    } finally {
      setExporting(null);
    }
  }

  if (query.isLoading || !loaded) {
    return (
      <main className="grid min-h-[calc(100vh-var(--dock-height,0px))] place-items-center bg-reader-bg text-ink">
        <p className="text-ink-variant">Opening note…</p>
      </main>
    );
  }
  if (query.isError) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-12 text-ink">
        <h1 className="font-display text-2xl font-semibold">Couldn't open this note</h1>
        <Link to="/notes" className="w-fit rounded border border-line-soft px-4 py-2 text-sm font-medium">
          Back to notes
        </Link>
      </main>
    );
  }

  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  void histTick;

  return (
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] flex-col bg-reader-bg text-ink">
      {/* Header + tool bar are one sticky block pinned to the top of the
          scroll container — not a fixed-bottom overlay. A page sheet taller
          than the viewport can never push either below the fold (brief 26's
          live-audit fix), and the tool bar now sits visually above the sheet
          per design.md, not floating over it. */}
      <div className="sticky top-0 z-20 flex flex-col border-b border-line-soft/50 bg-paper/95 backdrop-blur-sm">
        <header className="flex items-center gap-3 px-4 py-2.5">
          <button
            type="button"
            onClick={() => navigate({ to: "/notes" })}
            className="rounded px-2 py-1 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            aria-label="Back to notes"
          >
            ← Notes
          </button>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Note title"
            className="min-w-0 flex-1 rounded bg-transparent px-1 font-display text-lg font-semibold text-ink outline-none focus:bg-paper-low"
            placeholder="Untitled note"
          />
          <div className="flex items-center gap-1">
            <IconBtn label="Undo" disabled={!canUndo} onClick={undo}>↶</IconBtn>
            <IconBtn label="Redo" disabled={!canRedo} onClick={redo}>↷</IconBtn>
            <ExportControl
              exporting={exporting}
              onExportPdf={exportPdf}
              onExportPng={exportPng}
              pageLabel={`page ${pageIndex + 1}`}
            />
          </div>
        </header>

        {/* Export failures are quiet and inline — the same register as the rest
            of this chrome. `role="status"` so it is announced without stealing
            focus from the sheet. */}
        {exportError && (
          <p role="status" className="px-4 pb-2 font-ui text-xs text-danger">
            {exportError}
          </p>
        )}

        <Toolbar
          tool={tool}
          setTool={setTool}
          nib={nib}
          setNib={setNib}
          color={color}
          setColor={setColor}
          thickness={thickness}
          setThickness={setThickness}
          template={page.template}
          setTemplate={setPageTemplate}
          pageIndex={pageIndex}
          pageCount={pages.length}
          onPrevPage={() => setPageIndex((i) => Math.max(0, i - 1))}
          onNextPage={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
          onAddPage={() => {
            snapshot();
            setPages((prev) => [...prev, structuredClone(BLANK_PAGE)]);
            setPageIndex(pages.length);
          }}
        />
      </div>

      {/* Sheet ground — paper-low, the L1 card treatment lives on the sheet itself. */}
      <div className="flex flex-1 justify-center overflow-auto bg-paper-low px-4 py-6">
        <NoteSheet
          page={page}
          tool={tool}
          color={color}
          thickness={THICKNESS[thickness]}
          onBeginChange={snapshot}
          onMutatePage={mutatePage}
        />
      </div>
    </div>
  );
}

/**
 * The drawing surface for one page: a light paper sheet with an SVG ink layer
 * (committed strokes + the live stroke) and absolutely-positioned text boxes.
 * All pointer input (mouse / touch / stylus) flows through here.
 */
function NoteSheet({
  page,
  tool,
  color,
  thickness,
  onBeginChange,
  onMutatePage,
}: {
  page: NotePage;
  tool: Tool;
  color: string;
  thickness: number;
  onBeginChange: () => void;
  onMutatePage: (fn: (p: NotePage) => NotePage) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  // `live` drives the in-progress preview render; `pointsRef` is the
  // authoritative point buffer read at commit time (state is async).
  const [live, setLive] = useState<StrokePoint[] | null>(null);
  const pointsRef = useRef<StrokePoint[]>([]);
  const drawing = useRef(false);
  const activePointer = useRef<number | null>(null);

  // --- Pinch-to-zoom (mobile) ----------------------------------------------
  // The zoom/pan transform is applied to the sheet element itself. Because
  // `toNorm` derives normalized coords from getBoundingClientRect() (which
  // reflects CSS transforms) divided by the transformed width, drawing stays
  // pixel-accurate at any zoom — no changes to the ink math are needed.
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  // True while a two-finger gesture is in flight, so pointer handlers stand
  // down (the first finger must not leave a stray stroke behind).
  const gesturing = useRef(false);
  // Enables a CSS transition only for the "reset zoom" tween, never during a
  // live pinch (which would lag a frame behind the fingers).
  const [animating, setAnimating] = useState(false);
  // design.md "Motion degrades": the reset tween is the one animation on this
  // surface, so it needs a reduced-motion path. Under `reduce` the sheet snaps
  // back to its resting transform instead of gliding.
  const reducedMotion = usePrefersReducedMotion();

  // Keep the panned sheet from drifting entirely off its own footprint.
  const clampPan = useCallback(
    (scale: number, x: number, y: number) => {
      if (scale <= 1) return { x: 0, y: 0 };
      const h = width * PAGE_ASPECT;
      return {
        x: Math.min(0, Math.max(-(scale - 1) * width, x)),
        y: Math.min(0, Math.max(-(scale - 1) * h, y)),
      };
    },
    [width],
  );

  usePinch(
    ({ origin: [ox, oy], offset: [scale], first, last, memo }) => {
      if (first) {
        // A pinch just began — discard any stroke the first finger started.
        drawing.current = false;
        activePointer.current = null;
        pointsRef.current = [];
        setLive(null);
        gesturing.current = true;
        setAnimating(false);
        const rect = ref.current!.getBoundingClientRect();
        const cur = transformRef.current;
        // transform-origin is the top-left corner, so scaling never moves
        // left/top — only our translate does. Recover the untransformed
        // origin, then the sheet-local point (0..width) under the fingers.
        memo = {
          layoutLeft: rect.left - cur.x,
          layoutTop: rect.top - cur.y,
          lx: (ox - rect.left) / cur.scale,
          ly: (oy - rect.top) / cur.scale,
        };
      }
      const m = memo as { layoutLeft: number; layoutTop: number; lx: number; ly: number };
      // Solve for the translate that keeps point (lx, ly) pinned under the
      // (moving) finger midpoint — this yields zoom-about-fingers plus
      // two-finger panning in one step.
      const { x, y } = clampPan(scale, ox - m.layoutLeft - scale * m.lx, oy - m.layoutTop - scale * m.ly);
      setTransform({ scale, x, y });
      if (last) gesturing.current = false;
      return memo;
    },
    {
      target: ref,
      eventOptions: { passive: false },
      scaleBounds: { min: 1, max: MAX_ZOOM },
      from: () => [transformRef.current.scale, 0],
    },
  );

  const resetZoom = useCallback(() => {
    setAnimating(true);
    setTransform({ scale: 1, x: 0, y: 0 });
    setTimeout(() => setAnimating(false), 180);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const toNorm = useCallback((clientX: number, clientY: number): [number, number] => {
    const rect = ref.current!.getBoundingClientRect();
    // Divide both axes by width so the aspect ratio is preserved (y ∈ 0..ASPECT).
    return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.width];
  }, []);

  const eraseAt = useCallback(
    (nx: number, ny: number) => {
      onMutatePage((p) => {
        const kept = p.strokes.filter(
          (s) => !s.points.some((pt) => Math.hypot(pt[0] - nx, pt[1] - ny) < ERASE_RADIUS + s.size),
        );
        return kept.length === p.strokes.length ? p : { ...p, strokes: kept };
      });
    },
    [onMutatePage],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // A two-finger zoom/pan is underway — don't treat touches as ink.
    if (gesturing.current) return;
    // Single active pointer → basic palm rejection (a resting palm's touch is
    // ignored while another pointer is drawing).
    if (activePointer.current !== null) return;

    if (tool === "text") {
      // Clicking empty space with the text tool places a new box.
      if ((e.target as HTMLElement).closest("[data-textbox]")) return;
      const [nx, ny] = toNorm(e.clientX, e.clientY);
      onBeginChange();
      const box: TextBox = { id: crypto.randomUUID(), x: nx, y: ny, w: 0.4, text: "", size: 0.03 };
      onMutatePage((p) => ({ ...p, texts: [...p.texts, box] }));
      return;
    }

    activePointer.current = e.pointerId;
    // setPointerCapture can throw for an already-released/synthetic pointer; a
    // failed capture just means moves outside the element are missed, not a crash.
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* non-fatal */
    }
    drawing.current = true;
    const [nx, ny] = toNorm(e.clientX, e.clientY);
    if (tool === "eraser") {
      onBeginChange();
      eraseAt(nx, ny);
      return;
    }
    const first: StrokePoint = [nx, ny, e.pressure || 0.5];
    pointsRef.current = [first];
    setLive([first]);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drawing.current || e.pointerId !== activePointer.current) return;
    // Recover the high-frequency samples between frames for smooth fast strokes.
    // getCoalescedEvents() can return an empty array (synthetic events, some
    // browsers) — fall back to the event itself so points aren't dropped.
    const coalesced = e.nativeEvent.getCoalescedEvents?.();
    const events = coalesced && coalesced.length ? coalesced : [e.nativeEvent];
    if (tool === "eraser") {
      for (const ev of events) {
        const [nx, ny] = toNorm(ev.clientX, ev.clientY);
        eraseAt(nx, ny);
      }
      return;
    }
    for (const ev of events) {
      const [nx, ny] = toNorm(ev.clientX, ev.clientY);
      pointsRef.current.push([nx, ny, ev.pressure || 0.5]);
    }
    setLive([...pointsRef.current]);
  }

  function endStroke() {
    const wasDrawing = drawing.current;
    drawing.current = false;
    activePointer.current = null;
    if (!wasDrawing || tool === "eraser") return;
    const pts = pointsRef.current;
    pointsRef.current = [];
    setLive(null);
    if (pts.length > 1) {
      // `endStroke` returns early for the eraser and the text tool never starts
      // one, so the tool here is always an ink kind; `pen` is a total-function
      // fallback, not a real branch.
      const inkTool: NoteTool = isInkTool(tool) ? tool : "pen";
      const size = inkTool === "highlighter" ? thickness * HIGHLIGHTER_SCALE : thickness;
      const stroke: Stroke = { tool: inkTool, color, size, points: pts };
      onBeginChange();
      onMutatePage((p) => ({ ...p, strokes: [...p.strokes, stroke] }));
    }
  }

  const height = width * PAGE_ASPECT;
  const zoomed = transform.scale > 1.01;

  return (
    <>
    <div
      ref={ref}
      className="relative w-full max-w-3xl shrink-0 touch-none overflow-hidden rounded-card border border-line-soft shadow-l1"
      style={{
        height,
        // The sheet is a fixed light paper in every theme (see the header note),
        // so this token is deliberately not remapped by `data-theme`.
        background: "var(--note-sheet)",
        cursor: tool === "eraser" ? "cell" : tool === "text" ? "text" : "crosshair",
        transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        transformOrigin: "0 0",
        transition:
          animating && !reducedMotion ? `transform 180ms ${EASE_PAPER_CSS}` : "none",
        willChange: "transform",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
      onPointerLeave={(e) => {
        if (drawing.current && e.pointerId === activePointer.current) endStroke();
      }}
    >
      <PageBackground template={page.template} />

      <svg
        viewBox={`0 0 ${STROKE_VB} ${STROKE_VB * PAGE_ASPECT}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {page.strokes.map((s, i) => (
          <InkStroke key={i} stroke={s} />
        ))}
        {live && live.length > 0 && (
          <InkStroke
            stroke={{
              tool: isInkTool(tool) ? tool : "pen",
              color,
              size: tool === "highlighter" ? thickness * HIGHLIGHTER_SCALE : thickness,
              points: live,
            }}
          />
        )}
      </svg>

      {page.texts.map((box) => (
        <TextBoxView
          key={box.id}
          box={box}
          width={width}
          editable={tool === "text"}
          onBeginChange={onBeginChange}
          onChange={(patch) =>
            onMutatePage((p) => ({
              ...p,
              texts: p.texts.map((t) => (t.id === box.id ? { ...t, ...patch } : t)),
            }))
          }
          onRemove={() =>
            onMutatePage((p) => ({ ...p, texts: p.texts.filter((t) => t.id !== box.id) }))
          }
        />
      ))}
    </div>

    {/* Reset-zoom affordance — only while pinched in. It used to sit at
        `bottom-28` to clear a fixed bottom tool bar; brief 33 moved that bar
        into the sticky block above the sheet, so the offset now only has to
        clear the player dock (brief 31), which may or may not be present. */}
    {zoomed && (
      <button
        type="button"
        onClick={resetZoom}
        style={{ bottom: "calc(1rem + var(--dock-height, 0px))" }}
        className="fixed right-4 z-30 flex items-center gap-1.5 rounded-chip border border-line-soft/60 bg-paper/95 px-3 py-1.5 font-ui text-xs font-medium text-ink-variant shadow-l1 backdrop-blur-sm transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        aria-label="Reset zoom"
      >
        <span aria-hidden="true">⤢</span> {Math.round(transform.scale * 100)}%
      </button>
    )}
    </>
  );
}

/**
 * One stroke as SVG. A nib is a LIST of passes, so this is a fragment of paths
 * rather than a single `<path>` — the pencil's three overlaid, seeded-jittered
 * outlines are what give it its tooth.
 */
function InkStroke({ stroke }: { stroke: Stroke }) {
  const layers = strokeLayers(stroke);
  return (
    <>
      {layers.map((layer, i) => (
        <path key={i} d={layer.d} fill={stroke.color} fillOpacity={layer.opacity} />
      ))}
    </>
  );
}

function TextBoxView({
  box,
  width,
  editable,
  onBeginChange,
  onChange,
  onRemove,
}: {
  box: TextBox;
  width: number;
  editable: boolean;
  onBeginChange: () => void;
  onChange: (patch: Partial<TextBox>) => void;
  onRemove: () => void;
}) {
  const dragging = useRef<{ dx: number; dy: number } | null>(null);

  function onGripDown(e: ReactPointerEvent<HTMLButtonElement>) {
    e.stopPropagation();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* non-fatal */
    }
    onBeginChange();
    dragging.current = { dx: e.clientX - box.x * width, dy: e.clientY - box.y * width };
  }
  function onGripMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging.current) return;
    onChange({ x: (e.clientX - dragging.current.dx) / width, y: (e.clientY - dragging.current.dy) / width });
  }
  function onGripUp() {
    dragging.current = null;
  }

  return (
    <div
      data-textbox
      className="absolute"
      style={{ left: box.x * width, top: box.y * width, width: box.w * width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {editable && (
        <div className="absolute -top-6 left-0 flex items-center gap-1">
          <button
            type="button"
            aria-label="Move text box"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            className="cursor-move touch-none rounded bg-accent/90 px-1.5 text-xs text-white"
          >
            ⠿
          </button>
          <button
            type="button"
            aria-label="Delete text box"
            onClick={() => {
              onBeginChange();
              onRemove();
            }}
            className="rounded bg-danger/90 px-1.5 text-xs text-white"
          >
            ✕
          </button>
        </div>
      )}
      <textarea
        value={box.text}
        readOnly={!editable}
        onChange={(e) => onChange({ text: e.target.value })}
        onFocus={onBeginChange}
        rows={1}
        placeholder={editable ? "Type…" : ""}
        className="w-full resize-none bg-transparent leading-snug text-note-sheet-ink outline-none"
        style={{ fontSize: box.size * width, fontFamily: "var(--font-ui)" }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- nib picker */
/*
 * Brief 51 added two nibs, and brief 26's live audit + brief 33 both say the
 * tool bar must stay above the fold at 375px. Six flat buttons would have made
 * the tool group alone wider than a phone's toolbar row, so the three nibs
 * share ONE slot with a popover — the bar is the same size it was with two
 * tools, and there is room left for the ink, thickness and page-background
 * groups beside it.
 */

/**
 * A live sample of a nib, drawn with the real `strokeLayers` — so the picker
 * shows what the nib actually does rather than a glyph standing in for it.
 * That is also the honest answer to "is this nib distinct?": if two rows look
 * the same here, they look the same on the page.
 */
const SWATCH_POINTS: StrokePoint[] = Array.from({ length: 28 }, (_, i) => {
  const t = i / 27;
  return [
    0.05 + t * 0.9,
    0.11 - Math.sin(t * Math.PI * 1.6) * 0.022,
    // A pressure swell, so the fountain pen's flex and the pen's gentler
    // taper are both visible. Never 0.5, so this reads as REAL pressure and
    // the sample is not at the mercy of simulated velocity.
    0.14 + Math.sin(t * Math.PI) * 0.84,
  ];
});
const SWATCH_SIZE = 0.05;
const SWATCH_VIEWBOX = "30 30 940 150";

function NibSwatch({ nib, color, className }: { nib: NoteNib; color: string; className: string }) {
  const layers = strokeLayers({ tool: nib, color, size: SWATCH_SIZE, points: SWATCH_POINTS });
  return (
    <svg viewBox={SWATCH_VIEWBOX} className={className} aria-hidden="true">
      {layers.map((layer, i) => (
        <path key={i} d={layer.d} fill={color} fillOpacity={layer.opacity} />
      ))}
    </svg>
  );
}

/**
 * The three nib marks, as inline line icons (design.md: line icons, 1.75
 * stroke, no icon font). One barrel shape; the tip is the discriminator —
 * bare wedge, wedge with a nib slit, wedge with a wood band.
 */
const NIB_ICON_PATHS: Record<NoteNib, string[]> = {
  pen: ["M4 20 L6.5 14.5 L15.5 5.5 L18.5 8.5 L9.5 17.5 Z"],
  "fountain-pen": ["M4 20 L7 13.5 L15.5 5 L19 8.5 L10.5 17 Z", "M4 20 L11.5 12.5"],
  pencil: ["M4 20 L6.5 14.5 L15.5 5.5 L18.5 8.5 L9.5 17.5 Z", "M6.5 14.5 L9.5 17.5", "M12.5 8.5 L15.5 11.5"],
};

function NibIcon({ nib }: { nib: NoteNib }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {NIB_ICON_PATHS[nib].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The ink slot: a radio in the tool group that also opens the nib list.
 *
 * One click when the slot is NOT active selects it (with whatever nib was last
 * used) — the common case costs nothing. Clicking it again opens the list, and
 * the caret is what says the slot has one. Nothing here animates beyond the
 * colour fade the rest of the chrome uses, so there is no reduced-motion path
 * to lose.
 */
function NibSlot({
  nib,
  active,
  onSelect,
  color,
}: {
  nib: NoteNib;
  active: boolean;
  onSelect: (nib: NoteNib) => void;
  color: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on an outside press or Escape — a popover that can only be closed
  // by picking something is a trap on a phone.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${NOTE_TOOL_LABELS[nib]} — choose nib`}
        title={`${NOTE_TOOL_LABELS[nib]} — choose nib`}
        onClick={() => {
          if (active) setOpen((v) => !v);
          else {
            onSelect(nib);
            setOpen(false);
          }
        }}
        className={`grid h-9 w-12 grid-flow-col place-items-center gap-0.5 rounded-card transition focus-visible:outline-2 focus-visible:outline-accent ${
          active ? "bg-paper-raised text-accent shadow-sm" : "text-ink-variant hover:text-ink"
        }`}
      >
        <NibIcon nib={nib} />
        <span aria-hidden="true" className="font-ui text-[9px] leading-none">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Nib"
          className="absolute left-0 top-full z-30 mt-1.5 flex w-56 flex-col gap-0.5 rounded-card border border-line-soft bg-paper-raised p-1 shadow-l1"
        >
          {NOTE_NIBS.map((value) => {
            const chosen = active && value === nib;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={chosen}
                onClick={() => {
                  onSelect(value);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 rounded-card px-2 py-1.5 text-left font-ui text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-accent ${
                  chosen ? "bg-paper-low text-accent" : "text-ink-variant hover:bg-paper-low hover:text-ink"
                }`}
              >
                <NibIcon nib={value} />
                <span className="w-24 shrink-0">{NOTE_TOOL_LABELS[value]}</span>
                <NibSwatch nib={value} color={color} className="h-5 w-full min-w-0" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Toolbar({
  tool,
  setTool,
  nib,
  setNib,
  color,
  setColor,
  thickness,
  setThickness,
  template,
  setTemplate,
  pageIndex,
  pageCount,
  onPrevPage,
  onNextPage,
  onAddPage,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  /** The nib the single ink slot is currently loaded with. */
  nib: NoteNib;
  setNib: (n: NoteNib) => void;
  color: string;
  setColor: (c: string) => void;
  thickness: number;
  setThickness: (t: number) => void;
  template: PageTemplate;
  setTemplate: (t: PageTemplate) => void;
  /** Page indicator, in tabular figures (design.md "Numbers line up") — lives in
   * the tool bar itself now, not split into a separate header cluster. */
  pageIndex: number;
  pageCount: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onAddPage: () => void;
}) {
  // The three nibs share the ink slot; these are the tools that do not.
  const tools: { value: Tool; label: string; glyph: string }[] = [
    { value: "highlighter", label: NOTE_TOOL_LABELS.highlighter, glyph: "▄" },
    { value: "eraser", label: "Eraser", glyph: "⌫" },
    { value: "text", label: "Text", glyph: "T" },
  ];
  // Resolved once: the ink tokens are theme-independent, so they never change
  // under the user (and `getComputedStyle` is not worth paying per render).
  const inks = useMemo(() => INKS.map((i) => ({ ...i, value: cssToken(i.token) })), []);
  const templates: Record<PageTemplate, { label: string; glyph: string }> = {
    blank: { label: "Blank page", glyph: "▢" },
    ruled: { label: "Ruled page", glyph: "≣" },
    grid: { label: "Grid page", glyph: "▦" },
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line-soft/50 px-4 py-2.5">
      <div role="radiogroup" aria-label="Tool" className="flex items-center gap-1 rounded border border-line-soft/60 bg-paper-low p-0.5">
        <NibSlot
          nib={nib}
          active={tool === nib}
          color={color}
          onSelect={(next) => {
            setNib(next);
            setTool(next);
          }}
        />
        {tools.map((t) => {
          const active = tool === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={t.label}
              title={t.label}
              onClick={() => setTool(t.value)}
              className={`grid h-9 w-10 place-items-center rounded-card text-base transition focus-visible:outline-2 focus-visible:outline-accent ${
                active ? "bg-paper-raised text-accent shadow-sm" : "text-ink-variant hover:text-ink"
              }`}
            >
              {t.glyph}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5" aria-label="Color">
        {inks.map((ink) => (
          <button
            key={ink.token}
            type="button"
            aria-label={ink.name}
            aria-pressed={color === ink.value}
            onClick={() => setColor(ink.value)}
            className={`h-6 w-6 rounded-full ring-1 ring-black/10 transition ${
              color === ink.value ? "outline-2 outline-offset-2 outline-accent" : ""
            }`}
            style={{ background: `var(${ink.token})` }}
          />
        ))}
      </div>

      <div role="radiogroup" aria-label="Thickness" className="flex items-center gap-1 rounded border border-line-soft/60 bg-paper-low p-0.5">
        {THICKNESS.map((_, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={thickness === i}
            aria-label={`Thickness ${i + 1}`}
            onClick={() => setThickness(i)}
            className={`grid h-9 w-9 place-items-center rounded-card transition focus-visible:outline-2 focus-visible:outline-accent ${
              thickness === i ? "bg-paper-raised shadow-sm" : "hover:bg-paper-container"
            }`}
          >
            <span className="rounded-full bg-ink" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
          </button>
        ))}
      </div>

      {/* Page background — a per-page property (blank / ruled / grid). */}
      <div role="radiogroup" aria-label="Page background" className="flex items-center gap-1 rounded border border-line-soft/60 bg-paper-low p-0.5">
        {PAGE_TEMPLATES.map((value: PageTemplate) => {
          const active = template === value;
          const { label, glyph } = templates[value];
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={label}
              title={label}
              onClick={() => setTemplate(value)}
              className={`grid h-9 w-9 place-items-center rounded-card text-base transition focus-visible:outline-2 focus-visible:outline-accent ${
                active ? "bg-paper-raised text-accent shadow-sm" : "text-ink-variant hover:text-ink"
              }`}
            >
              {glyph}
            </button>
          );
        })}
      </div>

      {/* Page indicator — tabular figures (design.md "Numbers line up"), same
          cluster shape as the reader's page nav. Pushed to the far end on wide
          toolbars, wraps onto its own line on narrow ones. */}
      <div className="ml-auto flex items-center gap-0.5 rounded-chip bg-paper-low px-1.5 py-1 font-ui text-xs text-ink-variant">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={onPrevPage}
          className="px-1.5 text-base disabled:opacity-30"
          aria-label="Previous page"
        >
          ‹
        </button>
        <span className="tabular-nums" aria-label={`Page ${pageIndex + 1} of ${pageCount}`}>
          {pageIndex + 1}/{pageCount}
        </span>
        <button
          type="button"
          disabled={pageIndex === pageCount - 1}
          onClick={onNextPage}
          className="px-1.5 text-base disabled:opacity-30"
          aria-label="Next page"
        >
          ›
        </button>
        <button
          type="button"
          onClick={onAddPage}
          className="ml-1 border-l border-line-soft/50 pl-1.5 text-accent"
          aria-label="Add page"
        >
          + Page
        </button>
      </div>
    </div>
  );
}

/**
 * The export control (brief 49) — two plainly-labelled actions rather than a
 * popover, because there are exactly two and a menu would hide both behind an
 * extra click. It sits with undo/redo: both are things you do *to* the open
 * note, not tools you draw with, so neither belongs in the tool bar.
 *
 * Reading Room conformance: theme tokens only (no raw hex), `font-ui`
 * (Archivo) like the rest of the chrome, accent reserved for state — the focus
 * ring — with the labels themselves in `ink-variant`. The only motion is the
 * hover colour fade, and it is dropped entirely under `prefers-reduced-motion`.
 */
function ExportControl({
  exporting,
  onExportPdf,
  onExportPng,
  pageLabel,
}: {
  exporting: null | "pdf" | "png";
  onExportPdf: () => void;
  onExportPng: () => void;
  pageLabel: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const busy = exporting !== null;
  const item = `rounded-chip px-2 py-1 font-ui text-xs font-medium text-ink-variant hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent ${
    reducedMotion ? "" : "transition"
  }`;
  return (
    <div className="ml-1 flex items-center gap-0.5 rounded-chip bg-paper-low px-1 py-0.5" role="group" aria-label="Export">
      <span aria-hidden="true" className="pl-1.5 pr-0.5 font-ui text-xs text-ink-variant/70">
        ↓
      </span>
      <button
        type="button"
        className={item}
        disabled={busy}
        onClick={onExportPdf}
        aria-label="Export note as PDF"
        title="Export note as PDF"
      >
        {exporting === "pdf" ? "PDF…" : "PDF"}
      </button>
      <button
        type="button"
        className={item}
        disabled={busy}
        onClick={onExportPng}
        aria-label={`Export ${pageLabel} as PNG`}
        title={`Export ${pageLabel} as PNG`}
      >
        {exporting === "png" ? "PNG…" : "PNG"}
      </button>
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded text-lg text-ink-variant transition hover:bg-paper-low hover:text-ink disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}
