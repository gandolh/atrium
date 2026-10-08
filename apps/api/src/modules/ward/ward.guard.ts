import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getDefaultProfile, getProfile, type ProfileRow } from "../profiles/profiles.model.js";
import { getSelectedProfileId } from "../profiles/profile-selection.model.js";
import { ensureDefaultProfile } from "../../database/bootstrap.js";
import { createWardClient, type WardClient } from "./ward.client.js";
import {
  ATRIUM_APP_SLUG,
  WardAuthenticationError,
  WardForbiddenError,
  WardUnavailableError,
  hasGrant,
  type WardCaller,
} from "./ward.types.js";
import { WARD_API_BASE_PATH, WARD_APP_KEY, WARD_PUBLIC_ORIGIN } from "../../common/config.js";

/**
 * The app-wide session guard, now backed by Ward.
 *
 * ## What survived from the old guard, and what did not
 *
 * **The shape survived, and it is the good part.** Atrium's rule that no route
 * does its own auth — one `onRequest` hook registered before every route, so a
 * handler that exists at all has an authenticated caller — was correct under
 * D30 and is correct now. The failure mode of per-route auth is an ungated
 * route, and this app serves a library.
 *
 * **Everything underneath it is gone.** No `users` table, no `sessions` table,
 * no scrypt, no `getSessionUser`, no operator seed script. Identity is Ward's,
 * and atrium's own row for a person is a *profile* keyed on Ward's subject.
 *
 * **The `?token=` fallback is gone**, and its deletion is a real win rather
 * than a chore. It existed because `<img>` tags for cover art cannot send an
 * `Authorization` header, and it leaked a session token into every URL — which
 * is why `app.ts` still carries a log serialiser that redacts `?token=`.
 * Ward's cookie is `Path=/` on the shared origin, so the browser attaches it to
 * an `<img src>` without being asked.
 *
 * ## Three outcomes, three status codes
 *
 * The distinction matters to the web client, which does different things with
 * each, and collapsing any two of them would strand somebody:
 *
 * - **401** — no token, a bad token, or a session Ward says is not live. The
 *   client redirects to `/ward/login?next=…`. Signing in fixes it.
 * - **403** — a perfectly live Ward session held by somebody with **no atrium
 *   grant**. Signing in again changes nothing; a superuser has to issue a
 *   grant. This is the estate's actual security boundary, and it is why holding
 *   a Ward account confers nothing on its own.
 * - **503** — Ward could not be reached, or rejected atrium's own app key. The
 *   request **fails closed**. This is never reported as "signed out", because
 *   telling somebody to sign in when the identity service is down sends them
 *   into a login page that also cannot work.
 *
 * ## Profiles are unchanged, and still not a security boundary
 *
 * D35 stands: a profile is an identity boundary inside one account, switching
 * between them needs no password, and Ward does not know they exist. The only
 * change is the column the account half is keyed on — `profiles.subject`
 * instead of `profiles.user_id`. A missing or stale active profile is still
 * never an auth failure.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** The Ward session — subject, username, grant map, and the device `sid`. */
    ward?: WardCaller;
    /**
     * The active profile. Always set alongside `ward`, so a handler holding one
     * holds the other.
     */
    authProfile?: ProfileRow;
    /**
     * Whether every atrium role this caller holds is `jukebox` (D55). Such a
     * caller only reaches the Jukebox and `audio` files and covers. False on
     * allowlisted requests, which have no caller at all.
     */
    jukeboxOnly: boolean;
  }
}

/** The one atrium role atrium reads (D55): the Discord bot's account holds it. */
export const JUKEBOX_ROLE = "jukebox";

/**
 * Jukebox-only means the roles are not empty and every one is `jukebox`. An
 * account holding `jukebox` beside any other role keeps full access, so
 * granting the role to the owner's own account can never lock them out.
 */
function isJukeboxOnly(roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((role) => role === JUKEBOX_ROLE);
}

/** The library routes a jukebox-only caller may `GET`, by route pattern. */
const JUKEBOX_LIBRARY_ROUTES = new Set(["/library/:id/file", "/library/:id/cover"]);

/**
 * The jukebox-only allowlist (D55, brief 80): `/jukebox/*` and an item's file
 * and cover. The handlers of those two then refuse anything that isn't `audio`.
 *
 * It matches the **route pattern** Fastify resolved, never the raw URL, so a
 * query string or a percent-encoding cannot reach a handler
 * the pattern would not. The single raw-URL test is for a request that matched
 * no route: no handler runs for it either way, and letting a `/jukebox/` path
 * through means the bot reads an unbuilt endpoint as a 404 rather than as a
 * permissions fault. Every other unmatched path is a 403.
 */
function jukeboxMayReach(request: FastifyRequest): boolean {
  const pattern = request.routeOptions.url;
  if (pattern === undefined) return request.url.startsWith("/jukebox/");
  if (pattern.startsWith("/jukebox/")) return true;
  return request.method === "GET" && JUKEBOX_LIBRARY_ROUTES.has(pattern);
}

/**
 * Routes reachable with no session at all.
 *
 * Shorter than it was: `/auth/login` and `/auth/status` are gone with the auth
 * module, because atrium no longer has a login of its own to offer. Health
 * stays (a liveness probe is not a person) and `OPTIONS` stays (a CORS
 * preflight carries no cookies by definition, so gating it would break every
 * cross-origin request before the real one was ever sent).
 */
function isAllowlisted(request: FastifyRequest): boolean {
  if (request.method === "OPTIONS") return true;
  const path = request.url.split("?", 1)[0];
  return request.method === "GET" && path === "/health";
}

export interface WardGuardOptions {
  /** Injected by tests; production builds one from the environment. */
  client?: WardClient;
}

/** The process-wide client, built once — it owns both caches. */
let shared: WardClient | undefined;

function defaultClient(): WardClient {
  shared ??= createWardClient({
    publicOrigin: WARD_PUBLIC_ORIGIN,
    apiBasePath: WARD_API_BASE_PATH,
    appKey: WARD_APP_KEY,
  });
  return shared;
}

/** Test seam: the client holds caches, so a suite must be able to drop them. */
export function resetWardClientForTests(): void {
  shared = undefined;
}

export function registerWardGuard(app: FastifyInstance, options: WardGuardOptions = {}): void {
  const ward = options.client ?? defaultClient();

  app.decorateRequest("jukeboxOnly", false);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isAllowlisted(request)) return;

    let session: WardCaller;
    try {
      session = await ward.authenticate(request.headers.cookie);
    } catch (error) {
      // Ordered most specific first. `WardConfigurationError` extends
      // `WardUnavailableError`, so the 503 branch catches both — which is the
      // point of that subclassing: atrium needs no branch to fail closed.
      if (error instanceof WardUnavailableError) {
        request.log.error({ err: error }, "ward is not answering; failing closed");
        return reply.status(503).send({ error: "IDENTITY_UNAVAILABLE" });
      }
      if (error instanceof WardAuthenticationError) {
        return reply.status(401).send({ error: "UNAUTHORIZED" });
      }
      throw error;
    }

    /**
     * The grant check, and the reason this is not just authentication.
     *
     * Any role at all is enough to open atrium, with one exception below.
     * Inventing a role hierarchy atrium does not use would be a second,
     * unenforced, definition of authority. What matters is that a Ward account
     * with **no** atrium grant is refused, which is exactly what lets prm keep
     * public self-registration without opening this app to the people who use
     * it.
     *
     * The exception is `jukebox` (D55), the Discord bot's role. The library has
     * no owners and `DELETE /library/:id` checks nothing, so a leaked bot
     * password must not carry full access. A jukebox-only caller is refused
     * here, on every route outside its allowlist, before a profile is touched.
     */
    const roles = session.grants[ATRIUM_APP_SLUG] ?? [];
    if (roles.length === 0) {
      request.log.warn({ subject: session.subject }, "live ward session with no atrium grant");
      return reply.status(403).send({ error: "NO_ATRIUM_GRANT" });
    }
    const jukeboxOnly = isJukeboxOnly(roles);
    if (jukeboxOnly && !jukeboxMayReach(request)) {
      return reply.status(403).send({ error: "JUKEBOX_ROLE_FORBIDDEN" });
    }

    /**
     * A missing or stale active profile is NEVER an auth failure (D35). The
     * FK is `ON DELETE SET NULL`, so losing a profile must not sign a device
     * out. The ownership re-check is belt-and-braces: only the activate route
     * writes that column and it verifies ownership, but a profile id is the one
     * value here that ever came from a client.
     */
    /**
     * The first request from a newly-granted account creates its profile.
     *
     * This is where the old boot sweep went. Atrium is never told that a
     * superuser issued an `atrium` grant in Ward's console, so the first
     * request after that grant is the only event it can observe — and arriving
     * with no profile is precisely what a brand-new account looks like. One
     * indexed count on the ordinary path; an insert exactly once per account.
     */
    await ensureDefaultProfile(session.subject);

    const selected = await getSelectedProfileId(session.subject, session.sid);
    const active = selected ? await getProfile(selected) : undefined;
    const profile =
      active && active.subject === session.subject
        ? active
        : await getDefaultProfile(session.subject);

    if (!profile) {
      // Unreachable in practice — `ensureDefaultProfile` ran three lines up.
      // If it happens, every profile-scoped route below would silently read or
      // write nothing, so fail loudly rather than serve an empty library as if
      // it were the truth.
      request.log.error({ subject: session.subject }, "account has no profile");
      return reply.status(500).send({ error: "NO_PROFILE" });
    }

    request.ward = session;
    request.authProfile = profile;
    request.jukeboxOnly = jukeboxOnly;
  });
}

/** Whether the caller holds a specific atrium role. For routes that need one. */
export function requireAtriumRole(request: FastifyRequest, role: string): void {
  if (request.ward === undefined) {
    throw new WardAuthenticationError("no ward session on this request");
  }
  if (!hasGrant(request.ward.grants, ATRIUM_APP_SLUG, role)) {
    throw new WardForbiddenError(`this account does not hold atrium:${role}`);
  }
}
