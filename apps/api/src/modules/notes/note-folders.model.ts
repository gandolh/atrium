import { knex } from "../../database/knex.js";

/**
 * Data access for `note_folders` — the per-profile tree notes are filed into
 * (brief 50). A folder is a ROW with a `parent_id`, never a path string, and
 * the **root is `parent_id IS NULL`**: there is no root row, so an untouched
 * profile simply has no folders.
 */

/**
 * One note folder. Names are free text and are NOT unique — two folders may
 * share a name, because a folder is a label the owner chose, not a key.
 */
export interface NoteFolderRow {
  id: string;
  profile_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
}

/**
 * Ceiling on the ancestry walk in `wouldCycleNoteFolder`. A tree built through
 * the API cannot contain a cycle — this function is what prevents one — so
 * hitting the limit means the table has been corrupted out of band. Bounded so
 * that case is a rejected request rather than a hung one.
 */
const MAX_FOLDER_DEPTH = 64;

export async function listNoteFolders(profileId: string): Promise<NoteFolderRow[]> {
  return (await knex("note_folders")
    .where({ profile_id: profileId })
    .orderByRaw("name COLLATE NOCASE")) as NoteFolderRow[];
}

export async function getNoteFolder(
  profileId: string,
  id: string,
): Promise<NoteFolderRow | undefined> {
  return (await knex("note_folders").where({ id, profile_id: profileId }).first()) as
    | NoteFolderRow
    | undefined;
}

export async function insertNoteFolder(row: NoteFolderRow): Promise<void> {
  await knex("note_folders").insert(row);
}

/**
 * Would re-parenting `folderId` under `parentId` make a cycle? Walks up from
 * the proposed parent looking for the folder being moved: finding it means the
 * move would detach a subtree from the root and strand it, unreachable and
 * un-deletable.
 *
 * Returns true on an unresolvable chain too (the walk ran past
 * `MAX_FOLDER_DEPTH` with a parent still to visit) — refusing a move we cannot
 * prove safe is the correct failure here.
 */
export async function wouldCycleNoteFolder(
  profileId: string,
  folderId: string,
  parentId: string | null,
): Promise<boolean> {
  let cursor = parentId;
  for (let depth = 0; cursor !== null && depth < MAX_FOLDER_DEPTH; depth += 1) {
    if (cursor === folderId) return true;
    cursor = (await getNoteFolder(profileId, cursor))?.parent_id ?? null;
  }
  return cursor !== null;
}

export async function renameNoteFolder(
  profileId: string,
  id: string,
  name: string,
): Promise<boolean> {
  const changed = await knex("note_folders").where({ id, profile_id: profileId }).update({ name });
  return changed > 0;
}

export async function setNoteFolderParent(
  profileId: string,
  id: string,
  parentId: string | null,
): Promise<boolean> {
  const changed = await knex("note_folders")
    .where({ id, profile_id: profileId })
    .update({ parent_id: parentId });
  return changed > 0;
}

/**
 * Delete one folder, lifting everything it held to its parent first (brief 50
 * rule 5: **deleting a folder must never delete a notebook**).
 *
 * The lift is not a courtesy — `note_folders.parent_id` carries no `ON DELETE`
 * clause, so SQLite's NO ACTION refuses to remove a folder that still has
 * children. Skipping the lift would make this a constraint error rather than a
 * silent subtree deletion, which is exactly why the constraint is shaped that
 * way; the lift is how the operation succeeds while staying non-destructive.
 *
 * One transaction, because a failure between the lifts and the delete would
 * leave notes filed in a folder that is about to stop existing.
 */
export async function deleteNoteFolder(profileId: string, id: string): Promise<boolean> {
  const folder = await getNoteFolder(profileId, id);
  if (!folder) return false;
  await knex.transaction(async (trx) => {
    await trx("note_folders")
      .where({ parent_id: id, profile_id: profileId })
      .update({ parent_id: folder.parent_id });
    await trx("notes")
      .where({ folder_id: id, profile_id: profileId })
      .update({ folder_id: folder.parent_id });
    await trx("note_folders").where({ id, profile_id: profileId }).delete();
  });
  return true;
}

/**
 * Hand every note and folder of one profile to another, returning the number of
 * notes moved.
 *
 * This is what brief 35 decision 3 requires before a profile can be deleted:
 * notes are *authored*, so they move rather than cascade away (`ON DELETE
 * RESTRICT` on both tables makes forgetting that a loud constraint error).
 *
 * **Folders move with the notes, in the same transaction, and that pairing is
 * the point** — a note handed to another profile while its folder stayed behind
 * would point across a profile boundary, which every folder query (all keyed on
 * `profile_id`) would then treat as unfiled while the row still named a folder.
 *
 * Lives in the folders model rather than the notes one because the folder
 * constraint is what forces the two to travel together.
 */
export async function reassignNotes(
  fromProfileId: string,
  toProfileId: string,
): Promise<number> {
  return knex.transaction(async (trx): Promise<number> => {
    await trx("note_folders")
      .where({ profile_id: fromProfileId })
      .update({ profile_id: toProfileId });
    const moved = await trx("notes")
      .where({ profile_id: fromProfileId })
      .update({ profile_id: toProfileId });
    return moved;
  });
}
