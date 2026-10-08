import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  botAdvanceRequestSchema,
  botCommandsQuerySchema,
  botStatusRequestSchema,
  controlRequestSchema,
  DISCORD_ID_PATTERN,
  queueAddRequestSchema,
  queueMoveRequestSchema,
  settingsRequestSchema,
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
  removeFromQueue,
  reportStatus,
  searchTracks,
  type QueueAdder,
} from "./jukebox.service.js";

/**
 * HTTP for the Jukebox (brief 81; D55, D56, D57). Validation in, status codes
 * out; the next-Track rules live in `jukebox.service.ts`. Errors are
 * `{error: "CODE"}`, as the guard answers them.
 *
 * Two audiences. People (any profile) and the bot account both use the Player
 * routes: Discord's slash commands arrive through the bot. The `/jukebox/bot/*`
 * routes are the bot's alone, so nobody can fake its status. The guard (brief
 * 80) already keeps the bot account inside `/jukebox/*` and audio files.
 */
export function registerJukeboxRoutes(app: FastifyInstance): void {
  const invalid = (reply: FastifyReply) => reply.status(400).send({ error: "INVALID_REQUEST" });

  /** `:guildId`, or null after answering 400. */
  function guildIdOf(request: FastifyRequest, reply: FastifyReply): string | null {
    const { guildId } = request.params as { guildId?: string };
    if (guildId === undefined || !DISCORD_ID_PATTERN.test(guildId)) {
      void invalid(reply);
      return null;
    }
    return guildId;
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

  /** The bot routes refuse a person, so only the bot reports what it is doing. */
  function botOnly(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.jukeboxOnly) return true;
    void reply.status(403).send({ error: "JUKEBOX_BOT_ONLY" });
    return false;
  }

  // --- People and the bot -----------------------------------------------------

  app.get("/jukebox/players", async (_request, reply) => answer(reply, listPlayers));

  app.get("/jukebox/players/:guildId", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    return answer(reply, () => readPlayer(guildId));
  });

  app.get("/jukebox/tracks", async (request, reply) => {
    const q = (request.query as { q?: unknown } | undefined)?.q;
    return answer(reply, () => searchTracks(typeof q === "string" ? q : undefined));
  });

  app.post("/jukebox/players/:guildId/control", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    const parsed = controlRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    return answer(reply, () => control(guildId, parsed.data));
  });

  app.patch("/jukebox/players/:guildId/settings", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    const parsed = settingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    return answer(reply, () => changeSettings(guildId, parsed.data));
  });

  app.post("/jukebox/players/:guildId/queue", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    const parsed = queueAddRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    // A person's entry is theirs, whatever the body says. The bot must name
    // the Discord member it is acting for.
    let adder: QueueAdder;
    if (request.jukeboxOnly) {
      if (!parsed.data.addedBy) return invalid(reply);
      adder = { kind: "discord", name: parsed.data.addedBy.name };
    } else {
      adder = { kind: "profile", name: request.authProfile!.name };
    }
    return answer(reply, () => addToQueue(guildId, parsed.data, adder));
  });

  app.delete("/jukebox/players/:guildId/queue/:entryId", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    const entryId = Number((request.params as { entryId: string }).entryId);
    if (!Number.isSafeInteger(entryId)) return reply.status(404).send({ error: "ENTRY_NOT_FOUND" });
    return answer(reply, () => removeFromQueue(guildId, entryId));
  });

  app.post("/jukebox/players/:guildId/queue/:entryId/move", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    const entryId = Number((request.params as { entryId: string }).entryId);
    if (!Number.isSafeInteger(entryId)) return reply.status(404).send({ error: "ENTRY_NOT_FOUND" });
    const parsed = queueMoveRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    return answer(reply, () => moveInQueue(guildId, entryId, parsed.data.toIndex));
  });

  app.delete("/jukebox/players/:guildId/queue", async (request, reply) => {
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    return answer(reply, () => clearQueue(guildId));
  });

  // --- The bot only -----------------------------------------------------------

  app.get("/jukebox/bot/commands", async (request, reply) => {
    if (!botOnly(request, reply)) return reply;
    const parsed = botCommandsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply);
    // `close` fires when the response finishes or the client goes away. Only
    // the second can happen while the poll waits, and then nobody is listening.
    const onClose = (listener: () => void) => reply.raw.once("close", listener);
    return answer(reply, () => pollCommands(parsed.data.after, parsed.data.wait, onClose));
  });

  app.post("/jukebox/bot/status", async (request, reply) => {
    if (!botOnly(request, reply)) return reply;
    const parsed = botStatusRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    return answer(reply, () => reportStatus(parsed.data));
  });

  app.post("/jukebox/bot/players/:guildId/advance", async (request, reply) => {
    if (!botOnly(request, reply)) return reply;
    const guildId = guildIdOf(request, reply);
    if (!guildId) return reply;
    const parsed = botAdvanceRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    return answer(reply, () => advance(guildId, parsed.data));
  });
}
