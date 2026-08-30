import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  authStatusSchema,
  loginRequestSchema,
  loginResponseSchema,
} from "@ebook-reader/shared";
import { toProfile } from "../profiles/profiles.mapper.js";
import { presentedToken } from "./auth.guard.js";
import { login, logout } from "./auth.service.js";

/**
 * Auth endpoints. `/auth/status` is always reachable so the web app can decide
 * whether to show the login screen (always required now). `/auth/login` trades
 * username + password for a session token. `/auth/logout` revokes the caller's
 * session. All three are allowlisted in the guard.
 */
export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/status", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(authStatusSchema.parse({ required: true }));
  });

  app.post("/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_REQUEST" });
    }

    const result = await login(parsed.data.username, parsed.data.password);
    if (!result.ok) {
      if (result.reason === "NO_PROFILE") {
        request.log.error({ userId: result.userId }, "account has no profile");
        return reply.status(500).send({ error: "NO_PROFILE" });
      }
      return reply.status(401).send({ error: "UNAUTHORIZED" });
    }

    return reply.send(
      loginResponseSchema.parse({
        token: result.token,
        username: result.username,
        profile: toProfile(result.active),
        profiles: result.profiles.map(toProfile),
      }),
    );
  });

  app.post("/auth/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = presentedToken(request);
    if (token) await logout(token);
    return reply.status(204).send();
  });
}
