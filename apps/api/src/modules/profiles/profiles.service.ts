import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  MAX_PROFILES_PER_ACCOUNT,
  type Preferences,
  type ProfileColor,
} from "@ebook-reader/shared";
import { projectDirFor } from "../../common/paths.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../database/errors.js";
import { setSessionActiveProfile } from "../auth/auth.model.js";
import { cancelAndSettleLatexCompile } from "../latex/latex-compile.service.js";
import { listLatexProjects } from "../latex/latex.model.js";
import { removeProjectTree } from "../latex/project-tree.service.js";
import { reassignNotes } from "../notes/note-folders.model.js";
import { listNotes } from "../notes/notes.model.js";
import { storedPreferences } from "./profiles.mapper.js";
import {
  countProfiles,
  createProfile,
  deleteProfile,
  getDefaultProfile,
  listProfiles,
  setProfilePreferences,
  updateProfile,
  type ProfileRow,
} from "./profiles.model.js";

/**
 * Profile rules (brief 35, D35). A **profile** is a person in the household;
 * the **account** is the household and the security boundary.
 *
 * The controller owns HTTP — parsing, status codes, the 404-not-403 rule on a
 * foreign id. This owns what is true regardless of transport: the per-account
 * cap, the three delete refusals, what a delete must clean up before the
 * cascade reaches it, and how a preferences PATCH merges.
 *
 * Every outcome that is not "it worked" comes back as a tagged union rather
 * than a thrown error, because each one maps to a *different* status code with
 * a *different* body, and a controller reading `result.reason` cannot forget a
 * case the way a `catch` can.
 */

export type CreateProfileResult =
  | { ok: true; profile: ProfileRow }
  | { ok: false; reason: "LIMIT"; limit: number }
  | { ok: false; reason: "NAME_TAKEN" };

export type UpdateProfileResult =
  | { ok: true; profile: ProfileRow }
  | { ok: false; reason: "NAME_TAKEN" };

export type DeleteProfileResult =
  | { ok: true }
  | { ok: false; reason: "LAST_PROFILE" }
  | { ok: false; reason: "DEFAULT_PROFILE" }
  | { ok: false; reason: "HAS_NOTES"; noteCount: number };

export async function listAccountProfiles(userId: string): Promise<ProfileRow[]> {
  return listProfiles(userId);
}

/**
 * Add a profile to an account, subject to the per-account cap.
 *
 * The name clash is answered from the unique index rather than a
 * SELECT-then-INSERT, which would be a race: two tabs adding "Ana" would both
 * pass the check and one would then 500.
 */
export async function createAccountProfile(
  userId: string,
  fields: { name: string; color: ProfileColor },
): Promise<CreateProfileResult> {
  if ((await countProfiles(userId)) >= MAX_PROFILES_PER_ACCOUNT) {
    return { ok: false, reason: "LIMIT", limit: MAX_PROFILES_PER_ACCOUNT };
  }

  const row: ProfileRow = {
    id: randomUUID(),
    user_id: userId,
    name: fields.name,
    color: fields.color,
    // Never client-supplied: the default is the account's fallback and is fixed
    // at creation/migration time.
    is_default: 0,
    preferences: null,
    created_at: new Date().toISOString(),
  };
  try {
    await createProfile(row);
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "NAME_TAKEN" };
    throw err;
  }
  return { ok: true, profile: row };
}

export async function renameAccountProfile(
  profile: ProfileRow,
  fields: { name?: string; color?: ProfileColor },
): Promise<UpdateProfileResult> {
  try {
    await updateProfile(profile.id, fields);
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "NAME_TAKEN" };
    throw err;
  }
  return {
    ok: true,
    profile: { ...profile, name: fields.name ?? profile.name, color: fields.color ?? profile.color },
  };
}

/**
 * Delete a profile. Three refusals, all of them protecting something that
 * cannot be recreated by reading on:
 *
 *  - the account's **last** profile (every account must keep one — the auth
 *    guard's fallback and the login response both assume it);
 *  - the account's **default** profile, because it is the reassign target and
 *    the fallback, and nothing here can promote a replacement (the model has no
 *    statement to move the flag). Rename it instead;
 *  - a profile that still owns **notes**, unless `reassign` says to move them to
 *    the default first (decision 3 — notes are *authored*).
 *
 * Reading progress is not protected: `reading_progress` cascades, and losing a
 * position is a re-read, not lost work.
 *
 * Past the refusals, the delete owns two things the cascade cannot do for it,
 * both about the profile's LaTeX projects — see the block comments inline.
 *
 * One consequence worth naming: the notes race in the `catch` can still make
 * this a `HAS_NOTES` refusal *after* the compiles were cancelled. That is the
 * right way round — a cancelled compile is a recompile, an unprotected note is
 * lost authored work — and it is the only path here that cancels without
 * deleting.
 */
export async function deleteAccountProfile(
  profile: ProfileRow,
  options: {
    userId: string;
    reassign: boolean;
    /** The caller's own session token, so its active profile can be re-pointed. */
    sessionToken?: string;
    /** True when the caller is currently *acting as* the profile being deleted. */
    isActiveProfile: boolean;
    log: FastifyBaseLogger;
  },
): Promise<DeleteProfileResult> {
  if ((await countProfiles(options.userId)) <= 1) return { ok: false, reason: "LAST_PROFILE" };
  if (profile.is_default === 1) return { ok: false, reason: "DEFAULT_PROFILE" };

  const notes = await listNotes(profile.id);
  if (notes.length > 0 && !options.reassign) {
    // The count travels with the refusal so the manage screen can say exactly
    // what is at risk instead of a generic "this profile has notes".
    return { ok: false, reason: "HAS_NOTES", noteCount: notes.length };
  }

  // Guaranteed by the is_default refusal above (the deleted profile is never
  // the default, and every account has one).
  const fallback = (await getDefaultProfile(options.userId))!;
  if (notes.length > 0) await reassignNotes(profile.id, fallback.id);

  /*
   * ## Cancel the compiles this delete is about to orphan — BEFORE the cascade
   *
   * `latex_projects.profile_id` is ON DELETE CASCADE, so the instant the profile
   * row goes so do the rows naming its projects — while the jobs carry on
   * holding the engine. The single-flight slot is per ACCOUNT (D35), not per
   * profile, so one person tidying up their own profile wedges compilation for
   * the whole household until the job ends by itself, bounded only by
   * `LATEX_TIMEOUT_MS`. Nothing can rescue it afterwards either: every route
   * that could cancel resolves the project from its row first, and the row is
   * exactly what the cascade removed. Brief 44 fixed the *reporting* of that
   * state; this is the state itself.
   *
   * Hence the ordering: read the list and settle the jobs here, before
   * `deleteProfile`. Reading it afterwards returns nothing at all — there would
   * be no id left to cancel and no id left to derive a path from.
   *
   * `cancelAndSettleLatexCompile`, not `cancelLatexCompile`, for the reason
   * `DELETE /latex/:id` gives: a cancelled job does not stop dead, it unwinds
   * through `persistOutcome`, which **recreates** `latex/<id>/.atrium-build/`
   * with a log and diagnostics in it. Awaiting the job is what makes the `rm`
   * below the last writer; without the wait the tree is removed, the job then
   * resumes and writes the directory back, and those bytes are orphaned for the
   * life of the installation with no row left pointing at them.
   *
   * Keyed by project id, so a compile running on a **sibling** profile of the
   * same account is not in this list and is left strictly alone. And it is a
   * no-op when nothing is running, so a profile with no compiles — the ordinary
   * case — is unchanged apart from losing its project trees.
   */
  const projects = await listLatexProjects(profile.id);
  for (const project of projects) {
    await cancelAndSettleLatexCompile(project.id);
  }

  try {
    await deleteProfile(profile.id);
  } catch (err) {
    // ON DELETE RESTRICT firing here means a note was written between the count
    // and the delete. Surface it rather than working around the constraint — it
    // is the last thing standing between a race and destroyed authored work.
    if (isForeignKeyViolation(err)) {
      return { ok: false, reason: "HAS_NOTES", noteCount: (await listNotes(profile.id)).length };
    }
    throw err;
  }

  // The FK is ON DELETE SET NULL, so the caller stays logged in either way and
  // the guard would fall back to the default on the next request. Re-pointing
  // the session here anyway keeps the row naming a profile that exists, so
  // "which profile am I?" has one answer and not two. Other devices on other
  // sessions were SET NULL and take the guard's fallback.
  if (options.sessionToken && options.isActiveProfile) {
    await setSessionActiveProfile(options.sessionToken, fallback.id);
  }

  // The trees go after the rows — the same ordering, and the same shared
  // helper, as `DELETE /latex/:id`. The row is what makes a project reachable,
  // so removing it first means no request can arrive for a half-deleted
  // project; a failed `rm` leaves orphaned bytes, which is logged and
  // recoverable, where the opposite ordering leaves projects that 500 on every
  // read. `projectDirFor` asserts the id's shape, and these ids came from rows,
  // so they are server-minted UUIDs and cannot be pointed anywhere else.
  for (const project of projects) {
    await removeProjectTree(projectDirFor(project.id), options.log);
  }
  return { ok: true };
}

/**
 * The switch. Free by design (D35, decision 5) — no password, no PIN — and the
 * whole of it server-side is one column: no new token, so other tabs on the
 * same session follow rather than being logged out.
 */
export async function activateProfile(token: string, profile: ProfileRow): Promise<void> {
  await setSessionActiveProfile(token, profile.id);
}

export function readPreferences(profile: ProfileRow): Preferences {
  return storedPreferences(profile.preferences);
}

/**
 * Write preferences. The incoming object is **merged over** the stored one, not
 * swapped for it: PATCHing `{theme}` from the reader must not wipe the font
 * settings written by the "Aa" panel. The merge is one level deep — a PATCH
 * that names `fontSettings` replaces that whole object, so a client changing
 * the size sends the settings whole.
 *
 * Spread, not replace, so a key this server has never heard of — written by a
 * newer client on another device — survives the round trip (brief 35 step 8).
 */
export async function writePreferences(
  profile: ProfileRow,
  patch: Preferences,
): Promise<Preferences> {
  const merged: Preferences = { ...storedPreferences(profile.preferences), ...patch };
  await setProfilePreferences(profile.id, JSON.stringify(merged));
  return merged;
}
