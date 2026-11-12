import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  botAdvanceRequestSchema,
  botAdvanceResponseSchema,
  botCommandsQuerySchema,
  botCommandsResponseSchema,
  botStatusRequestSchema,
  botStatusResponseSchema,
  controlRequestSchema,
  discordIdSchema,
  playerListSchema,
  playerSchema,
  queueAddRequestSchema,
  queueMoveRequestSchema,
  settingsRequestSchema,
  trackSchema,
} from "@ebook-reader/shared";
import {
  addToQueue,
  advance,
  changeSettings,
  clearQueue,
  control,
  JukeboxError,
  listPlayers,
  moveInQueue,
  pollCommands,
  readPlayer,
  releaseLongPolls,
  removeFromQueue,
  reportStatus,
  searchTracks,
  type QueueAdder,
} from "./service.js";
import { present } from "../../lib/present.js";
import { errorBody } from "../../plugins/errors.js";

const guildParams = z.object({ guildId: discordIdSchema });
/** `:entryId` stays a string: one that is not a whole number is an entry that doesn't exist, a 404. */
const entryParams = z.object({ guildId: discordIdSchema, entryId: z.string() });
/** The refusals a Player route can answer (`JukeboxError`): 400, 404 or 409, `{ error: CODE }`. */
const refusals = { 400: errorBody, 404: errorBody, 409: errorBody } as const;

/** A whole-number `:entryId`, or undefined. */
function entryIdOf(raw: string): number | undefined {
  const entryId = Number(raw);
  return Number.isSafeInteger(entryId) ? entryId : undefined;
}

/** Answer a service refusal with its code; anything else is the app's 500. */
async function answer(reply: FastifyReply, work: () => Promise<unknown>): Promise<FastifyReply> {
  try {
    return reply.send(await work());
  } catch (error) {
    if (error instanceof JukeboxError) return reply.status(error.status).send({ error: error.code });
    throw error;
  }
}

/**
 * The bot routes refuse a person, so only the bot reports what it is doing.
 * A route `onRequest` hook, so the refusal comes after the guard's and before
 * the request is validated, as it did when the handler checked first.
 */
async function botOnly(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (request.jukeboxOnly) return undefined;
  return reply.status(403).send({ error: "JUKEBOX_BOT_ONLY" });
}

/**
 * HTTP for the Jukebox (D55, D56, D57). Validation in, status codes
 * out; the next-Track rules live in `service.ts`. Errors are
 * `{error: "CODE"}`, as the guard answers them.
 *
 * Two audiences. People (any profile) and the bot account both use the Player
 * routes: Discord's slash commands arrive through the bot. The `/jukebox/bot/*`
 * routes are the bot's alone, so nobody can fake its status. The guard already
 * keeps the bot account inside `/jukebox/*` and audio files. just-a-bot calls
 * these routes: their paths, status codes and bodies are its contract.
 */
export const jukeboxRoutes: FastifyPluginAsyncZod = async (app) => {
  // On shutdown, answer the bot's held long poll first. Fastify runs its onClose
  // hooks only after the requests in flight finish, so a poll left waiting
  // would hold the process up for the rest of its wait.
  app.addHook("preClose", async () => {
    releaseLongPolls();
  });

  // --- People and the bot -----------------------------------------------------

  app.get(
    "/jukebox/players",
    { schema: { response: { 200: playerListSchema, ...refusals } } },
    async (_request, reply) => answer(reply, listPlayers),
  );

  app.get(
    "/jukebox/players/:guildId",
    { schema: { params: guildParams, response: { 200: playerSchema, ...refusals } } },
    async (request, reply) => answer(reply, () => readPlayer(request.params.guildId)),
  );

  app.get(
    "/jukebox/tracks",
    {
      schema: {
        // A `q` read only when it is one string, as the hand check read it.
        querystring: z.object({ q: z.string().optional().catch(undefined) }),
        response: { 200: z.array(trackSchema), ...refusals },
      },
    },
    async (request, reply) => answer(reply, () => searchTracks(request.query.q)),
  );

  app.post(
    "/jukebox/players/:guildId/control",
    { schema: { params: guildParams, body: controlRequestSchema, response: { 200: playerSchema, ...refusals } } },
    async (request, reply) => answer(reply, () => control(request.params.guildId, request.body)),
  );

  app.patch(
    "/jukebox/players/:guildId/settings",
    { schema: { params: guildParams, body: settingsRequestSchema, response: { 200: playerSchema, ...refusals } } },
    async (request, reply) => answer(reply, () => changeSettings(request.params.guildId, request.body)),
  );

  app.post(
    "/jukebox/players/:guildId/queue",
    { schema: { params: guildParams, body: queueAddRequestSchema, response: { 200: playerSchema, ...refusals } } },
    async (request, reply) => {
      // A person's entry is theirs, whatever the body says. The bot must name
      // the Discord member it is acting for.
      let adder: QueueAdder;
      if (request.jukeboxOnly) {
        if (!request.body.addedBy) return reply.status(400).send({ error: "INVALID_REQUEST" });
        adder = { kind: "discord", name: request.body.addedBy.name };
      } else {
        adder = { kind: "profile", name: present(request.authProfile, "the profile the guard resolved").name };
      }
      return answer(reply, () => addToQueue(request.params.guildId, request.body, adder));
    },
  );

  app.delete(
    "/jukebox/players/:guildId/queue/:entryId",
    { schema: { params: entryParams, response: { 200: playerSchema, ...refusals } } },
    async (request, reply) => {
      const entryId = entryIdOf(request.params.entryId);
      if (entryId === undefined) return reply.status(404).send({ error: "ENTRY_NOT_FOUND" });
      return answer(reply, () => removeFromQueue(request.params.guildId, entryId));
    },
  );

  app.post(
    "/jukebox/players/:guildId/queue/:entryId/move",
    {
      schema: {
        params: entryParams,
        body: queueMoveRequestSchema,
        response: { 200: playerSchema, ...refusals },
      },
    },
    async (request, reply) => {
      const entryId = entryIdOf(request.params.entryId);
      if (entryId === undefined) return reply.status(404).send({ error: "ENTRY_NOT_FOUND" });
      return answer(reply, () => moveInQueue(request.params.guildId, entryId, request.body.toIndex));
    },
  );

  app.delete(
    "/jukebox/players/:guildId/queue",
    { schema: { params: guildParams, response: { 200: playerSchema, ...refusals } } },
    async (request, reply) => answer(reply, () => clearQueue(request.params.guildId)),
  );

  // --- The bot only -----------------------------------------------------------

  app.get(
    "/jukebox/bot/commands",
    {
      onRequest: botOnly,
      schema: {
        querystring: botCommandsQuerySchema,
        response: { 200: botCommandsResponseSchema, 403: errorBody, ...refusals },
      },
    },
    async (request, reply) => {
      // `close` fires when the response finishes or the client goes away. Only
      // the second can happen while the poll waits, and then nobody is listening.
      const onClose = (listener: () => void) => reply.raw.once("close", listener);
      return answer(reply, () => pollCommands(request.query.after, request.query.wait, onClose));
    },
  );

  app.post(
    "/jukebox/bot/status",
    {
      onRequest: botOnly,
      schema: { body: botStatusRequestSchema, response: { 200: botStatusResponseSchema, 403: errorBody, ...refusals } },
    },
    async (request, reply) => answer(reply, () => reportStatus(request.body)),
  );

  app.post(
    "/jukebox/bot/players/:guildId/advance",
    {
      onRequest: botOnly,
      schema: {
        params: guildParams,
        body: botAdvanceRequestSchema,
        response: { 200: botAdvanceResponseSchema, 403: errorBody, ...refusals },
      },
    },
    async (request, reply) => answer(reply, () => advance(request.params.guildId, request.body)),
  );
};
