import type { ProfileColor } from "@ebook-reader/shared";
import { knex } from "../../database/knex.js";

/**
 * Data access for `profiles` and `reading_progress` — the person half of
 * identity (brief 35, D35) and everything keyed on it.
 *
 * The two tables live in one model because reading progress has no meaning
 * apart from the profile it belongs to: it is created, listed and destroyed
 * with one, and `deleteProfile` below is the only place either is removed.
 */

/**
 * One profile on an account (brief 35, D35) — a person in the household. Owns
 * reading progress, notes and preferences; the library stays shared, across
 * profiles as it is across accounts. Cascades away with its user.
 *
 * A profile is an identity boundary, never a security one: switching is free,
 * so anything keyed here is readable by anyone holding a live session on the
 * account. The *account* remains the security boundary (D30).
 */
export interface ProfileRow {
  id: string;
  /** The owning account. */
  user_id: string;
  /** 1–24 chars; unique per account via the `profiles_user_name` index. */
  name: string;
  /** A Reading Room kind-tint token name (`PROFILE_COLORS`), never a hex. */
  color: ProfileColor;
  /** SQLite has no boolean: 1 for the account's fallback profile, else 0. */
  is_default: number;
  /**
   * The preferences JSON blob (theme / font settings / page mode / TOC sidebar
   * — brief 35 step 8), or null until the profile first writes one. Stored and
   * returned verbatim so an unknown key from a newer client can't be stripped
   * in transit; only the client parses it.
   */
  preferences: string | null;
  created_at: string;
}

/**
 * One profile's reading state for one book. Progress + resume position are
 * per-profile since brief 35 (D35, revising D31's per-user scope): the library
 * is shared, the place you're at is not.
 */
export interface ProfileProgressRow {
  book_id: string;
  /** 0..1, drives the cover progress bar. */
  progress: number;
  /** Opaque resume position: PDF page number (string) or EPUB CFI; null if unset. */
  locator: string | null;
  /**
   * ISO timestamp of the last write to this row (brief 34 step 7): what "which
   * of a linked pair did this reader use last" compares. Every stored row has
   * one (`NOT NULL`); a book this profile has never opened simply has no row at
   * all, which callers represent as `null` rather than by faking a value here.
   */
  updated_at: string;
  /**
   * Which published **version** `locator` belongs to (brief 38 decision 10), or
   * null for an ordinary book — one that was uploaded or imported rather than
   * published from a LaTeX project.
   *
   * Nullable and NOT part of the primary key, on purpose. The key stays
   * `(profile_id, book_id)`, so a reader has exactly ONE saved position per
   * book, and this column says which version that position was taken in.
   * Opening a version whose id differs starts at page 0 — decision 10, the
   * owner's rule: *"when you are on page 40 on v3 and publish v4, you will
   * resume from page 0 of v4."* An older version therefore does NOT keep its own
   * position; making it part of the key is exactly the third progress mechanism
   * that simplification exists to avoid.
   */
  version_id: string | null;
}

/** The columns a progress read projects — the row shape, minus `profile_id`. */
const PROGRESS_COLUMNS = ["book_id", "progress", "locator", "updated_at", "version_id"] as const;

// --- Profiles ----------------------------------------------------------------

/**
 * An account's profiles, default first then oldest first, so the picker's order
 * is stable across renames and the account's default always leads.
 */
export async function listProfiles(userId: string): Promise<ProfileRow[]> {
  return (await knex("profiles")
    .where({ user_id: userId })
    .orderBy([
      { column: "is_default", order: "desc" },
      { column: "created_at", order: "asc" },
    ])) as ProfileRow[];
}

/**
 * One profile by id, or undefined. The id is client-supplied at every route
 * that takes one, so callers MUST compare `row.user_id` against the caller's
 * account before acting on it — profiles are not a security boundary, but
 * accounts are.
 */
export async function getProfile(id: string): Promise<ProfileRow | undefined> {
  return (await knex("profiles").where({ id }).first()) as ProfileRow | undefined;
}

export async function getDefaultProfile(userId: string): Promise<ProfileRow | undefined> {
  return (await knex("profiles").where({ user_id: userId, is_default: 1 }).first()) as
    | ProfileRow
    | undefined;
}

export async function countProfiles(userId: string): Promise<number> {
  const [row] = await knex("profiles").where({ user_id: userId }).count({ n: "*" });
  return Number(row?.n ?? 0);
}

export async function createProfile(row: ProfileRow): Promise<void> {
  await knex("profiles").insert(row);
}

/** COALESCE lets a name-only or colour-only PATCH leave the other intact. */
export async function updateProfile(
  id: string,
  fields: { name?: string; color?: ProfileColor },
): Promise<boolean> {
  const changed = await knex("profiles")
    .where({ id })
    .update({
      name: knex.raw("COALESCE(?, name)", [fields.name ?? null]),
      color: knex.raw("COALESCE(?, color)", [fields.color ?? null]),
    });
  return changed > 0;
}

/**
 * Delete a profile, taking its note folders with it first.
 *
 * The explicit folder delete is not tidiness — it is what makes the delete
 * possible at all. `note_folders.profile_id` is `ON DELETE RESTRICT` (the same
 * clause `notes` carries, and for the same reason: authored work must be moved,
 * never cascaded away), so SQLite refuses to remove a profile that still owns
 * folders. The caller is required to have run `reassignNotes` first, which
 * moves the notes AND the folders they are filed in to the account's default
 * profile; anything left here is therefore an empty folder belonging to a
 * profile with no notes.
 *
 * One transaction so a failure between the two statements cannot leave folders
 * orphaned from the profile that is about to go.
 */
export async function deleteProfile(id: string): Promise<boolean> {
  return knex.transaction(async (trx) => {
    await trx("note_folders").where({ profile_id: id }).delete();
    const changed = await trx("profiles").where({ id }).delete();
    return changed > 0;
  });
}

/**
 * The stored preferences blob: `undefined` when no such profile exists, `null`
 * when the profile exists but has never written one. The caller needs to tell
 * those apart — one is a 404, the other is "use the client defaults".
 */
export async function getProfilePreferences(id: string): Promise<string | null | undefined> {
  const row = (await knex("profiles").select("preferences").where({ id }).first()) as
    | { preferences: string | null }
    | undefined;
  return row === undefined ? undefined : row.preferences;
}

export async function setProfilePreferences(id: string, json: string | null): Promise<boolean> {
  const changed = await knex("profiles").where({ id }).update({ preferences: json });
  return changed > 0;
}

// --- Per-profile reading progress -------------------------------------------

export async function listProfileProgress(profileId: string): Promise<ProfileProgressRow[]> {
  return (await knex("reading_progress")
    .select(...PROGRESS_COLUMNS)
    .where({ profile_id: profileId })) as ProfileProgressRow[];
}

export async function getProfileProgress(
  profileId: string,
  bookId: string,
): Promise<ProfileProgressRow | undefined> {
  return (await knex("reading_progress")
    .select(...PROGRESS_COLUMNS)
    .where({ profile_id: profileId, book_id: bookId })
    .first()) as ProfileProgressRow | undefined;
}

/**
 * Write this profile's position in a book.
 *
 * COALESCE keeps a previously-saved locator when a progress-only update sends
 * null, so a bar refresh can't wipe the resume position.
 *
 * `version_id` is COALESCEd for the same reason and as a matched pair with the
 * locator: the two are one fact — *this position, in this version* — so a
 * progress-only write that carries neither must leave both alone rather than
 * orphan a locator from the version it was taken in. The rule that follows for
 * callers: **a write that supplies a `locator` for a published version MUST
 * supply that version's id alongside it.**
 */
export async function upsertProfileProgress(
  profileId: string,
  bookId: string,
  progress: number,
  locator: string | null,
  now: string,
  versionId: string | null = null,
): Promise<void> {
  await knex("reading_progress")
    .insert({
      profile_id: profileId,
      book_id: bookId,
      progress,
      locator,
      updated_at: now,
      version_id: versionId,
    })
    .onConflict(["profile_id", "book_id"])
    .merge({
      progress: knex.raw("excluded.progress"),
      locator: knex.raw("COALESCE(excluded.locator, reading_progress.locator)"),
      updated_at: knex.raw("excluded.updated_at"),
      version_id: knex.raw("COALESCE(excluded.version_id, reading_progress.version_id)"),
    });
}
