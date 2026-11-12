import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";

// Only the server and the compose healthcheck read this reply, so its schema lives here.
const healthSchema = z.object({ status: z.literal("ok") });

/** `GET /health`: the compose healthcheck's liveness probe, open without a session (the guard's `publicRoutes`). */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/health", { schema: { response: { 200: healthSchema } } }, async () => ({ status: "ok" as const }));
};
