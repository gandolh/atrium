import { STATUS_CODES } from "node:http";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "@fastify/type-provider-zod";
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";

/**
 * The response schema of every error status a handler sends itself: the body
 * passes through whole, keys in the handler's order. Atrium's error body is
 * flat, `{ error: CODE, message? }` plus whatever a route adds (`limit`,
 * `noteCount`, `source`), and a shape here would reorder those keys. A status
 * declared with it also carries Fastify's own error bodies (bad JSON on a
 * route that declares 400), which the handler below writes out in full.
 */
export const errorBody = z.record(z.string(), z.unknown());

/** The body of a request that fails its route's schema, unless the route names its own. */
const INVALID_REQUEST = { error: "INVALID_REQUEST" } as const;

/**
 * A route-level `errorHandler` for a route whose clients know its own code for
 * a bad request (`INVALID_QUERY`, the catalog's sentence): a request that
 * fails the route's schema answers 400 with `body`, and every other error goes
 * on to the app's handler below.
 */
export function invalidRequestAs(body: { error: string }) {
  return (error: FastifyError, _request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    hasZodFastifySchemaValidationErrors(error) ? reply.status(400).send(body) : reply.send(error);
}

/**
 * The one app-wide error handler, wrapped in fastify-plugin so it is set on
 * the root and every route, and every route-level `errorHandler` that passes
 * an error on with `reply.send(error)`, ends here. Registered first in
 * `buildApp`.
 *
 * - A request that fails its route's schema is a 400 `{ error:
 *   "INVALID_REQUEST" }`, the body the handlers sent when they parsed by hand.
 *   Validation runs before the handler, so a malformed body on another
 *   account's id is a 400, and a well-formed one still a 404.
 * - A reply its response schema refuses is a 500 `{ error: "INTERNAL" }`: a
 *   bug, never the client's fault. It is logged by its name, code, method and
 *   URL.
 * - A 4xx raised by Fastify or a plugin (bad JSON, a body too large, an
 *   unsupported media type, a non-multipart upload) describes the request, so
 *   it keeps its status and the body Fastify's default handler writes,
 *   `{ statusCode, code, error, message }`, built here so a route's declared
 *   error schema passes it through unchanged.
 * - Anything else is a 500 `{ error: "INTERNAL" }`. Fastify's default would
 *   answer with the error's own message, and for a Knex/SQLite error that is
 *   the **full SQL statement with its bound values** (the compile-slot fix's
 *   regression run received one, Ward subject included). The real error goes
 *   to the log with the request id.
 */
const errorHandling: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) return reply.status(400).send(INVALID_REQUEST);
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: { name: error.name, code: error.code }, method: error.method, url: error.url },
        "a reply doesn't match its response schema",
      );
      return reply.status(500).send({ error: "INTERNAL" });
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply
        .status(status)
        .send({ statusCode: status, code: error.code, error: STATUS_CODES[status], message: error.message });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "INTERNAL" });
  });
};

export const errors = fp(errorHandling, { name: "errors" });
