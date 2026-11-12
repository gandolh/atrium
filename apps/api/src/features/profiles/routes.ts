import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createProfileSchema,
  preferencesSchema,
  profileListSchema,
  profileSchema,
  updateProfileSchema,
} from "@ebook-reader/shared";
import { toProfile } from "./mapper.js";
import { getProfile, type ProfileRow } from "../../db/profiles-store.js";
import {
  activateProfile,
  createAccountProfile,
  deleteAccountProfile,
  listAccountProfiles,
  readPreferences,
  renameAccountProfile,
  writePreferences,
} from "./service.js";
import { present } from "../../lib/present.js";
import { errorBody } from "../../plugins/errors.js";

const idParams = z.object({ id: z.string() });
/** `?reassign=1` (or `true`) moves the profile's notes to the default profile; anything else, or a repeat, is no. */
const deleteQuery = z.object({ reassign: z.string().optional().catch(undefined) });

/**
 * HTTP for profiles. Validation in, status codes out;
 * every rule about what a profile *is* lives in `profiles.service.ts`.
 *
 * Every route here takes a client-supplied profile id, which makes account
 * ownership the one thing that must never be skipped: an unchecked id is a
 * cross-account read. `ownedProfile` is the single gate — every handler goes
 * through it — and it answers a foreign id with **404, not 403**, because a 403
 * confirms the id exists on somebody else's account.
 */
export const profileRoutes: FastifyPluginAsyncZod = async (app) => {
  // The app-wide guard (plugins/auth) attaches the session, or answers
  // 401/403, so these are safe on every route in this file.
  const accountId = (request: FastifyRequest): string =>
    present(request.auth, "the session the guard resolved").user.id;
  /** The device this request came from — the session it signed in with. */
  const deviceId = (request: FastifyRequest): string =>
    present(request.auth, "the session the guard resolved").session.idHash;

  /**
   * Resolve `:id` to a profile **on the caller's own account**, or answer 404
   * and return null. The 404-not-403 is the security rule of this file; the
   * ownership comparison is the only thing standing between a guessed id and
   * another household's reading life.
   */
  async function ownedProfile(request: FastifyRequest, id: string, reply: FastifyReply): Promise<ProfileRow | null> {
    const row = await getProfile(id);
    if (!row || row.subject !== accountId(request)) {
      void reply.status(404).send({ error: "NOT_FOUND" });
      return null;
    }
    return row;
  }

  app.get("/profiles", { schema: { response: { 200: profileListSchema } } }, async (request) => {
    const rows = await listAccountProfiles(accountId(request));
    return rows.map(toProfile);
  });

  app.post(
    "/profiles",
    { schema: { body: createProfileSchema, response: { 201: profileSchema, 400: errorBody, 409: errorBody } } },
    async (request, reply) => {
      const result = await createAccountProfile(accountId(request), request.body);
      if (!result.ok) {
        if (result.reason === "LIMIT") {
          return reply.status(400).send({ error: "PROFILE_LIMIT", limit: result.limit });
        }
        return reply.status(409).send({ error: "NAME_TAKEN" });
      }
      return reply.status(201).send(toProfile(result.profile));
    },
  );

  app.patch(
    "/profiles/:id",
    {
      schema: {
        params: idParams,
        body: updateProfileSchema,
        response: { 200: profileSchema, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => {
      const profile = await ownedProfile(request, request.params.id, reply);
      if (!profile) return reply;
      const result = await renameAccountProfile(profile, request.body);
      if (!result.ok) return reply.status(409).send({ error: "NAME_TAKEN" });
      return reply.send(toProfile(result.profile));
    },
  );

  app.delete(
    "/profiles/:id",
    {
      schema: {
        params: idParams,
        querystring: deleteQuery,
        response: { 204: z.null(), 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => {
      const profile = await ownedProfile(request, request.params.id, reply);
      if (!profile) return reply;

      const { reassign } = request.query;
      const result = await deleteAccountProfile(profile, {
        subject: accountId(request),
        reassign: reassign === "1" || reassign === "true",
        sid: deviceId(request),
        isActiveProfile: request.authProfile?.id === profile.id,
        log: request.log,
      });

      if (!result.ok) {
        if (result.reason === "HAS_NOTES") {
          return reply.status(409).send({ error: "PROFILE_HAS_NOTES", noteCount: result.noteCount });
        }
        return reply.status(400).send({ error: result.reason });
      }
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/profiles/:id/activate",
    { schema: { params: idParams, response: { 200: profileSchema, 404: errorBody } } },
    async (request, reply) => {
      const profile = await ownedProfile(request, request.params.id, reply);
      if (!profile) return reply;
      // The guard sets `auth` on every non-allowlisted request, and this route is
      // not allowlisted. Activation is recorded against the **device**
      // (`subject` + `sid`, the account and its session), which keeps D35's
      // per-device behaviour.
      await activateProfile(accountId(request), deviceId(request), profile);
      return reply.send(toProfile(profile));
    },
  );

  /**
   * Read a profile's preferences. It earns its place because `profileSchema`
   * deliberately carries no `preferences` field, so neither the login response
   * nor the activate response includes the blob — this is the only way to fetch
   * it. `{}` for a profile that has never written any. The schema is a loose
   * object, so unknown keys pass through both ways.
   */
  app.get(
    "/profiles/:id/preferences",
    { schema: { params: idParams, response: { 200: preferencesSchema, 404: errorBody } } },
    async (request, reply) => {
      const profile = await ownedProfile(request, request.params.id, reply);
      if (!profile) return reply;
      return reply.send(readPreferences(profile));
    },
  );

  app.patch(
    "/profiles/:id/preferences",
    { schema: { params: idParams, body: preferencesSchema, response: { 200: preferencesSchema, 404: errorBody } } },
    async (request, reply) => {
      const profile = await ownedProfile(request, request.params.id, reply);
      if (!profile) return reply;
      return reply.send(await writePreferences(profile, request.body));
    },
  );
};
