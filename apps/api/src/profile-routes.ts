import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MAX_PROFILES_PER_ACCOUNT,
  createProfileSchema,
  preferencesSchema,
  profileListSchema,
  profileSchema,
  updateProfileSchema,
  type Preferences,
  type Profile,
} from "@ebook-reader/shared";
import {
  countProfiles,
  createProfile,
  deleteProfile,
  getDefaultProfile,
  getProfile,
  listLatexProjects,
  listNotes,
  listProfiles,
  reassignNotes,
  setProfilePreferences,
  setSessionActiveProfile,
  updateProfile,
  type ProfileRow,
} from "./db.js";
import { cancelAndSettleLatexCompile } from "./latex-compile.js";
import { removeProjectTree } from "./latex-routes.js";
import { projectDirFor } from "./paths.js";

/**
 * Profile CRUD + the switch (brief 35 step 4, D35). A **profile** is a person
 * in the household; the **account** is the household and the security boundary.
 *
 * Every route here takes a client-supplied profile id, which makes account
 * ownership the one thing that must never be skipped: an unchecked id is a
 * cross-account read. `ownedProfile` is the single gate — every handler goes
 * through it — and it answers a foreign id with **404, not 403**, because a 403
 * confirms the id exists on somebody else's account.
 *
 * Switching is deliberately free (no password, no PIN — decision 5): a profile
 * is an identity boundary, never a permission. Anyone holding a live session on
 * the account can already become any profile on it, by design.
 */

/**
 * Row → wire. Exported because `auth.ts` builds the login response's `profile`
 * and `profiles` from the same rows.
 */
export function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    // SQLite stores the flag as 1/0; the contract is a boolean.
    isDefault: row.is_default === 1,
  };
}

/**
 * True for better-sqlite3's unique-index violation. Matched on `code`, never on
 * the message text, which is not a stable interface.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * True for the `notes.profile_id` ON DELETE RESTRICT violation (decision 3).
 *
 * Matches BOTH constraint codes on purpose. SQLite implements RESTRICT with an
 * implicit trigger, so a RESTRICT violation surfaces as
 * `SQLITE_CONSTRAINT_TRIGGER` — verified against the bundled SQLite 3.53.2 —
 * while a plain immediate foreign-key failure gives
 * `SQLITE_CONSTRAINT_FOREIGNKEY`. Checking only the latter left this classifier
 * never matching, which turned the 409 below into an unhandled 500. Both are
 * listed rather than one, so changing the FK action later can't silently
 * re-break it.
 */
function isForeignKeyViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof err === "object" &&
    err !== null &&
    (code === "SQLITE_CONSTRAINT_TRIGGER" || code === "SQLITE_CONSTRAINT_FOREIGNKEY")
  );
}

/**
 * Decode a stored preferences blob, dropping anything the contract rejects.
 *
 * Falling back to `{}` rather than throwing is deliberate: a blob corrupted
 * outside the app would otherwise make every future PATCH a permanent 500 with
 * no way to write over it. Unknown *keys* are not corruption — `preferencesSchema`
 * is `.passthrough()`, so they survive this and the merge below (brief step 8).
 */
function storedPreferences(raw: string | null): Preferences {
  if (!raw) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  const parsed = preferencesSchema.safeParse(decoded);
  return parsed.success ? parsed.data : {};
}

export function registerProfileRoutes(app: FastifyInstance): void {
  // The app-wide guard (auth.ts) attaches both, or 401s, so these are safe.
  const accountId = (request: FastifyRequest): string => request.authUser!.id;

  /**
   * Resolve `:id` to a profile **on the caller's own account**, or answer 404
   * and return null. The 404-not-403 is the security rule of this file; the
   * ownership comparison is the only thing standing between a guessed id and
   * another household's reading life.
   */
  function ownedProfile(request: FastifyRequest, reply: FastifyReply): ProfileRow | null {
    const { id } = request.params as { id?: string };
    const row = id ? getProfile(id) : undefined;
    if (!row || row.user_id !== accountId(request)) {
      void reply.status(404).send({ error: "NOT_FOUND" });
      return null;
    }
    return row;
  }

  app.get("/profiles", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(profileListSchema.parse(listProfiles(accountId(request)).map(toProfile)));
  });

  app.post("/profiles", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    const userId = accountId(request);
    if (countProfiles(userId) >= MAX_PROFILES_PER_ACCOUNT) {
      return reply
        .status(400)
        .send({ error: "PROFILE_LIMIT", limit: MAX_PROFILES_PER_ACCOUNT });
    }

    const row: ProfileRow = {
      id: randomUUID(),
      user_id: userId,
      name: parsed.data.name,
      color: parsed.data.color,
      // Never client-supplied: the default is the account's fallback and is
      // fixed at creation/migration time.
      is_default: 0,
      preferences: null,
      created_at: new Date().toISOString(),
    };
    try {
      createProfile(row);
    } catch (err) {
      // Answered from the constraint rather than a SELECT-then-INSERT, which
      // would be a race: two tabs adding "Ana" would both pass the check.
      if (isUniqueViolation(err)) return reply.status(409).send({ error: "NAME_TAKEN" });
      throw err;
    }
    return reply.status(201).send(profileSchema.parse(toProfile(row)));
  });

  app.patch("/profiles/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = ownedProfile(request, reply);
    if (!profile) return reply;
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    try {
      updateProfile(profile.id, { name: parsed.data.name, color: parsed.data.color });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.status(409).send({ error: "NAME_TAKEN" });
      throw err;
    }
    return reply.send(
      profileSchema.parse(
        toProfile({
          ...profile,
          name: parsed.data.name ?? profile.name,
          color: parsed.data.color ?? profile.color,
        }),
      ),
    );
  });

  /**
   * Delete a profile. Three refusals, all of them protecting something that
   * cannot be recreated by reading on:
   *
   *  - the account's **last** profile (every account must keep one — the
   *    guard's fallback and the login response both assume it);
   *  - the account's **default** profile, because it is the reassign target and
   *    the fallback, and nothing here can promote a replacement (`db.ts` has no
   *    statement to move the flag). Rename it instead;
   *  - a profile that still owns **notes**, unless `?reassign=1` says to move
   *    them to the default first (decision 3 — notes are *authored*).
   *
   * Reading progress is not protected: `reading_progress` cascades, and losing
   * a position is a re-read, not lost work.
   *
   * Past the refusals, the delete owns two things the cascade cannot do for it,
   * both of them about the profile's LaTeX projects: **cancelling any compile
   * running on them** (the cascade would otherwise drop the row while the job
   * still held the account's slot) and **removing their working trees** (SQLite
   * deletes rows, never files). See the long note at each, below.
   *
   * One consequence worth naming: the notes race in the `catch` can still turn
   * this into a 409 *after* the compiles were cancelled. That is the right way
   * round — a cancelled compile is a recompile, an unprotected note is lost
   * authored work — and it is the only path here that cancels without deleting.
   */
  app.delete("/profiles/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = ownedProfile(request, reply);
    if (!profile) return reply;
    const userId = accountId(request);

    if (countProfiles(userId) <= 1) {
      return reply.status(400).send({ error: "LAST_PROFILE" });
    }
    if (profile.is_default === 1) {
      return reply.status(400).send({ error: "DEFAULT_PROFILE" });
    }

    const query = request.query as { reassign?: unknown } | undefined;
    const reassign = query?.reassign === "1" || query?.reassign === "true";
    const notes = listNotes(profile.id);
    if (notes.length > 0 && !reassign) {
      // The count is in the body so the manage screen can say exactly what is
      // at risk instead of a generic "this profile has notes".
      return reply.status(409).send({ error: "PROFILE_HAS_NOTES", noteCount: notes.length });
    }

    // Guaranteed by the is_default refusal above (the deleted profile is never
    // the default, and every account has one).
    const fallback = getDefaultProfile(userId)!;
    if (notes.length > 0) reassignNotes(profile.id, fallback.id);

    /*
     * ## Cancel the compiles this delete is about to orphan — BEFORE the cascade
     *
     * `latex_projects.profile_id` is ON DELETE CASCADE (`db.ts`), so the instant
     * the profile row goes so do the rows naming its projects — while the jobs
     * carry on holding the engine. The single-flight slot is per ACCOUNT (D35),
     * not per profile, so one person tidying up their own profile wedges
     * compilation for the whole household until the job ends by itself, bounded
     * only by `LATEX_TIMEOUT_MS`. Nothing can rescue it afterwards either: every
     * route that could cancel resolves the project from its row first, and the
     * row is exactly what the cascade removed. Brief 44 fixed the *reporting* of
     * that state; this is the state itself.
     *
     * Hence the ordering: read the list and settle the jobs here, before
     * `deleteProfile`. Reading it afterwards returns nothing at all — there
     * would be no id left to cancel and no id left to derive a path from.
     *
     * `cancelAndSettleLatexCompile`, not `cancelLatexCompile`, for the reason
     * `DELETE /latex/:id` gives: a cancelled job does not stop dead, it unwinds
     * through `persistOutcome`, which **recreates** `latex/<id>/.atrium-build/`
     * with a log and diagnostics in it. Awaiting the job is what makes the `rm`
     * below the last writer; without the wait the tree is removed, the job then
     * resumes and writes the directory back, and those bytes are orphaned for
     * the life of the installation with no row left pointing at them.
     *
     * Keyed by project id, so a compile running on a **sibling** profile of the
     * same account is not in this list and is left strictly alone. And it is a
     * no-op when nothing is running, so a profile with no compiles — the
     * ordinary case — is unchanged apart from losing its project trees.
     */
    const projects = listLatexProjects(profile.id);
    for (const project of projects) {
      await cancelAndSettleLatexCompile(project.id);
    }

    try {
      deleteProfile(profile.id);
    } catch (err) {
      // ON DELETE RESTRICT firing here means a note was written between the
      // count and the delete. Surface it rather than working around the
      // constraint — it is the last thing standing between a race and
      // destroyed authored work.
      if (isForeignKeyViolation(err)) {
        return reply
          .status(409)
          .send({ error: "PROFILE_HAS_NOTES", noteCount: listNotes(profile.id).length });
      }
      throw err;
    }

    // The FK is ON DELETE SET NULL, so the caller stays logged in either way and
    // the guard would fall back to the default on the next request. Re-pointing
    // the session here anyway keeps the row naming a profile that exists, so
    // "which profile am I?" has one answer and not two. Other devices on other
    // sessions were SET NULL and take the guard's fallback.
    if (request.authToken && request.authProfile?.id === profile.id) {
      setSessionActiveProfile(request.authToken, fallback.id);
    }

    // The trees go after the rows — the same ordering, and the same shared
    // helper, as `DELETE /latex/:id`. The row is what makes a project
    // reachable, so removing it first means no request can arrive for a
    // half-deleted project; a failed `rm` leaves orphaned bytes, which is
    // logged and recoverable, where the opposite ordering leaves projects that
    // 500 on every read. `projectDirFor` asserts the id's shape, and these ids
    // came from rows, so they are server-minted UUIDs and cannot be pointed
    // anywhere else.
    for (const project of projects) {
      await removeProjectTree(projectDirFor(project.id), request);
    }
    return reply.status(204).send();
  });

  /**
   * The switch. Free by design (D35, decision 5) — no password, no PIN — and
   * the whole of it server-side is one column: no new token, so other tabs on
   * the same session follow rather than being logged out.
   */
  app.post("/profiles/:id/activate", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = ownedProfile(request, reply);
    if (!profile) return reply;
    // The guard sets authToken on every non-allowlisted request, and this route
    // is not allowlisted.
    setSessionActiveProfile(request.authToken!, profile.id);
    return reply.send(profileSchema.parse(toProfile(profile)));
  });

  /**
   * Read a profile's preferences. It earns its place because `profileSchema`
   * deliberately carries no `preferences` field, so neither the login response
   * nor the activate response includes the blob — this is the only way to fetch
   * it. `{}` for a profile that has never written any.
   */
  app.get("/profiles/:id/preferences", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = ownedProfile(request, reply);
    if (!profile) return reply;
    return reply.send(preferencesSchema.parse(storedPreferences(profile.preferences)));
  });

  /**
   * Write preferences. The incoming object is **merged over** the stored one,
   * not swapped for it: PATCHing `{theme}` from the reader must not wipe the
   * font settings written by the "Aa" panel. The merge is one level deep — a
   * PATCH that names `fontSettings` replaces that whole object, so a client
   * changing the size sends the settings whole.
   */
  app.patch("/profiles/:id/preferences", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = ownedProfile(request, reply);
    if (!profile) return reply;
    const parsed = preferencesSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    // Spread, not replace, so a key this server has never heard of — written by
    // a newer client on another device — survives the round trip (brief step 8).
    const merged: Preferences = { ...storedPreferences(profile.preferences), ...parsed.data };
    setProfilePreferences(profile.id, JSON.stringify(merged));
    return reply.send(preferencesSchema.parse(merged));
  });
}
