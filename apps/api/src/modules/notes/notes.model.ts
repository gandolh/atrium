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

/** What the notes list needs of a row: never the ink (brief 66). */
export type NoteSummaryRow = Pick<NoteRow, "id" | "title" | "updated_at" | "folder_id"> & {
  page_count: number;
};

/**
 * The notes list, newest first, **without `data`** (brief 66). `data` is the
 * whole notebook's ink, and the list used to move every notebook through the
 * one database connection (D47) and `JSON.parse` it on the event loop only to
 * count pages. The count is taken in SQL instead, matching `parsePages`
 * exactly: a JSON array's length, and 0 for anything else, malformed JSON
 * included. The JSON1 functions are compiled into better-sqlite3's SQLite.
 */
export async function listNotes(profileId: string): Promise<NoteSummaryRow[]> {
  return (await knex("notes")
    .select("id", "title", "updated_at", "folder_id")
    .select(
      knex.raw(
        "CASE WHEN json_valid(data) AND json_type(data) = 'array' THEN json_array_length(data) ELSE 0 END AS page_count",
      ),
    )
    .where({ profile_id: profileId })
    .orderBy("updated_at", "desc")) as NoteSummaryRow[];
}

/** How many notes a profile has; the profile-delete checks need only this. */
export async function countNotes(profileId: string): Promise<number> {
  const [{ n }] = (await knex("notes").where({ profile_id: profileId }).count({ n: "*" })) as { n: number }[];
  return Number(n);
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
