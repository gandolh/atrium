import { z } from "zod";

/**
 * Notes contract (brief 26) — the shape of a paged note with vector ink +
 * typed text boxes, shared by apps/web and apps/api so they can't drift (D11).
 *
 * Coordinate convention (resolution-independent so a note drawn on a phone
 * renders identically on a monitor): every position is normalized to the page
 * box where width = 1 and height = `PAGE_ASPECT`. Stroke `size` and text `size`
 * are fractions of the page width. The editor multiplies by the page's actual
 * pixel width at render time.
 */

/** Portrait page aspect (height / width) — roughly A-series paper. */
export const PAGE_ASPECT = 1.414;

/**
 * The stored ink kinds. v1 shipped `pen` + `highlighter`; brief 51 added
 * `fountain-pen` and `pencil` after a side-by-side design pass.
 *
 * Order matters only for the tool bar, which reads the nib list below.
 */
export const NOTE_TOOLS = ["pen", "fountain-pen", "pencil", "highlighter"] as const;

/**
 * `.catch("pen")` — an unknown tool value reads back as `pen` instead of
 * throwing. Widening a `z.enum` is a contract change that fails in BOTH
 * directions, and this picks which way it fails: a note saved with a nib a
 * stale client has never heard of still OPENS there, drawn with the plain pen.
 * A bare `z.enum` would throw at `noteSchema.parse` and take the whole note
 * with it. Losing a nib style is a blemish; losing the notebook is not.
 *
 * ## The accepted cost (decided by the owner, brief 51 — do not "fix" this)
 *
 * This is LOSSY, not merely permissive. `apps/web/src/notes/notes-api.ts`
 * parses every fetched note through `noteSchema.parse`, and the editor
 * autosaves from the *parsed* value — so a client on a stale bundle that opens
 * and touches a fountain-pen note rewrites those strokes to `pen`
 * PERMANENTLY. The preserving alternative (keep the raw string, render the
 * fallback) was put to the owner alongside this one and rejected: a single
 * always-current SPA bundle makes the stale-client window small, and one
 * always-valid `NoteTool` union keeps every consumer branch-free.
 */
export const noteToolSchema = z.enum(NOTE_TOOLS).catch("pen");
export type NoteTool = (typeof NOTE_TOOLS)[number];

/**
 * The ink nibs — the tools that lay down a stroke you pick a *style* for.
 * `highlighter` is an ink tool but not a nib: it is a flat chisel with its own
 * width scale and translucency, and it sits beside these in the tool bar
 * rather than inside the nib picker.
 */
export const NOTE_NIBS = ["pen", "fountain-pen", "pencil"] as const;
export type NoteNib = (typeof NOTE_NIBS)[number];

/** Human labels for the tool bar / nib picker. */
export const NOTE_TOOL_LABELS: Record<NoteTool, string> = {
  pen: "Pen",
  "fountain-pen": "Fountain pen",
  pencil: "Pencil",
  highlighter: "Highlighter",
};

/**
 * Page background ruling (v1 follow-up): plain paper, horizontal ruled lines, or
 * a square grid. Drawn behind the ink in normalized page space so it scales with
 * the sheet. `blank` is the default, so notes stored before this field parse
 * cleanly (the `.default` on `notePageSchema.template` fills it in).
 */
export const PAGE_TEMPLATES = ["blank", "ruled", "grid"] as const;
export const pageTemplateSchema = z.enum(PAGE_TEMPLATES);
export type PageTemplate = z.infer<typeof pageTemplateSchema>;

/** One sampled input point: [x, y, pressure] — x/y normalized (see convention). */
export const strokePointSchema = z.tuple([z.number(), z.number(), z.number()]);
export type StrokePoint = z.infer<typeof strokePointSchema>;

export const strokeSchema = z.object({
  tool: noteToolSchema,
  /** CSS color string (a token-derived hex from the editor palette). */
  color: z.string(),
  /** Nib width as a fraction of page width. */
  size: z.number().positive(),
  points: z.array(strokePointSchema),
});
export type Stroke = z.infer<typeof strokeSchema>;

/* -------------------------------------------------------------------------
 * Nib geometry (brief 51) — ONE parameter table, two renderers
 *
 * A stroke's outline is rebuilt from its points in three places: the editor's
 * live sheet + PNG export (`apps/web/src/notes/NoteEditor.tsx`) and the
 * server-side PDF export (`apps/api/src/note-pdf.ts`, brief 49). Brief 49
 * already duplicated the `perfect-freehand` options once, and adding two nibs
 * to only one of the copies would render a fountain pen as a plain pen in the
 * PDF with no error and no diagnostic. So the *parameters* live here, in the
 * package both apps already import, and only the `getStroke` call itself is
 * duplicated. `perfect-freehand` stays a dependency of the two apps — this
 * file describes its options, it does not import it.
 *
 * ## Why a nib is a LIST of passes
 *
 * Every nib is `perfect-freehand` parameters, never a second ink pipeline —
 * but the pencil needs three overlaid passes at different widths, offsets and
 * opacities to read as graphite, so the table's unit is a *pass* and the
 * one-pass nibs are simply lists of length one.
 * ---------------------------------------------------------------------- */

/**
 * The editor's scaled working space. perfect-freehand's smoothing/streamline
 * math is tuned for pixel-scale inputs and degenerates into huge blobs on
 * normalized 0..1 coordinates (live-audit bug #3, brief 26), so geometry is
 * computed with points and sizes multiplied by this. **Storage stays
 * normalized**; only the geometry is scaled.
 */
export const STROKE_VB = 1000;

/** The highlighter's fill opacity — a translucent wash over what it crosses. */
export const HIGHLIGHTER_OPACITY = 0.4;

/** Nib width multiplier for the highlighter's chisel, relative to the pen. */
export const HIGHLIGHTER_SCALE = 4;

/**
 * `perfect-freehand`'s `StrokeOptions`, restated structurally so this package
 * needs no dependency on it. Field-for-field compatible with what `getStroke`
 * accepts.
 */
export interface NibStrokeOptions {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  simulatePressure: boolean;
  easing?: (t: number) => number;
  start?: { taper: number; easing?: (t: number) => number };
  end?: { taper: number; easing?: (t: number) => number };
}

/** One filled outline of a stroke. A nib is one or more of these, in order. */
export interface NibPass {
  /** Options for this pass's `getStroke` call. */
  options: NibStrokeOptions;
  /** `fill-opacity` for the resulting path. */
  opacity: number;
  /**
   * Absolute (already `× size`) jitter amplitude applied to the INPUT points
   * before `getStroke`, and the seed that makes it deterministic. `0` means
   * "use the points as they are".
   */
  jitter: number;
  jitterSeed: number;
}

/**
 * Deterministic ±1 noise from a seed and a point index — a sin-hash, **never
 * `Math.random`**. The pencil's grain must be byte-identical on every render:
 * a random offset would make the graphite crawl on every React re-render and
 * would put different grain in the PDF than on the screen.
 */
export function nibNoise(seed: number, index: number): number {
  const x = Math.sin((index + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * The pencil's three passes, as picked in brief 51's design pass: a full-width
 * base plus two narrower, progressively more scattered passes. Cumulative
 * alpha ≈ 0.70, so it sits lighter on the page than the pen.
 *
 * Known and accepted: the jitter is a multiple of `size`, so the grain scales
 * with the nib and all but vanishes at the thinnest width. Decoupling it would
 * make the tooth constant in absolute units and therefore wrong at the thick
 * nib; the owner took the trade.
 */
const PENCIL_PASSES = [
  { scale: 1.0, amp: 0.0, opacity: 0.42, seed: 1 },
  { scale: 0.76, amp: 0.32, opacity: 0.3, seed: 37 },
  { scale: 0.5, amp: 0.68, opacity: 0.26, seed: 91 },
] as const;

/**
 * The passes that draw one stroke of `tool` at `size` (already in `STROKE_VB`
 * units — i.e. `stroke.size * STROKE_VB`).
 *
 * `realPressure` says whether the points carry genuine stylus pressure; when
 * they do not, perfect-freehand simulates it from velocity, which is what lets
 * a mouse-drawn line still taper.
 */
export function nibPasses(tool: NoteTool, size: number, realPressure: boolean): NibPass[] {
  const simulatePressure = !realPressure;
  switch (tool) {
    // A flat chisel: `thinning: 0` is what gives the highlighter a constant
    // width instead of a pressure-tapered nib.
    case "highlighter":
      return [
        {
          options: { size, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure },
          opacity: HIGHLIGHTER_OPACITY,
          jitter: 0,
          jitterSeed: 0,
        },
      ];

    // A flex nib. The squared `easing` is what makes it a fountain pen: light
    // pressure now means *very* light, so the line swells and thins far more
    // than the pen's. The long end taper is the lifted-off hairline.
    case "fountain-pen":
      return [
        {
          options: {
            size,
            thinning: 0.85,
            smoothing: 0.62,
            streamline: 0.38,
            simulatePressure,
            easing: (t) => t * t,
            start: { taper: size * 0.8 },
            end: { taper: size * 4, easing: (t) => 1 - (1 - t) * (1 - t) },
          },
          opacity: 1,
          jitter: 0,
          jitterSeed: 0,
        },
      ];

    // Graphite. The grain is opacity + seeded jitter across three passes, NOT
    // a bitmap texture and NOT `smoothing`/`streamline` alone: both renderers
    // re-smooth the finished outline with quadratic midpoints, so lowering
    // those changes the stroke's spine and never reaches its edge.
    case "pencil":
      return PENCIL_PASSES.map((p) => ({
        options: {
          size: size * p.scale,
          thinning: 0.62,
          smoothing: 0.1,
          streamline: 0.18,
          simulatePressure,
        },
        opacity: p.opacity,
        jitter: size * p.amp,
        jitterSeed: p.seed,
      }));

    // The baseline, unchanged since v1 — every stored `pen` stroke, and every
    // stroke an unknown tool falls back to, must keep drawing exactly this.
    case "pen":
    default:
      return [
        {
          options: { size, thinning: 0.55, smoothing: 0.5, streamline: 0.5, simulatePressure },
          opacity: 1,
          jitter: 0,
          jitterSeed: 0,
        },
      ];
  }
}

/** True when the points carry genuine stylus pressure rather than the 0.5 default. */
export function hasRealPressure(points: readonly StrokePoint[]): boolean {
  return points.some((p) => p[2] > 0 && p[2] !== 0.5);
}

/**
 * A stroke's points in `STROKE_VB` space, offset by one pass's seeded jitter.
 * Returns `[x, y, pressure]` triples ready to hand to `getStroke`.
 */
export function nibPassPoints(points: readonly StrokePoint[], pass: NibPass): number[][] {
  if (pass.jitter === 0) {
    return points.map((p) => [p[0] * STROKE_VB, p[1] * STROKE_VB, p[2]]);
  }
  return points.map((p, i) => [
    p[0] * STROKE_VB + nibNoise(pass.jitterSeed, i) * pass.jitter,
    p[1] * STROKE_VB + nibNoise(pass.jitterSeed + 0.5, i) * pass.jitter,
    p[2],
  ]);
}

/** The passes for a whole stored stroke — the entry point both renderers use. */
export function strokeNibPasses(stroke: Stroke): NibPass[] {
  return nibPasses(stroke.tool, stroke.size * STROKE_VB, hasRealPressure(stroke.points));
}

export const textBoxSchema = z.object({
  id: z.string(),
  /** Top-left, normalized. */
  x: z.number(),
  y: z.number(),
  /** Width as a fraction of page width. */
  w: z.number(),
  text: z.string(),
  /** Font size as a fraction of page width. */
  size: z.number().positive(),
});
export type TextBox = z.infer<typeof textBoxSchema>;

export const notePageSchema = z.object({
  strokes: z.array(strokeSchema),
  texts: z.array(textBoxSchema),
  /**
   * Background ruling drawn behind the ink. `.default` (not `.optional`) so the
   * parsed shape always carries a value — notes stored before this field read
   * back as "blank", and the editor never has to branch on `undefined`.
   */
  template: pageTemplateSchema.default("blank"),
});
export type NotePage = z.infer<typeof notePageSchema>;

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  pages: z.array(notePageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof noteSchema>;

/**
 * Lightweight row for the notes list (no page contents).
 *
 * `folderId` (brief 50) is on the SUMMARY and deliberately NOT on `noteSchema`
 * above: a note does not know or care what folder it is in — filing is a
 * property of the *list*, which is the only surface that draws the tree. The
 * editor loads a `Note`, and its contract is unchanged by folders.
 * `null` means the root.
 */
export const noteSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  pageCount: z.number().int().nonnegative(),
  folderId: z.string().nullable(),
});
export type NoteSummary = z.infer<typeof noteSummarySchema>;

export const noteListSchema = z.array(noteSummarySchema);

/**
 * `POST /notes` body — optional title (defaults server-side).
 *
 * Unchanged by brief 50: a new note is born at the ROOT and filed afterwards
 * with `PATCH /notes/:id/folder`. Folders are an organising move the owner
 * makes on a note that already exists, so creation stays the one-field request
 * it has always been.
 */
export const createNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
export type CreateNoteRequest = z.infer<typeof createNoteSchema>;

/** `PATCH /notes/:id` body — title and/or full page set. */
export const updateNoteSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pages: z.array(notePageSchema).optional(),
  })
  .refine((v) => v.title !== undefined || v.pages !== undefined, {
    message: "Nothing to update",
  });
export type UpdateNoteRequest = z.infer<typeof updateNoteSchema>;

/* -------------------------------------------------------------------------
 * Note folders (brief 50)
 *
 * A folder is a ROW with a `parentId`, never a path string: a path cannot be
 * renamed atomically, and it goes wrong the first time a name contains the
 * separator. The root is `parentId === null` — there is no root row, so a
 * fresh profile has an empty folder list and every note sits at the root with
 * nothing to migrate.
 * ---------------------------------------------------------------------- */

/** Longest folder name the server accepts — a label, not a document. */
export const MAX_FOLDER_NAME = 120;

export const noteFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `null` = a top-level folder. Never points outside the owning profile. */
  parentId: z.string().nullable(),
  createdAt: z.string(),
});
export type NoteFolder = z.infer<typeof noteFolderSchema>;

export const noteFolderListSchema = z.array(noteFolderSchema);

/** `POST /note-folders` body. Omitted/`null` parent means the root. */
export const createNoteFolderSchema = z.object({
  name: z.string().trim().min(1).max(MAX_FOLDER_NAME),
  parentId: z.string().nullable().optional(),
});
export type CreateNoteFolderRequest = z.infer<typeof createNoteFolderSchema>;

/**
 * `PATCH /note-folders/:id` body — rename and/or reparent.
 *
 * `parentId: null` is a MOVE TO ROOT, which is why the refine below tests
 * `!== undefined` rather than truthiness: `null` and "absent" are different
 * requests here and collapsing them would make root unreachable.
 */
export const updateNoteFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_FOLDER_NAME).optional(),
    parentId: z.string().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parentId !== undefined, {
    message: "Nothing to update",
  });
export type UpdateNoteFolderRequest = z.infer<typeof updateNoteFolderSchema>;

/**
 * `PATCH /notes/:id/folder` body — file a note into a folder, or `null` to
 * lift it back to the root.
 *
 * Its own route rather than a field on `updateNoteSchema` on purpose: the
 * editor's autosave PATCHes title/pages many times a minute and must never be
 * able to move a note as a side effect of a save that raced a move.
 */
export const moveNoteSchema = z.object({
  folderId: z.string().nullable(),
});
export type MoveNoteRequest = z.infer<typeof moveNoteSchema>;
