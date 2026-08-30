import { randomUUID } from "node:crypto";
import type { CompileStatus } from "@ebook-reader/shared";
import { knex } from "../../database/knex.js";

/**
 * Data access for `latex_projects` and `document_versions` (brief 38) — the
 * **draft** and the **published document**, which are different things in
 * different places and are severable in both directions (decision 11).
 *
 * Like the notes model, every project query is keyed on `profile_id` as well as
 * `id`, and that is the authorisation rather than an optimisation. Versions are
 * keyed on `book_id` instead: a published document belongs to the library,
 * which is shared, so a version is reachable by anyone who can reach its book.
 */

/**
 * A **LaTeX project** — the *draft* half of brief 38 (decisions 1, 2, 8, 11).
 *
 * A draft lives only in `/latex` and is NEVER a `books` row, so it never
 * reaches the media gallery, search, chips or counts — those are all derived
 * client-side from `GET /library`, which reads `books` and nothing else.
 * Publishing is what produces a library entry, and it produces exactly ONE no
 * matter how many times it is pressed: `published_book_id` is set on the first
 * publish and every later publish appends a `document_versions` row to that
 * same book.
 *
 * The project's *files* are not here: multi-file including binaries, so they
 * live on disk with a row pointing at them — the same split D25 chose for the
 * library. Where they live is derived from `id`, never stored (D39).
 */
export interface LatexProjectRow {
  id: string;
  /**
   * The owning profile. `ON DELETE CASCADE`, like `reading_progress` and unlike
   * `notes`: a draft's *published* work survives its author (see
   * `published_book_id`), so deleting a profile does not destroy authored
   * output the way it would for a notebook, and there is nothing to reassign.
   */
  profile_id: string;
  title: string;
  /** Project-relative path compiled as the document root; defaults to `main.tex`. */
  entrypoint: string;
  /**
   * Where this project sits in the compile machine (`COMPILE_STATUSES`).
   * Mirrors `convert_status` deliberately — the compile job IS brief 34's job
   * runner with a much shorter ceiling, so it has the same outcomes.
   */
  compile_status: CompileStatus;
  /**
   * The ONE library entry this project publishes into, or null until its first
   * publish. `REFERENCES books(id) ON DELETE SET NULL` — decision 11: deleting
   * the library entry leaves the draft editable and ready to publish afresh,
   * and deleting the draft does nothing at all to the `books` row.
   */
  published_book_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One published **version** of a document (brief 38 decisions 8 and 11).
 *
 * Pressing publish ten times gives ten of these rows on ONE `books` card, never
 * ten cards. `version_no` is 1-based and dense per book (`appendDocumentVersion`
 * allocates it), and `(book_id, version_no)` is unique so two concurrent
 * publishes cannot both claim v4.
 *
 * NO PATH COLUMNS, deliberately (D39): the version's PDF and its project zip
 * are derived from `id` by `paths.ts`, exactly as a book's file is derived from
 * its own id. Brief 41 dropped `books.file_path` / `books.cover_path` for being
 * a stale cache of a pure function; storing them here would reintroduce that on
 * its first day.
 */
export interface DocumentVersionRow {
  id: string;
  book_id: string;
  /** 1-based, dense per book, allocated by `appendDocumentVersion`. */
  version_no: number;
  published_at: string;
}

// --- Projects ----------------------------------------------------------------

export async function listLatexProjects(profileId: string): Promise<LatexProjectRow[]> {
  return (await knex("latex_projects")
    .where({ profile_id: profileId })
    .orderBy("updated_at", "desc")) as LatexProjectRow[];
}

export async function getLatexProject(
  profileId: string,
  id: string,
): Promise<LatexProjectRow | undefined> {
  return (await knex("latex_projects").where({ id, profile_id: profileId }).first()) as
    | LatexProjectRow
    | undefined;
}

export async function insertLatexProject(row: LatexProjectRow): Promise<void> {
  await knex("latex_projects").insert(row);
}

/** COALESCE lets a title-only or entrypoint-only PATCH leave the other intact. */
export async function updateLatexProject(
  profileId: string,
  id: string,
  fields: { title?: string; entrypoint?: string },
  now: string,
): Promise<boolean> {
  const changed = await knex("latex_projects")
    .where({ id, profile_id: profileId })
    .update({
      title: knex.raw("COALESCE(?, title)", [fields.title ?? null]),
      entrypoint: knex.raw("COALESCE(?, entrypoint)", [fields.entrypoint ?? null]),
      updated_at: now,
    });
  return changed > 0;
}

/**
 * Bump `updated_at` without touching anything else — what a file write does, so
 * the project list re-sorts to put what you just edited first.
 *
 * Not keyed on the profile, unlike its neighbours: the caller has already read
 * the project through `getLatexProject` (which is keyed) to know it exists.
 */
export async function touchLatexProject(id: string, now: string): Promise<void> {
  await knex("latex_projects").where({ id }).update({ updated_at: now });
}

export async function setLatexCompileStatus(
  id: string,
  status: CompileStatus,
): Promise<boolean> {
  const changed = await knex("latex_projects")
    .where({ id })
    .update({ compile_status: status });
  return changed > 0;
}

/**
 * Point a project at the library entry it publishes into, or clear it.
 *
 * The guard clause is a compare-and-set: the write lands only when the project
 * has no published book yet, or already names this one, or the caller is
 * clearing the link (`bookId` null). A project that has already published into
 * a *different* book is left alone — that is the invariant "one draft publishes
 * into exactly one library entry", enforced here rather than assumed, so a
 * racing second publish cannot silently re-point the draft and strand the first
 * book's versions.
 */
export async function setLatexPublishedBook(
  id: string,
  bookId: string | null,
): Promise<boolean> {
  const changed = await knex("latex_projects")
    .where({ id })
    .andWhere((builder) => {
      builder.whereNull("published_book_id");
      if (bookId !== null) builder.orWhere({ published_book_id: bookId });
      else builder.orWhereRaw("1 = 1");
    })
    .update({ published_book_id: bookId });
  return changed > 0;
}

export async function deleteLatexProject(profileId: string, id: string): Promise<boolean> {
  const changed = await knex("latex_projects").where({ id, profile_id: profileId }).delete();
  return changed > 0;
}

/**
 * The compile currently in flight on this **account**, or undefined. The
 * durable half of the single-flight guard (brief 38 step 3, mirroring D34
 * decision 6): one compile at a time, a refusal rather than a queue.
 *
 * Joined through `profiles` because the slot is per account, not per profile —
 * a household sharing one machine shares the CPU the engine runs on. Oldest
 * first so a refusal names the compile that has been running longest.
 */
export async function getRunningLatexCompile(
  userId: string,
): Promise<LatexProjectRow | undefined> {
  return (await knex({ lp: "latex_projects" })
    .join({ p: "profiles" }, "p.id", "lp.profile_id")
    .select("lp.*")
    .where("p.user_id", userId)
    .andWhere("lp.compile_status", "running")
    .orderBy("lp.updated_at", "asc")
    .first()) as LatexProjectRow | undefined;
}

// --- Published versions ------------------------------------------------------

export async function listDocumentVersions(bookId: string): Promise<DocumentVersionRow[]> {
  return (await knex("document_versions")
    .where({ book_id: bookId })
    .orderBy("version_no", "desc")) as DocumentVersionRow[];
}

export async function getDocumentVersion(id: string): Promise<DocumentVersionRow | undefined> {
  return (await knex("document_versions").where({ id }).first()) as
    | DocumentVersionRow
    | undefined;
}

export async function getLatestDocumentVersion(
  bookId: string,
): Promise<DocumentVersionRow | undefined> {
  return (await knex("document_versions")
    .where({ book_id: bookId })
    .orderBy("version_no", "desc")
    .first()) as DocumentVersionRow | undefined;
}

export async function countDocumentVersions(bookId: string): Promise<number> {
  const [row] = await knex("document_versions").where({ book_id: bookId }).count({ n: "*" });
  return Number(row?.n ?? 0);
}

/**
 * Append the next version of `bookId` and return the stored row.
 *
 * The number is allocated by `MAX(version_no) + 1` **inside the INSERT**, not
 * read out and written back, so two publishes racing for v4 resolve in SQLite
 * rather than in this process: the loser violates `document_versions_book_no`
 * and throws instead of quietly overwriting the winner.
 */
export async function appendDocumentVersion(
  bookId: string,
  now: string,
): Promise<DocumentVersionRow> {
  const id = randomUUID();
  await knex.raw(
    `INSERT INTO document_versions (id, book_id, version_no, published_at)
     SELECT ?, ?, COALESCE(MAX(version_no), 0) + 1, ?
       FROM document_versions WHERE book_id = ?`,
    [id, bookId, now, bookId],
  );
  return (await getDocumentVersion(id)) as DocumentVersionRow;
}

export async function deleteDocumentVersion(id: string): Promise<boolean> {
  const changed = await knex("document_versions").where({ id }).delete();
  return changed > 0;
}
