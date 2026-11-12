import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";
import {
  libraryBookSchema,
  lookupApplySchema,
  lookupSearchParamsSchema,
  lookupSearchResponseSchema,
  lookupSourceSchema,
} from "@ebook-reader/shared";
import { getBookForProfile } from "../library/index.js";
import { applyLookup, lookupThumbnail, searchForItem } from "./service.js";
import { errorBody, invalidRequestAs } from "../../plugins/errors.js";

const idParams = z.object({ id: z.string() });
const coverParams = z.object({ source: lookupSourceSchema, ref: z.string() });

/**
 * Metadata lookup HTTP (D59).
 *
 * - `GET /library/:id/lookup?title=&author=` searches the item's source and
 *   answers up to ten candidates. An empty list is "no results", a 200.
 * - `POST /library/:id/lookup` writes the chosen candidate's ticked fields and
 *   answers the updated item.
 * - `GET /lookup/covers/:source/:ref` is a candidate's thumbnail, fetched by
 *   the API so the browser never contacts a source. A binary reply, so no
 *   response schema (scripts/conventions.json).
 *
 * All three sit behind the app-wide guard, and none is on the Discord bot's
 * allowlist (D55). A source that cannot be reached is a 502 naming it,
 * `{ error: "UPSTREAM", source }`, so the dialog can say which one. Like the
 * cover setter (D40), nothing is profile-scoped: the library is install-wide.
 * A request that fails a schema answers with the code each route always sent:
 * `INVALID_QUERY`, `INVALID_BODY`, `BAD_REF`.
 */
export const lookupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/library/:id/lookup",
    {
      errorHandler: invalidRequestAs({ error: "INVALID_QUERY" }),
      schema: {
        params: idParams,
        querystring: lookupSearchParamsSchema,
        response: { 200: lookupSearchResponseSchema, 400: errorBody, 404: errorBody, 422: errorBody, 502: errorBody },
      },
    },
    async (request, reply) => {
      const result = await searchForItem(request.params.id, request.query);
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
    },
  );

  app.post(
    "/library/:id/lookup",
    {
      errorHandler: invalidRequestAs({ error: "INVALID_BODY" }),
      schema: {
        params: idParams,
        body: lookupApplySchema,
        response: { 200: libraryBookSchema, 401: errorBody, 404: errorBody, 422: errorBody, 502: errorBody },
      },
    },
    async (request, reply) => {
      const profile = request.authProfile;
      if (!profile) return reply.status(401).send({ error: "UNAUTHORIZED" });
      const { id } = request.params;

      const result = await applyLookup(id, request.body);
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
            return reply.status(502).send({ error: "BAD_COVER", source: request.body.candidate.source });
          case "UPSTREAM":
            request.log.error({ err: result.cause, source: result.source }, "metadata lookup cover fetch failed");
            return reply.status(502).send({ error: "UPSTREAM", source: result.source });
        }
      }
      const book = await getBookForProfile(profile.id, id);
      if (!book) return reply.status(404).send({ error: "Book not found." });
      return reply.send(book);
    },
  );

  app.get(
    "/lookup/covers/:source/:ref",
    { errorHandler: invalidRequestAs({ error: "BAD_REF" }), schema: { params: coverParams } },
    async (request, reply) => {
      const { source, ref } = request.params;
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
    },
  );
};
