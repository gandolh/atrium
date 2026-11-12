import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

/**
 * The one app-wide error handler, wrapped in fastify-plugin so it is set on
 * the root and every route, and every route-level `errorHandler` that passes
 * an error on with `reply.send(error)`, ends here. Registered first in
 * `buildApp`.
 *
 * Fastify's default answers a 500 with the error's own `message`, and for a
 * Knex/SQLite error that is the **full SQL statement with its bound values**
 * (the compile-slot fix's regression run received one, Ward subject included). A server
 * error tells the client only that it happened, `{ error: "INTERNAL" }`; the
 * real error goes to the log with the request id. A 4xx raised by Fastify
 * itself (bad JSON, a body too large, an unsupported media type) describes the
 * request, so it keeps its status and message: passed on to Fastify's default
 * handler unchanged.
 */
const errorHandling: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.send(error);
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: "INTERNAL" });
  });
};

export const errors = fp(errorHandling, { name: "errors" });
