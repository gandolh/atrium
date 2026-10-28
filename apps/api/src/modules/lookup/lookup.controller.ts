import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { lookupApplySchema, lookupSearchParamsSchema } from "@ebook-reader/shared";
import { getBookForProfile } from "../library/library.service.js";
import { applyLookup, lookupThumbnail, searchForItem } from "./lookup.service.js";

/**
 * Metadata lookup HTTP (brief 100, D59).
 *
 * - `GET /library/:id/lookup?title=&author=` searches the item's source and
 *   answers up to ten candidates. An empty list is "no results", a 200.
 * - `POST /library/:id/lookup` writes the chosen candidate's ticked fields and
 *   answers the updated item.
 * - `GET /lookup/covers/:source/:ref` is a candidate's thumbnail, fetched by
 *   the API so the browser never contacts a source.
 *
 * All three sit behind the app-wide guard, and none is on the Discord bot's
 * allowlist (D55). A source that cannot be reached is a 502 naming it,
 * `{ error: "UPSTREAM", source }`, so the dialog can say which one. Like the
 * cover setter (D40), nothing is profile-scoped: the library is install-wide.
 */
export function registerLookupRoutes(app: FastifyInstance): void {
  app.get("/library/:id/lookup", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = lookupSearchParamsSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_QUERY" });

    const result = await searchForItem(id, parsed.data);
    if (!result.ok) {
      switch (result.reason) {
        case "NOT_FOUND":
          return reply.status(404).send({ error: "Book not found." });
        case "NO_SOURCE":
          return reply.status(422).send({ error: "NO_LOOKUP_SOURCE" });
        case "EMPTY_QUERY":
          return reply.status(400).send({ error: "EMPTY_QUERY" });
        case "UPSTREAM":
          request.log.error({ err: result.cause, source: result.source }, "metadata lookup search failed");
          return reply.status(502).send({ error: "UPSTREAM", source: result.source });
      }
    }
    request.log.info({ source: result.data.source, cached: result.cached }, "metadata lookup search");
    return reply.send(result.data);
  });

  app.post("/library/:id/lookup", async (request: FastifyRequest, reply: FastifyReply) => {
    const profile = request.authProfile;
    if (!profile) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const { id } = request.params as { id: string };
    const parsed = lookupApplySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_BODY" });

    const result = await applyLookup(id, parsed.data);
    if (!result.ok) {
      switch (result.reason) {
        case "NOT_FOUND":
          return reply.status(404).send({ error: "Book not found." });
        case "NO_SOURCE":
          return reply.status(422).send({ error: "NO_LOOKUP_SOURCE" });
        case "WRONG_SOURCE":
          return reply.status(422).send({ error: "WRONG_SOURCE" });
        case "NO_COVER":
          return reply.status(422).send({ error: "NO_COVER" });
        case "BAD_COVER":
          return reply.status(502).send({ error: "BAD_COVER", source: parsed.data.candidate.source });
        case "UPSTREAM":
          request.log.error({ err: result.cause, source: result.source }, "metadata lookup cover fetch failed");
          return reply.status(502).send({ error: "UPSTREAM", source: result.source });
      }
    }
    const book = await getBookForProfile(profile.id, id);
    if (!book) return reply.status(404).send({ error: "Book not found." });
    return reply.send(book);
  });

  app.get("/lookup/covers/:source/:ref", async (request: FastifyRequest, reply: FastifyReply) => {
    const { source, ref } = request.params as { source: string; ref: string };
    const result = await lookupThumbnail(source, ref);
    if (!result.ok) {
      switch (result.reason) {
        case "BAD_REF":
          return reply.status(400).send({ error: "BAD_REF" });
        case "NO_COVER":
          return reply.status(404).send({ error: "NO_COVER" });
        case "UPSTREAM":
          request.log.warn({ err: result.cause, source: result.source }, "metadata lookup thumbnail failed");
          return reply.status(502).send({ error: "UPSTREAM", source: result.source });
      }
    }
    // A source's cover under one id does not change, and the response is
    // cookie-gated: private, a day.
    return reply
      .header("Content-Type", "image/jpeg")
      .header("Cache-Control", "private, max-age=86400")
      .send(result.bytes);
  });
}
