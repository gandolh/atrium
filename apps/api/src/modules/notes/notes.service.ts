import { randomUUID } from "node:crypto";
import { noteSchema, type Note, type NotePage } from "@ebook-reader/shared";
import {
  deleteNoteFolder,
  getNoteFolder,
  insertNoteFolder,
  listNoteFolders,
  renameNoteFolder,
  setNoteFolderParent,
  wouldCycleNoteFolder,
  type NoteFolderRow,
} from "./note-folders.model.js";
import { BLANK_PAGE, toNote } from "./notes.mapper.js";
import {
  deleteNote,
  getNote,
  insertNote,
  listNotes,
  setNoteFolder,
  updateNote,
  type NoteRow,
} from "./notes.model.js";

/**
 * Note and folder rules (briefs 26, 50).
 *
 * Everything here takes a `profileId` as its first argument and passes it into
 * every lookup. That is the authorisation, not a filter: a note id is
 * client-supplied, so a read keyed on id alone would hand one profile's
 * notebook to another. The controller turns a miss into 404 — never 403, which
 * would confirm the id exists on somebody else's tree.
 */

export type MoveNoteResult = { ok: true; note: NoteRow } | { ok: false; reason: "NOT_FOUND" };

export type UpdateFolderResult =
  | { ok: true; folder: NoteFolderRow }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "CYCLE" };

// --- Notes -------------------------------------------------------------------

export async function listProfileNotes(profileId: string): Promise<NoteRow[]> {
  return listNotes(profileId);
}

export async function readNote(profileId: string, id: string): Promise<NoteRow | undefined> {
  return getNote(profileId, id);
}

export async function createNote(profileId: string, title?: string): Promise<NoteRow> {
  const now = new Date().toISOString();
  const row: NoteRow = {
    id: randomUUID(),
    profile_id: profileId,
    title: title?.trim() || "Untitled note",
    data: JSON.stringify([BLANK_PAGE]),
    created_at: now,
    updated_at: now,
    // A new note is born at the root; filing is `PATCH /notes/:id/folder`.
    folder_id: null,
  };
  await insertNote(row);
  return row;
}

/**
 * Save a note's title and/or pages, returning the stored row. Undefined when
 * the note is not this profile's.
 *
 * Re-reads rather than returning the patch applied locally, so the caller gets
 * the canonical stored shape — including the fields this write did not touch.
 */
export async function saveNote(
  profileId: string,
  id: string,
  fields: { title?: string; pages?: NotePage[] },
): Promise<NoteRow | undefined> {
  const ok = await updateNote(
    profileId,
    id,
    {
      title: fields.title,
      data: fields.pages ? JSON.stringify(fields.pages) : undefined,
    },
    new Date().toISOString(),
  );
  if (!ok) return undefined;
  return getNote(profileId, id);
}

export async function removeNote(profileId: string, id: string): Promise<boolean> {
  return deleteNote(profileId, id);
}

/**
 * File a note into a folder — `null` lifts it back to the root.
 *
 * Both ids are resolved profile-scoped, so either one belonging to somebody
 * else is a miss and never a cross-profile file.
 */
export async function moveNote(
  profileId: string,
  id: string,
  folderId: string | null,
): Promise<MoveNoteResult> {
  if (folderId !== null && !(await getNoteFolder(profileId, folderId))) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (!(await setNoteFolder(profileId, id, folderId))) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  return { ok: true, note: (await getNote(profileId, id))! };
}

/**
 * A note in its canonical wire shape, parsed through the shared schema so
 * `template` picks up its default for notes stored before that field existed.
 * The PDF exporter needs exactly this, which is why it is not just `toNote`.
 */
export function canonicalNote(row: NoteRow): Note {
  return noteSchema.parse(toNote(row));
}

// --- Folders -----------------------------------------------------------------

export async function listProfileFolders(profileId: string): Promise<NoteFolderRow[]> {
  return listNoteFolders(profileId);
}

export async function createFolder(
  profileId: string,
  fields: { name: string; parentId?: string | null },
): Promise<NoteFolderRow | undefined> {
  const parentId = fields.parentId ?? null;
  if (parentId !== null && !(await getNoteFolder(profileId, parentId))) return undefined;
  const row: NoteFolderRow = {
    id: randomUUID(),
    profile_id: profileId,
    parent_id: parentId,
    name: fields.name,
    created_at: new Date().toISOString(),
  };
  await insertNoteFolder(row);
  return row;
}

/**
 * Rename and/or reparent a folder.
 *
 * The cycle check is the load-bearing part. `parent_id` describes a tree only
 * for as long as nothing points a folder at one of its own descendants; the
 * moment something does, that subtree is detached from the root and every walk
 * over it — including the list render — runs forever. So this refuses rather
 * than trusting the client not to ask. `parentId: null` means "move to the
 * root" and is always allowed.
 */
export async function updateFolder(
  profileId: string,
  id: string,
  fields: { name?: string; parentId?: string | null },
): Promise<UpdateFolderResult> {
  if (!(await getNoteFolder(profileId, id))) return { ok: false, reason: "NOT_FOUND" };

  const { name, parentId } = fields;
  if (parentId !== undefined && parentId !== null) {
    if (!(await getNoteFolder(profileId, parentId))) return { ok: false, reason: "NOT_FOUND" };
    if (await wouldCycleNoteFolder(profileId, id, parentId)) {
      return { ok: false, reason: "CYCLE" };
    }
  }

  if (name !== undefined) await renameNoteFolder(profileId, id, name);
  if (parentId !== undefined) await setNoteFolderParent(profileId, id, parentId);
  return { ok: true, folder: (await getNoteFolder(profileId, id))! };
}

/**
 * Delete a folder. **Nothing inside it is deleted** — its notes and its child
 * folders are lifted to its own parent first, in one transaction (see
 * `deleteNoteFolder`). A folder is a label; a note is authored work that exists
 * nowhere else, and a mis-clicked delete must not be able to take one.
 */
export async function removeFolder(profileId: string, id: string): Promise<boolean> {
  return deleteNoteFolder(profileId, id);
}
