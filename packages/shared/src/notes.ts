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

/** v1 ink tools (grilled): a solid pen and a translucent highlighter. */
export const NOTE_TOOLS = ["pen", "highlighter"] as const;
export const noteToolSchema = z.enum(NOTE_TOOLS);
export type NoteTool = z.infer<typeof noteToolSchema>;

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
