import type { Note, NoteFolder, NotePage, NoteSummary } from "@ebook-reader/shared";
import type { NoteFolderRow } from "./note-folders.model.js";
import type { NoteRow } from "./notes.model.js";

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
    return Array.isArray(parsed) ? (parsed as NotePage[]) : [];
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

export function toSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    pageCount: parsePages(row.data).length,
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
