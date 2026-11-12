import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import {
  catalogSearchParamsSchema,
  catalogSearchResponseSchema,
  importRequestSchema,
  libraryBookSchema,
} from "@ebook-reader/shared";
import { toLibraryBook } from "../library/index.js";
import { importGutenbergBook, searchCatalog } from "./service.js";
import { UPSTREAM_ERROR } from "./gutendex.service.js";
import { errorBody, invalidRequestAs } from "../../plugins/errors.js";

/**
 * Catalog (Project Gutenberg) HTTP.
 *
 * - `GET /catalog/gutenberg` proxies the public Gutendex `/books` endpoint
 *   (search / topic / language / page, popular by default).
 * - `POST /library/import { gutenbergId }` pulls one book into the library.
 *
 * Both sit behind the app-wide auth guard — no bespoke auth. Errors match the
 * library routes' JSON shape: `{ error: string }`, and a request that fails a
 * schema answers with the sentence each route has always sent.
 */
export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/catalog/gutenberg",
    {
      errorHandler: invalidRequestAs({ error: "Invalid catalog query." }),
      schema: {
        querystring: catalogSearchParamsSchema,
        response: { 200: catalogSearchResponseSchema, 502: errorBody },
      },
    },
    async (request, reply) => {
      const result = await searchCatalog(request.query);
      if (!result.ok) {
        request.log.error({ err: result.cause }, "Gutendex catalog request failed");
        return reply.status(502).send({ error: UPSTREAM_ERROR });
      }
      request.log.info(
        { cached: result.cached },
        result.cached ? "catalog cache hit (served from TTL cache)" : "catalog cache miss (fetched from Gutendex)",
      );
      return reply.send(result.data);
    },
  );

  app.post(
    "/library/import",
    {
      errorHandler: invalidRequestAs({ error: "gutenbergId must be a positive integer." }),
      schema: {
        body: importRequestSchema,
        response: { 201: libraryBookSchema, 404: errorBody, 413: errorBody, 422: errorBody, 502: errorBody },
      },
    },
    async (request, reply) => {
      const { gutenbergId } = request.body;

      const result = await importGutenbergBook(gutenbergId, request.log);
      if (!result.ok) {
        switch (result.reason) {
          case "NOT_FOUND":
            return reply.status(404).send({ error: `No Project Gutenberg book #${gutenbergId}.` });
          case "NO_EPUB":
            return reply.status(422).send({ error: "This book has no EPUB edition to import." });
          case "TOO_LARGE":
            return reply.status(413).send({ error: "The book's EPUB exceeds the size limit." });
          case "RESOLVE_FAILED":
            request.log.error({ err: result.cause, gutenbergId }, "Gutendex resolve failed");
            return reply.status(502).send({ error: UPSTREAM_ERROR });
          case "DOWNLOAD_FAILED":
            request.log.error({ err: result.cause, gutenbergId }, "Gutenberg EPUB download failed");
            return reply.status(502).send({
              error: "Downloading the EPUB from Project Gutenberg failed. Please retry.",
            });
        }
      }
      return reply.status(201).send(toLibraryBook(result.row));
    },
  );
};
