import { getStroke } from "perfect-freehand";
import { usePinch } from "@use-gesture/react";
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
  PAGE_ASPECT,
  PAGE_TEMPLATES,
  type NotePage,
  type PageTemplate,
  type Stroke,
  type StrokePoint,
  type TextBox,
} from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { cssToken } from "../lib/tokens";
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

type Tool = "pen" | "highlighter" | "eraser" | "text";

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
const HIGHLIGHTER_SCALE = 4;
const ERASE_RADIUS = 0.02;
// perfect-freehand's smoothing/streamline math is tuned for pixel-scale inputs;
// running it on tiny normalized (0..1) coordinates degenerates into huge blobs.
// So compute stroke geometry in a scaled-up viewBox space (points ×VB, size
// ×VB) while storage stays normalized. The SVG uses the same viewBox.
const STROKE_VB = 1000;

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

/** perfect-freehand outline for a stroke, computed in the scaled viewBox space. */
function strokePath(stroke: Stroke): string {
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

/**
 * The page's background ruling, drawn behind the ink in the same scaled viewBox
 * space (so it scales with the sheet, `preserveAspectRatio="none"` like the ink
 * layer). `blank` renders nothing.
 */
function PageBackground({ template }: { template: PageTemplate }) {
  if (template === "blank") return null;
  const w = STROKE_VB;
  const h = STROKE_VB * PAGE_ASPECT;
  const lines: ReactNode[] = [];
  // Horizontal rules (ruled + grid). Start one step down so the top edge is clear.
  for (let y = RULE_STEP; y < h - 1; y += RULE_STEP) {
    lines.push(<line key={`h${y}`} x1={0} y1={y} x2={w} y2={y} />);
  }
  // Vertical rules (grid only).
  if (template === "grid") {
    for (let x = RULE_STEP; x < w - 1; x += RULE_STEP) {
      lines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={h} />);
    }
  }
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

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(() => cssToken(INKS[0].token));
  const [thickness, setThickness] = useState(1);

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
          </div>
        </header>

        <Toolbar
          tool={tool}
          setTool={setTool}
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
      const size = tool === "highlighter" ? thickness * HIGHLIGHTER_SCALE : thickness;
      const stroke: Stroke = {
        tool: tool === "highlighter" ? "highlighter" : "pen",
        color,
        size,
        points: pts,
      };
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
        transition: animating ? "transform 0.18s ease-out" : "none",
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
          <path
            key={i}
            d={strokePath(s)}
            fill={s.color}
            fillOpacity={s.tool === "highlighter" ? 0.4 : 1}
          />
        ))}
        {live && live.length > 0 && (
          <path
            d={strokePath({
              tool: tool === "highlighter" ? "highlighter" : "pen",
              color,
              size: tool === "highlighter" ? thickness * HIGHLIGHTER_SCALE : thickness,
              points: live,
            })}
            fill={color}
            fillOpacity={tool === "highlighter" ? 0.4 : 1}
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

function Toolbar({
  tool,
  setTool,
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
  const tools: { value: Tool; label: string; glyph: string }[] = [
    { value: "pen", label: "Pen", glyph: "✎" },
    { value: "highlighter", label: "Highlighter", glyph: "▄" },
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
              className={`grid h-9 w-10 place-items-center rounded-[3px] text-base transition focus-visible:outline-2 focus-visible:outline-accent ${
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
            className={`grid h-9 w-9 place-items-center rounded-[3px] transition focus-visible:outline-2 focus-visible:outline-accent ${
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
              className={`grid h-9 w-9 place-items-center rounded-[3px] text-base transition focus-visible:outline-2 focus-visible:outline-accent ${
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
      <div className="ml-auto flex items-center gap-0.5 rounded-full bg-paper-low px-1.5 py-1 font-ui text-xs text-ink-variant">
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
