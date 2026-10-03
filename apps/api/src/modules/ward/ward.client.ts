import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import {
  ACCESS_TOKEN_ALG,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
  APP_KEY_HEADER,
  INTROSPECTION_CACHE_TTL_MS,
  WardAuthenticationError,
  WardConfigurationError,
  WardUnavailableError,
  type AccessTokenClaims,
  type SessionResolution,
  type WardCaller,
} from "./ward.types.js";

/**
 * Atrium's Ward client: verify a token locally, then ask Ward whether the
 * session is live and what it may do, caching that answer for 30 seconds.
 *
 * Adapted from `wzd_auth/client/src/{verify,introspect,client,cookie}.ts`. See
 * `ward.types.ts` on why atrium hand-writes this rather than importing it.
 *
 * ## Two caches, answering different questions
 *
 * They are separate and must not be conflated — the mistake is easy and the
 * consequences are opposite:
 *
 * - The **JWKS cache** (10 minutes) is about not re-fetching a public-key
 *   document that changes maybe once a quarter. It establishes *authenticity*
 *   and says nothing about liveness. Raising it does not slow revocation down.
 * - The **introspection cache** (30 seconds) is about liveness and authority.
 *   Lowering it does not make a key rotation land faster.
 *
 * ## Cookie, not Authorization
 *
 * Ward's access token arrives in the `ward_session` cookie at `Path=/`, which
 * the browser sends to atrium automatically because Ward and atrium share one
 * origin. That is the concrete payoff of the one-origin decision, and it is why
 * atrium was able to delete its `?token=` query-string fallback: an `<img>` tag
 * cannot send an `Authorization` header, but it sends cookies without being
 * asked.
 */

export interface WardClientOptions {
  /** Ward's public origin, bare, no trailing slash. Also the expected `iss`. */
  publicOrigin: string;
  /**
   * Ward's base path behind Caddy — `/ward-api` in this estate.
   *
   * **No default, deliberately.** An earlier version of the reference client
   * defaulted this to `""`, which resolves to `<origin>/.well-known/jwks.json`
   * — a path nothing serves. Had it shipped, every app would have fetched a 404
   * for Ward's public key and rejected every token in the estate.
   */
  apiBasePath: string;
  /** Atrium's Ward service key. Required — Ward refuses an unkeyed call. */
  appKey: string;
  /** Injectable, so tests can point at a local server. */
  fetch?: typeof fetch;
  /** Test seam. Defaults to 30s; do not raise in production. */
  introspectionCacheTtlMs?: number;
  introspectTimeoutMs?: number;
  jwksTimeoutMs?: number;
  jwksCacheMaxAgeMs?: number;
  jwksCooldownMs?: number;
  now?: () => number;
}

export interface WardClient {
  /** Verify locally. Authentication only — says nothing about liveness. */
  verify(token: string): Promise<AccessTokenClaims>;
  /** Ask Ward for liveness and authority, cached per token for 30 seconds. */
  introspect(token: string): Promise<SessionResolution>;
  /** Read Ward's access token out of a raw `Cookie` header. */
  readAccessCookie(header: string | string[] | undefined): string | undefined;
  /** Cookie → verified → live, or throw. The guard's one call. */
  authenticate(cookieHeader: string | string[] | undefined): Promise<WardCaller>;
}

/**
 * Ward's access cookie name.
 *
 * Module-private on purpose: no route or handler in atrium should know this
 * string. If Ward ever renamed it, this line would be the only change.
 */
const ACCESS_COOKIE_NAME = "ward_session";

function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  const flat = Array.isArray(header) ? header.join("; ") : header;

  for (const pair of flat.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;

    const value = pair.slice(eq + 1).trim();
    // A cleared cookie the client presented anyway is absent, not an empty
    // token — otherwise every signed-out request becomes a verification error.
    return value.length > 0 ? value : undefined;
  }

  return undefined;
}

interface CacheEntry {
  result: SessionResolution;
  expiresAt: number;
}

export function createWardClient(options: WardClientOptions): WardClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.introspectionCacheTtlMs ?? INTROSPECTION_CACHE_TTL_MS;
  const introspectTimeoutMs = options.introspectTimeoutMs ?? 5_000;

  const base = options.apiBasePath.replace(/\/+$/, "");
  const jwksEndpoint = new URL(`${base}/.well-known/jwks.json`, options.publicOrigin);
  const introspectEndpoint = new URL(`${base}/introspect`, options.publicOrigin);

  const keyStore = createRemoteJWKSet(jwksEndpoint, {
    timeoutDuration: options.jwksTimeoutMs ?? 5_000,
    cacheMaxAge: options.jwksCacheMaxAgeMs ?? 10 * 60_000,
    // The floor that stops a burst of tokens signed by an unknown key from
    // becoming a stampede against Ward's JWKS endpoint. A rotation is still
    // picked up without a restart, just not within 30 seconds of the last
    // fetch.
    cooldownDuration: options.jwksCooldownMs ?? 30_000,
    // The same seam as introspection. Without it the key set used global
    // `fetch`, and no test could reach the key-fetch failure path at all.
    [customFetch]: fetchImpl,
  });

  /**
   * **A key set Ward cannot serve means Ward is unavailable, never "signed
   * out"** (D53's fail-closed rule, brief 61).
   *
   * `jose` re-fetches the key set on the request path once its cache is older
   * than `cacheMaxAge`, or is empty after a boot, and a failed refetch throws
   * with no stale-key fallback. `verify()` used to wrap that as an
   * authentication error, so ten minutes into a Ward outage (or right after
   * atrium booted while Ward was down, or when Ward was merely slow) the API
   * answered 401 and the web client sent a signed-in person to Ward's login
   * page: the loop D53 says must never be offered.
   *
   * Only two resolver errors describe the *token*: no key in the set matches
   * its `kid` (after jose's own cooldown-limited refetch), or several do.
   * Everything else (a timeout, a non-200 or non-JSON key set, an invalid set,
   * a fetch that threw) describes Ward. Classified by jose's error classes, not
   * messages.
   */
  const resolveKey: JWTVerifyGetKey = async (header, token) => {
    try {
      return await keyStore(header, token);
    } catch (cause) {
      if (cause instanceof errors.JWKSNoMatchingKey || cause instanceof errors.JWKSMultipleMatchingKeys) {
        throw cause;
      }
      throw new WardUnavailableError("jwks unavailable", { cause });
    }
  };

  /** Keyed per **token**, never per subject — see the header. */
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<SessionResolution>>();

  async function verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, resolveKey, {
        /**
         * **Pinned, as a literal, never read from the token's own header.**
         *
         * Without this, `jose` accepts whatever the resolved key supports —
         * the `alg`-confusion class: `alg: "none"`, and `alg: "HS256"` with the
         * *public* key's own bytes handed over as the HMAC secret. A public key
         * is by definition something an attacker already has.
         */
        algorithms: [ACCESS_TOKEN_ALG],
        issuer: options.publicOrigin,
        audience: ACCESS_TOKEN_AUDIENCE,
        clockTolerance: ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "jti", "sid", "iat", "exp", "iss", "aud"],
        typ: "JWT",
      });
      return payload as unknown as AccessTokenClaims;
    } catch (cause) {
      if (cause instanceof WardUnavailableError) throw cause;
      throw new WardAuthenticationError("access token is not valid", { cause });
    }
  }

  async function callWard(token: string): Promise<SessionResolution> {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), introspectTimeoutMs);
    try {
      try {
        response = await fetchImpl(introspectEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Atrium's own credential, distinct from the person's token in the
            // body. Ward checks it first and refuses before doing any work.
            [APP_KEY_HEADER]: options.appKey,
          },
          body: JSON.stringify({ accessToken: token }),
          signal: controller.signal,
        });
      } catch (cause) {
        throw new WardUnavailableError("introspection request failed", { cause });
      }
    } finally {
      clearTimeout(timer);
    }

    // The one status with a specific cause worth naming: Ward received the
    // request and rejected *atrium's* key. Retrying will not help.
    if (response.status === 401) {
      throw new WardConfigurationError(
        "Ward rejected atrium's app key (401). Check WARD_APP_KEY: it is absent, wrong, " +
          "or has been revoked in Ward's console.",
      );
    }

    // Ward's contract is "always 200". Anything else — a 500 included — means
    // Ward is broken, not that the session is dead.
    if (response.status !== 200) {
      throw new WardUnavailableError(`introspect returned unexpected status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new WardUnavailableError("introspect response was not valid JSON", { cause });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { active?: unknown }).active !== "boolean"
    ) {
      throw new WardUnavailableError("introspect response did not match Ward's contract");
    }

    const parsed = body as { active: boolean; subject?: unknown; username?: unknown; grants?: unknown };
    if (!parsed.active) return { active: false };

    if (typeof parsed.subject !== "string" || typeof parsed.username !== "string") {
      throw new WardUnavailableError("introspect was active but missing subject/username");
    }

    return {
      active: true,
      subject: parsed.subject,
      username: parsed.username,
      grants: (parsed.grants as Record<string, string[]>) ?? {},
    };
  }

  function introspect(token: string): Promise<SessionResolution> {
    const cached = cache.get(token);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.result);

    // Collapse concurrent callers onto one request. Atrium serves a reading UI
    // that fires many requests per page — covers, audio ranges, note saves —
    // and a cold token must not become a burst against Ward.
    const existing = inflight.get(token);
    if (existing) return existing;

    const pending = callWard(token)
      .then((result) => {
        cache.set(token, { result, expiresAt: now() + cacheTtlMs });
        return result;
      })
      .finally(() => {
        inflight.delete(token);
      });

    inflight.set(token, pending);
    return pending;
  }

  async function authenticate(
    cookieHeader: string | string[] | undefined,
  ): Promise<WardCaller> {
    const token = readCookie(cookieHeader, ACCESS_COOKIE_NAME);
    if (token === undefined) {
      throw new WardAuthenticationError("no access token presented");
    }

    // Local, no-network authentication first: a malformed, expired or forged
    // token is rejected before Ward is asked anything at all. The claims are
    // kept for `sid`, which is how atrium keys a per-device preference now that
    // it has no sessions table.
    const claims = await verify(token);

    // Liveness and authority. `WardUnavailableError` propagates unchanged —
    // that is the fail-closed path, and swallowing it into "not authenticated"
    // would let a caller mistake a broken Ward for an ordinary signed-out user.
    const session = await introspect(token);
    if (!session.active) {
      throw new WardAuthenticationError("session is not active");
    }

    return { ...session, sid: claims.sid };
  }

  return {
    verify,
    introspect,
    readAccessCookie: (header) => readCookie(header, ACCESS_COOKIE_NAME),
    authenticate,
  };
}
