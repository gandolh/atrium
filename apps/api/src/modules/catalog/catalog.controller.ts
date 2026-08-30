import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { catalogSearchParamsSchema, importRequestSchema } from "@ebook-reader/shared";
import { toLibraryBook } from "../library/library.mapper.js";
import { importGutenbergBook, searchCatalog } from "./catalog.service.js";
import { UPSTREAM_ERROR } from "./gutendex.service.js";

/**
 * Catalog (Project Gutenberg) HTTP — brief 22.
 *
 * - `GET /catalog/gutenberg` proxies the public Gutendex `/books` endpoint
 *   (search / topic / language / page, popular by default).
 * - `POST /library/import { gutenbergId }` pulls one book into the library.
 *
 * Both sit behind the app-wide auth guard — no bespoke auth. Errors match the
 * library routes' JSON shape: `{ error: string }`.
 */
export function registerCatalogRoutes(app: FastifyInstance): void {
  app.get("/catalog/gutenberg", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = catalogSearchParamsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid catalog query." });
    }

    const result = await searchCatalog(parsed.data);
    if (!result.ok) {
      request.log.error({ err: result.cause }, "Gutendex catalog request failed");
      return reply.status(502).send({ error: UPSTREAM_ERROR });
    }
    request.log.info(
      { cached: result.cached },
      result.cached
        ? "catalog cache hit (served from TTL cache)"
        : "catalog cache miss (fetched from Gutendex)",
    );
    return reply.send(result.data);
  });

  app.post("/library/import", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = importRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "gutenbergId must be a positive integer." });
    }
    const { gutenbergId } = parsed.data;

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
  });
}
