import type { FastifyInstance } from "fastify";

/** `GET /health`: the compose healthcheck's liveness probe, open without a session (the guard's `publicRoutes`). */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    return { status: "ok" };
  });
}
