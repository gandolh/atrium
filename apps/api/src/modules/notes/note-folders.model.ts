import type { Knex } from "knex";
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

/** One folder, read on `db`: the global connection, or a transaction's. */
async function folderOn(
  db: Knex | Knex.Transaction,
  profileId: string,
  id: string,
): Promise<NoteFolderRow | undefined> {
  return (await db("note_folders").where({ id, profile_id: profileId }).first()) as
    | NoteFolderRow
    | undefined;
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
async function wouldCycle(
  trx: Knex.Transaction,
  profileId: string,
  folderId: string,
  parentId: string | null,
): Promise<boolean> {
  let cursor = parentId;
  for (let depth = 0; cursor !== null && depth < MAX_FOLDER_DEPTH; depth += 1) {
    if (cursor === folderId) return true;
    cursor = (await folderOn(trx, profileId, cursor))?.parent_id ?? null;
  }
  return cursor !== null;
}

export type UpdateNoteFolderResult =
  | { ok: true; folder: NoteFolderRow }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "CYCLE" };

/**
 * Rename and/or re-parent a folder, the cycle check and the write as **one
 * transaction** (brief 68).
 *
 * The check used to be a separate await before the write. Two opposite moves (A
 * under B from one device, B under A from another) both passed the ancestry
 * walk and both wrote, leaving a two-folder cycle: detached from the root, so
 * both folders, everything under them and every note filed there vanished from
 * the Notes screen with no way back. In a transaction the second move's walk
 * runs after the first move's write, sees it, and is refused as `CYCLE`. The
 * pool has one connection (D47), so transactions are serialised outright.
 *
 * A rename in the same PATCH joins the transaction, so a refused move renames
 * nothing either, as before. Every statement inside uses `trx`: a query on the
 * global `knex` here would wait for the one connection this transaction holds,
 * until the 120 s acquire timeout.
 */
export async function updateNoteFolder(
  profileId: string,
  id: string,
  fields: { name?: string; parentId?: string | null },
): Promise<UpdateNoteFolderResult> {
  return knex.transaction(async (trx): Promise<UpdateNoteFolderResult> => {
    if (!(await folderOn(trx, profileId, id))) return { ok: false, reason: "NOT_FOUND" };

    const { name, parentId } = fields;
    if (parentId !== undefined && parentId !== null) {
      if (!(await folderOn(trx, profileId, parentId))) return { ok: false, reason: "NOT_FOUND" };
      if (await wouldCycle(trx, profileId, id, parentId)) return { ok: false, reason: "CYCLE" };
    }

    const changes: Partial<Pick<NoteFolderRow, "name" | "parent_id">> = {};
    if (name !== undefined) changes.name = name;
    if (parentId !== undefined) changes.parent_id = parentId;
    if (Object.keys(changes).length > 0) {
      await trx("note_folders").where({ id, profile_id: profileId }).update(changes);
    }
    return { ok: true, folder: (await folderOn(trx, profileId, id))! };
  });
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
