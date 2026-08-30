import { knex } from "../../database/knex.js";

/**
 * Data access for `notes` — per-profile paged notebooks (brief 26, rescoped by
 * brief 35). Folders are the sibling model, `note-folders.model.ts`; the one
 * operation that spans both (`reassignNotes`) lives there, because it is the
 * folders' RESTRICT constraint that forces the two to move together.
 *
 * Every query here is keyed on `profile_id` as well as `id`. That is the
 * authorisation, not an optimisation: a note id is client-supplied, and a read
 * that matched on id alone would hand one profile's notebook to another.
 */

/** A raw notes row; `data` is JSON-encoded `NotePage[]`. */
export interface NoteRow {
  id: string;
  /** Profile-scoped since brief 35 — a notebook belongs to a person, not a household. */
  profile_id: string;
  title: string;
  data: string;
  created_at: string;
  updated_at: string;
  /**
   * Which folder the note is filed in, or NULL for the root (brief 50).
   * Nullable is the migration's safety property — see the baseline migration's
   * `addNoteFolderColumn`.
   */
  folder_id: string | null;
}

export async function listNotes(profileId: string): Promise<NoteRow[]> {
  return (await knex("notes")
    .where({ profile_id: profileId })
    .orderBy("updated_at", "desc")) as NoteRow[];
}

export async function getNote(profileId: string, id: string): Promise<NoteRow | undefined> {
  return (await knex("notes").where({ id, profile_id: profileId }).first()) as NoteRow | undefined;
}

export async function insertNote(row: NoteRow): Promise<void> {
  await knex("notes").insert(row);
}

/**
 * Patch a note's title and/or contents. COALESCE means a title-only rename
 * leaves the pages alone and a pages-only save leaves the title alone, so the
 * two halves of the editor can write independently.
 */
export async function updateNote(
  profileId: string,
  id: string,
  fields: { title?: string; data?: string },
  now: string,
): Promise<boolean> {
  const changed = await knex("notes")
    .where({ id, profile_id: profileId })
    .update({
      title: knex.raw("COALESCE(?, title)", [fields.title ?? null]),
      data: knex.raw("COALESCE(?, data)", [fields.data ?? null]),
      updated_at: now,
    });
  return changed > 0;
}

export async function deleteNote(profileId: string, id: string): Promise<boolean> {
  const changed = await knex("notes").where({ id, profile_id: profileId }).delete();
  return changed > 0;
}

/** File a note into a folder, or to the root when `folderId` is null. */
export async function setNoteFolder(
  profileId: string,
  id: string,
  folderId: string | null,
): Promise<boolean> {
  const changed = await knex("notes")
    .where({ id, profile_id: profileId })
    .update({ folder_id: folderId });
  return changed > 0;
}
