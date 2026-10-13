import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getDefaultProfile, getProfile, type ProfileRow } from "../profiles/profiles.model.js";
import { getSelectedProfileId } from "../profiles/profile-selection.model.js";
import { ensureDefaultProfile } from "../../database/bootstrap.js";
import { API_PREFIX, APP_PREFIX, PUBLIC_ORIGIN } from "../../common/config.js";
import { wardAuth, type Accounts, type WardClient } from "../../../vendor/ward/ward-auth.js";

/**
 * The app-wide session guard: Ward's vendored library, then atrium's own rules.
 *
 * ## What survived, again
 *
 * **The shape.** One `onRequest` guard registered before every route, so a
 * handler that exists at all has an authenticated caller, was right under D30
 * and D53 and is right now. The library is built around exactly that shape
 * (its plugin is an `onRequest` hook that escapes encapsulation), so atrium's
 * rule carries over unchanged.
 *
 * **What is underneath changed for the second time (D58).** Accounts are
 * atrium's own again: users, scrypt passwords, lockout and opaque sessions in
 * this database, all of it the library's. Ward is a linked second way in, an
 * OpenID Connect flow the library finishes, and a session that began with Ward
 * is checked against Ward every 30 seconds. Atrium writes none of that code.
 *
 * ## The cookie, and why covers still load
 *
 * `atrium_session`, `HttpOnly`, `SameSite=Lax`, `Path=/atrium-api`. Narrower
 * than Ward's old `Path=/` cookie on purpose: the estate shares one origin,
 * and no other app needs atrium's session. Every request that needs it lives
 * under the API prefix already, because `apiUrl()` in the web client builds
 * every API URL there, cover `<img>` and `<audio>`/`<video>` sources included.
 * So no `?token=` comes back.
 *
 * ## What atrium adds after the library
 *
 * A second `onRequest` hook, registered after the plugin so it runs after the
 * library's guard and sees `request.auth`:
 *
 * 1. **The jukebox allowlist (D55).** The role lives in atrium's own row now,
 *    and it is one string: `jukebox`, or anything else for full access.
 * 2. **The active profile (D35).** Unchanged, re-keyed: the account is the
 *    local user's id, and the device is the session's id hash.
 *
 * Allowlisted requests (`/health`, the library's public auth routes) have
 * `request.auth === null` and skip both.
 */

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The active profile. Always set alongside `auth`, so a handler holding one
     * holds the other.
     */
    authProfile?: ProfileRow;
    /**
     * Whether the caller's role is `jukebox` (D55). Such a caller only reaches
     * the Jukebox and `audio` files and covers. False on allowlisted requests,
     * which have no caller at all.
     */
    jukeboxOnly: boolean;
  }
}

/** The one role atrium reads (D55): the Discord bot's account holds it. */
export const JUKEBOX_ROLE = "jukebox";

/** Full access. What every account that is not the bot holds (D58). */
export const MEMBER_ROLE = "member";

/** The cookie's name. Unique in the estate: every app shares one origin. */
export const SESSION_COOKIE = "atrium_session";

/** Where the library mounts its routes, Fastify-side. The browser adds `API_PREFIX`. */
const AUTH_ROUTE_PREFIX = "/auth";

/**
 * A new user's role, from the role their Ward grant names. Atrium has two:
 * `jukebox` stays `jukebox`, and anything else (Ward's seed grants `admin`) is
 * full access. After creation the row is the only truth.
 */
export function roleForWardRole(wardRole: string): string {
  return wardRole === JUKEBOX_ROLE ? JUKEBOX_ROLE : MEMBER_ROLE;
}

/** The library routes a jukebox-only caller may `GET`, by route pattern. */
const JUKEBOX_LIBRARY_ROUTES = new Set(["/library/:id/file", "/library/:id/cover"]);

/**
 * The jukebox-only allowlist (D55, brief 80): `/jukebox/*`, an item's file and
 * cover, and the caller's own account routes (signing out, a password). The
 * handlers of the file and cover routes then refuse anything that isn't
 * `audio`.
 *
 * It matches the **route pattern** Fastify resolved, never the raw URL, so a
 * query string or a percent-encoding cannot reach a handler the pattern would
 * not. The single raw-URL test is for a request that matched no route: no
 * handler runs for it either way, and letting a `/jukebox/` path through means
 * the bot reads an unbuilt endpoint as a 404 rather than as a permissions
 * fault. Every other unmatched path is a 403.
 */
function jukeboxMayReach(request: FastifyRequest): boolean {
  const pattern = request.routeOptions.url;
  if (pattern === undefined) return request.url.startsWith("/jukebox/");
  if (pattern.startsWith("/jukebox/")) return true;
  if (pattern.startsWith(`${AUTH_ROUTE_PREFIX}/`)) return true;
  return request.method === "GET" && JUKEBOX_LIBRARY_ROUTES.has(pattern);
}

export interface AuthGuardOptions {
  /** From `openAccounts()` (`database/auth-store.ts`). */
  accounts: Accounts;
  /**
   * "Sign in with Ward". `index.ts` builds it from the `WARD_OIDC_*` variables;
   * tests inject one over a fake `fetch`. Absent, atrium has local accounts
   * only, and a session that began with Ward is refused (`ward_unavailable`).
   */
  wardClient?: WardClient;
}

export async function registerAuthGuard(app: FastifyInstance, options: AuthGuardOptions): Promise<void> {
  /*
   * First, before every route and plugin of atrium's own: Fastify copies hooks
   * into a child context when the child is created, so anything registered
   * earlier would not be guarded.
   */
  await app.register(wardAuth, {
    accounts: options.accounts,
    cookieName: SESSION_COOKIE,
    cookiePath: API_PREFIX,
    publicOrigin: PUBLIC_ORIGIN,
    routePrefix: AUTH_ROUTE_PREFIX,
    // A liveness probe is not a person (the compose healthcheck calls it).
    publicRoutes: ["GET /health"],
    // No `registration`: atrium has no Register page. Users come from
    // `npm run seed:user`, or from a first "Sign in with Ward" with a grant.
    ...(options.wardClient && {
      ward: {
        client: options.wardClient,
        loginPath: `${APP_PREFIX}/login`,
        settingsPath: `${APP_PREFIX}/settings`,
        afterSignInPath: `${APP_PREFIX}/`,
        roleFor: roleForWardRole,
      },
    }),
  });

  app.decorateRequest("jukeboxOnly", false);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.auth;
    if (!auth) return;

    /*
     * The bot's allowlist (D55), before a profile is touched. The library has
     * no owners and `DELETE /library/:id` checks nothing, so a leaked bot
     * password must not carry full access.
     */
    const jukeboxOnly = auth.user.role === JUKEBOX_ROLE;
    if (jukeboxOnly && !jukeboxMayReach(request)) {
      return reply.status(403).send({ error: "JUKEBOX_ROLE_FORBIDDEN" });
    }

    /*
     * The first request from a new account creates its profile. Accounts are
     * made by the seed script or by a first Ward sign-in, both out of atrium's
     * sight, so arriving with no profile is what a new account looks like.
     * One indexed lookup on the ordinary path; an insert once per account.
     */
    const accountId = auth.user.id;
    await ensureDefaultProfile(accountId);

    /*
     * A missing or stale active profile is NEVER an auth failure (D35). The
     * ownership re-check is belt-and-braces: only the activate route writes a
     * selection and it verifies ownership, but a profile id is the one value
     * here that ever came from a client.
     */
    const selected = await getSelectedProfileId(accountId, auth.session.idHash);
    const active = selected ? await getProfile(selected) : undefined;
    const profile =
      active && active.subject === accountId ? active : await getDefaultProfile(accountId);

    if (!profile) {
      // Unreachable in practice: `ensureDefaultProfile` ran just above. If it
      // happens, every profile-scoped route would silently read or write
      // nothing, so fail loudly rather than serve an empty library.
      request.log.error({ userId: accountId }, "account has no profile");
      return reply.status(500).send({ error: "NO_PROFILE" });
    }

    request.authProfile = profile;
    request.jukeboxOnly = jukeboxOnly;
  });
}
