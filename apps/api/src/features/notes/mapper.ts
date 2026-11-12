import { notePageSchema, type Note, type NoteFolder, type NotePage, type NoteSummary } from "@ebook-reader/shared";
import type { NoteFolderRow } from "./folders-store.js";
import type { NoteRow, NoteSummaryRow } from "./store.js";

/**
 * Row → wire for notes and folders. Page contents live as JSON in the row's
 * `data` column; the wire shape is the shared `Note` / `NoteSummary`.
 */

/** What a new note starts with: one empty page. */
export const BLANK_PAGE: NotePage = { strokes: [], texts: [], template: "blank" };

/**
 * Decode the JSON `data` column to `NotePage[]`.
 *
 * Empty on garbage rather than throwing: a `data` blob corrupted out of band
 * would otherwise make the note permanently unopenable and unfixable through
 * the app, where an empty notebook can at least be deleted or written over.
 */
function parsePages(data: string): NotePage[] {
  try {
    const parsed = JSON.parse(data);
    // Each stored page is decoded with the page schema, which reads a missing
    // template as blank and an unknown tool as the pen: a response schema only
    // encodes, and would refuse both. A page that is wrong in any other way is
    // kept as stored, and the reply's schema refuses it (a 500), as before.
    return Array.isArray(parsed)
      ? parsed.map((page: unknown) => {
          const decoded = notePageSchema.safeParse(page);
          return decoded.success ? decoded.data : (page as NotePage);
        })
      : [];
  } catch {
    return [];
  }
}

export function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    pages: parsePages(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Counted in SQL (`listNotes`), so the list path parses no JSON at all. */
export function toSummary(row: NoteSummaryRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    pageCount: Number(row.page_count),
    folderId: row.folder_id,
  };
}

export function toFolder(row: NoteFolderRow): NoteFolder {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}
