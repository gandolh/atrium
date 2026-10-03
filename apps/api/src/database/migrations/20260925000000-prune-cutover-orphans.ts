import type { Knex } from "knex";

/**
 * Carry out the prune the Ward cutover decided on and did not perform (brief 60).
 *
 * D53 chose a **full prune**: the cutover's profiles go, and everything under
 * them with them. `20260906000000-ward-cutover` dropped and rebuilt `profiles`
 * with foreign keys OFF, and with them off SQLite's `DROP TABLE` fires no
 * `ON DELETE` action at all. `notes` and `note_folders` are `RESTRICT` besides,
 * so even with them on the drop would have been refused, not cascaded. Every
 * pre-cutover row in the four profile-scoped tables was therefore kept,
 * pointing at a profile id that exists nowhere. That is data D53 decided to
 * destroy, kept and unreachable, and a live integrity violation that would make
 * the next migration asserting `PRAGMA foreign_key_check` throw and stop the
 * API from booting.
 *
 * This deletes exactly those rows: a profile-scoped row whose `profile_id` is
 * not in `profiles`. On a database with no orphans (any database created after
 * the cutover) every delete matches nothing, so it is an ordinary forward
 * migration that needs no knowledge of its own history.
 *
 * **What it does not delete:**
 * - `latex/<id>/` directories. Migrations own SQL only (api-layering.md), so the
 *   orphaned project ids are logged for the operator to remove by hand.
 * - Published books. D37 keeps a published document independent of its draft
 *   (`latex_projects.published_book_id … ON DELETE SET NULL` points from the
 *   draft to the book, not the other way), so the books and their versions
 *   stay in the library.
 *
 * **Take a database copy before this runs on a database that went through the
 * cutover.** The orphans are the only remaining copy of the pre-cutover notes
 * and drafts, and this is irreversible. That is D53 as written.
 */

/** The profile-scoped tables, children before parents. */
const SCOPED = ["reading_progress", "notes", "note_folders", "latex_projects"] as const;

const ORPHAN = "profile_id NOT IN (SELECT id FROM profiles)";

export async function up(knex: Knex): Promise<void> {
  // Off OUTSIDE the transaction, as the baseline does: SQLite ignores the
  // pragma inside one. With it off, the folder rows can be deleted in one
  // statement regardless of their `parent_id` chain; the check at the end is
  // what proves the result is clean.
  await knex.raw("PRAGMA foreign_keys = OFF");
  try {
    await knex.transaction(async (trx) => {
      const counts: Record<string, number> = {};
      for (const table of SCOPED) {
        const [{ n }] = (await trx.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE ${ORPHAN}`)) as { n: number }[];
        counts[table] = Number(n);
      }

      const projects = (await trx.raw(`SELECT id FROM latex_projects WHERE ${ORPHAN}`)) as { id: string }[];
      if (projects.length > 0) {
        console.warn(
          `[migration prune-cutover-orphans] ${projects.length} orphaned LaTeX project(s) pruned; ` +
            `their latex/<id>/ directories are not removed by a migration. Remove by hand: ` +
            projects.map((p) => p.id).join(", "),
        );
      }

      // A surviving note filed in a pruned folder falls back to the root, which
      // is what its `ON DELETE SET NULL` would have done with the keys on.
      await trx.raw(
        `UPDATE notes SET folder_id = NULL
           WHERE folder_id IN (SELECT id FROM note_folders WHERE ${ORPHAN})
             AND profile_id IN (SELECT id FROM profiles)`,
      );
      for (const table of SCOPED) {
        await trx.raw(`DELETE FROM ${table} WHERE ${ORPHAN}`);
      }

      if (Object.values(counts).some((n) => n > 0)) {
        console.warn(`[migration prune-cutover-orphans] pruned orphaned rows: ${JSON.stringify(counts)}`);
      }

      const violations = (await trx.raw("PRAGMA foreign_key_check")) as unknown[];
      if (Array.isArray(violations) && violations.length > 0) {
        throw new Error(
          `Cutover-orphan prune left ${violations.length} foreign-key violation(s); rolled back: ` +
            JSON.stringify(violations),
        );
      }
    });
  } finally {
    await knex.raw("PRAGMA foreign_keys = ON");
  }
}

/** Nothing to restore: the rows were unreachable, and the copy taken before `up` is the only way back. */
export async function down(): Promise<void> {}
