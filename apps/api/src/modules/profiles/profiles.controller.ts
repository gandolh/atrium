import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createProfileSchema,
  preferencesSchema,
  profileListSchema,
  profileSchema,
  updateProfileSchema,
} from "@ebook-reader/shared";
import { toProfile } from "./profiles.mapper.js";
import { getProfile, type ProfileRow } from "./profiles.model.js";
import {
  activateProfile,
  createAccountProfile,
  deleteAccountProfile,
  listAccountProfiles,
  readPreferences,
  renameAccountProfile,
  writePreferences,
} from "./profiles.service.js";

/**
 * HTTP for profiles (brief 35 step 4, D35). Validation in, status codes out;
 * every rule about what a profile *is* lives in `profiles.service.ts`.
 *
 * Every route here takes a client-supplied profile id, which makes account
 * ownership the one thing that must never be skipped: an unchecked id is a
 * cross-account read. `ownedProfile` is the single gate — every handler goes
 * through it — and it answers a foreign id with **404, not 403**, because a 403
 * confirms the id exists on somebody else's account.
 */
export function registerProfileRoutes(app: FastifyInstance): void {
  // The app-wide guard (auth.guard.ts) attaches both, or 401s, so these are safe.
  const accountId = (request: FastifyRequest): string => request.authUser!.id;

  /**
   * Resolve `:id` to a profile **on the caller's own account**, or answer 404
   * and return null. The 404-not-403 is the security rule of this file; the
   * ownership comparison is the only thing standing between a guessed id and
   * another household's reading life.
   */
  async function ownedProfile(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ProfileRow | null> {
    const { id } = request.params as { id?: string };
    const row = id ? await getProfile(id) : undefined;
    if (!row || row.user_id !== accountId(request)) {
      void reply.status(404).send({ error: "NOT_FOUND" });
      return null;
    }
    return row;
  }

  app.get("/profiles", async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = await listAccountProfiles(accountId(request));
    return reply.send(profileListSchema.parse(rows.map(toProfile)));
  });

  app.post("/profiles", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    const result = await createAccountProfile(accountId(request), parsed.data);
    if (!result.ok) {
      if (result.reason === "LIMIT") {
        return reply.status(400).send({ error: "PROFILE_LIMIT", limit: result.limit });
      }
      return reply.status(409).send({ error: "NAME_TAKEN" });
    }
    return reply.status(201).send(profileSchema.parse(toProfile(result.profile)));
  });

  app.patch("/profiles/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = await ownedProfile(request, reply);
    if (!profile) return reply;
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    const result = await renameAccountProfile(profile, parsed.data);
    if (!result.ok) return reply.status(409).send({ error: "NAME_TAKEN" });
    return reply.send(profileSchema.parse(toProfile(result.profile)));
  });

  app.delete("/profiles/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = await ownedProfile(request, reply);
    if (!profile) return reply;

    const query = request.query as { reassign?: unknown } | undefined;
    const result = await deleteAccountProfile(profile, {
      userId: accountId(request),
      reassign: query?.reassign === "1" || query?.reassign === "true",
      sessionToken: request.authToken,
      isActiveProfile: request.authProfile?.id === profile.id,
      log: request.log,
    });

    if (!result.ok) {
      if (result.reason === "HAS_NOTES") {
        return reply
          .status(409)
          .send({ error: "PROFILE_HAS_NOTES", noteCount: result.noteCount });
      }
      return reply.status(400).send({ error: result.reason });
    }
    return reply.status(204).send();
  });

  app.post("/profiles/:id/activate", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = await ownedProfile(request, reply);
    if (!profile) return reply;
    // The guard sets authToken on every non-allowlisted request, and this route
    // is not allowlisted.
    await activateProfile(request.authToken!, profile);
    return reply.send(profileSchema.parse(toProfile(profile)));
  });

  /**
   * Read a profile's preferences. It earns its place because `profileSchema`
   * deliberately carries no `preferences` field, so neither the login response
   * nor the activate response includes the blob — this is the only way to fetch
   * it. `{}` for a profile that has never written any.
   */
  app.get("/profiles/:id/preferences", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = await ownedProfile(request, reply);
    if (!profile) return reply;
    return reply.send(preferencesSchema.parse(readPreferences(profile)));
  });

  app.patch("/profiles/:id/preferences", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = await ownedProfile(request, reply);
    if (!profile) return reply;
    const parsed = preferencesSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });

    const merged = await writePreferences(profile, parsed.data);
    return reply.send(preferencesSchema.parse(merged));
  });
}
