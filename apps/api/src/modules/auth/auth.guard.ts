import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDefaultProfile, getProfile, type ProfileRow } from "../profiles/profiles.model.js";
import { getSessionUser, type SessionUser } from "./auth.model.js";

/**
 * The app-wide session guard (D30). Registered BEFORE every route, so a handler
 * that exists at all has already had its caller authenticated — no route in the
 * codebase does its own auth, and none should.
 */

// Make the guard's resolved identity available to route handlers.
declare module "fastify" {
  interface FastifyRequest {
    /** The account (D30) — the security boundary. */
    authUser?: SessionUser;
    /**
     * The active profile (brief 35) — the identity every profile-scoped read
     * and write is keyed on. Always set alongside `authUser`, so a handler that
     * has one has the other.
     */
    authProfile?: ProfileRow;
    /**
     * The token this request presented. Exposed because `POST
     * /profiles/:id/activate` has to update the caller's *own* session row and
     * `presentedToken` is module-private; re-deriving it in the route would be
     * a second place that has to know about the `?token=` fallback.
     */
    authToken?: string;
  }
}

/** Pull the bearer token from the header, falling back to the `token` query param. */
export function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const query = request.query as { token?: unknown } | undefined;
  // `fast-querystring` parses repeated keys (`?token=a&token=b`) into an array;
  // only a single string value is ever a valid token, so treat anything else
  // (array, object, etc.) as absent.
  if (typeof query?.token === "string" && query.token) return query.token;
  return null;
}

/** Routes reachable without a token: auth endpoints, health, and CORS preflight. */
function isAllowlisted(request: FastifyRequest): boolean {
  if (request.method === "OPTIONS") return true;
  const path = request.url.split("?", 1)[0];
  if (request.method === "POST" && path === "/auth/login") return true;
  if (request.method === "GET" && path === "/auth/status") return true;
  if (request.method === "GET" && path === "/health") return true;
  return false;
}

/**
 * App-wide `onRequest` guard. Must be registered BEFORE the routes. Every
 * non-allowlisted request must present a token that resolves to a live session;
 * the resolved account lands on `request.authUser` and its active profile on
 * `request.authProfile`.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isAllowlisted(request)) return;
    const token = presentedToken(request);
    const user = token ? await getSessionUser(token) : undefined;
    if (!user) {
      return reply.status(401).send({ error: "UNAUTHORIZED" });
    }

    // A missing or stale active profile is NEVER an auth failure (brief 35 step
    // 3): `sessions.active_profile_id` is null for a session that predates the
    // brief and is SET NULL when its profile is deleted — losing a profile must
    // not log the device out. The ownership re-check is belt-and-braces: only
    // the activate route writes this column and it verifies ownership, but a
    // profile id is the one thing here that ever came from a client.
    const active = user.activeProfileId ? await getProfile(user.activeProfileId) : undefined;
    const profile =
      active && active.user_id === user.id ? active : await getDefaultProfile(user.id);
    if (!profile) {
      // Unreachable in practice — `ensureDefaultProfiles()` runs on every boot,
      // so every account has one. If it ever happens, every profile-scoped
      // route below would silently read or write nothing, so fail loudly here
      // rather than serve an empty library as if it were the truth.
      request.log.error({ userId: user.id }, "account has no profile");
      return reply.status(500).send({ error: "NO_PROFILE" });
    }

    request.authUser = user;
    request.authProfile = profile;
    request.authToken = token ?? undefined;
  });
}
