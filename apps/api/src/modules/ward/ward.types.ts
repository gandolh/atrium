/**
 * Ward's wire contract, as atrium consumes it.
 *
 * ## Why atrium hand-writes a Ward client at all
 *
 * Ward ships a tested `@ward/client` package, and atrium deliberately does not
 * depend on it. The estate's apps are separate checkouts that `vps-deploy`
 * rsyncs and `npm ci`s independently, so there is no build in which a workspace
 * package from another repo resolves — every mechanism that would make one
 * resolve (a registry, a committed tarball, a git dependency) costs more in
 * build machinery and deploy credentials than the ~200 lines it saves.
 *
 * The cost is that this is security code, written five times across the estate.
 * The mitigation is that `wzd_auth/corpus/wiki/integrating.md` is the contract
 * all five are written against, and `wzd_auth/client/` remains the tested
 * reference implementation these files were adapted from. **Change the contract
 * there before changing behaviour here.**
 *
 * ## The five things this module must get right
 *
 * They are listed in that page and each is implemented with a comment naming
 * it: pin the algorithm, send the base path, send the app key, cache for 30
 * seconds, and fail closed.
 */

/** The `alg` every Ward access token is signed with. Pinned, never derived. */
export const ACCESS_TOKEN_ALG = "EdDSA" as const;

/** The `aud` claim Ward puts on every access token — one estate-wide value. */
export const ACCESS_TOKEN_AUDIENCE = "ward-estate";

/**
 * Clock-skew allowance, seconds. Kept tight: atrium runs on the same box as
 * Ward, so real skew is zero, and a generous tolerance quietly extends the life
 * of every token in the estate.
 */
export const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS = 5;

/**
 * The introspection cache window: **30 seconds**.
 *
 * This is the number the whole revocation design rests on. It is exactly how
 * long a revoked session stays usable inside atrium, and it must not be raised
 * in production to save a round trip — the round trip is the feature.
 */
export const INTROSPECTION_CACHE_TTL_MS = 30_000;

/** Ward's app-key header. The value is `WARD_APP_KEY`, a server-side secret. */
export const APP_KEY_HEADER = "x-ward-app-key";

/** Atrium's slug in Ward's `apps` table, and the key into a grant map. */
export const ATRIUM_APP_SLUG = "atrium";

/**
 * The verified claim set.
 *
 * **No roles and no permissions**, and that is Ward's rule rather than an
 * omission here: a token minted before a grant changed would carry stale
 * authority for its whole 15 minutes. Authority comes from introspection, on
 * every request, inside the 30-second window.
 */
export interface AccessTokenClaims {
  /** Stable, opaque, never recycled. The join key for atrium's own rows. */
  sub: string;
  jti: string;
  /** The refresh family — what makes revocation per-session rather than per-account. */
  sid: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string | string[];
}

/**
 * Every role an account holds, keyed by app slug — **the whole estate's**, not
 * just atrium's. Ward authenticates the caller without scoping the answer.
 *
 * An app absent from the map means no access to that app at all. Roles are an
 * opaque set: test membership, never equality.
 */
export type GrantsByApp = Record<string, string[]>;

export interface ActiveSession {
  readonly active: true;
  readonly subject: string;
  readonly username: string;
  readonly grants: GrantsByApp;
}

/**
 * Not live — and that is the entire answer. Expired, revoked, disabled,
 * unknown, and a console token all produce this identical shape. Ward never
 * says which, and atrium must not guess.
 */
export interface InactiveSession {
  readonly active: false;
}

export type SessionResolution = ActiveSession | InactiveSession;

/**
 * An authenticated caller: the introspected session, plus the `sid` claim from
 * the token that carried it.
 *
 * `sid` is here because atrium needs a **per-device** key and no longer has a
 * sessions table to provide one. It names the refresh family the token was
 * minted under — one browser, one sign-in — so keying the active profile on
 * `(subject, sid)` reproduces exactly the old behaviour, where switching
 * profiles on the laptop did not switch them on the phone (D35).
 *
 * It comes from the *verified* token rather than from introspection, because
 * introspection deliberately answers identity and authority and nothing about
 * which token asked.
 */
export interface WardCaller extends ActiveSession {
  readonly sid: string;
}

/** Whether `grants` includes `role` for `app`. Always this, never equality. */
export function hasGrant(grants: GrantsByApp, app: string, role: string): boolean {
  return grants[app]?.includes(role) ?? false;
}

/**
 * The token is not usable: absent, malformed, expired, forged, or belonging to
 * a session Ward says is not live. An ordinary 401.
 */
export class WardAuthenticationError extends Error {
  override readonly name: string = "WardAuthenticationError";
  readonly statusCode = 401;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * A live session that may not use atrium. A **403**, and distinct from the 401
 * above on purpose: signing in again will not help, because the account is
 * genuinely signed in and simply holds no atrium grant.
 */
export class WardForbiddenError extends Error {
  override readonly name: string = "WardForbiddenError";
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
  }
}

/**
 * Ward could not answer, so atrium does not know — and **must not guess**.
 *
 * Every call site that can throw this fails the request closed. Ward being
 * unreachable already means nobody can sign in; it must not additionally mean
 * revocation silently stops working because a caller treated "I don't know" as
 * "yes". A `500` from Ward is treated identically to a socket error: Ward's own
 * contract is "always 200", so anything else means Ward is broken, never that
 * the session died.
 */
export class WardUnavailableError extends Error {
  override readonly name: string = "WardUnavailableError";
  readonly statusCode = 503;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Ward rejected **atrium's own key** with a `401`.
 *
 * A subclass of `WardUnavailableError`, deliberately: the fail-closed handling
 * that already catches that class is exactly right here, so this adds
 * information without needing a new branch anywhere.
 *
 * What it adds is diagnosability. Every other introspection failure is
 * transient and about Ward — a timeout, a restart. This one is permanent and
 * about *atrium's deployment*: `WARD_APP_KEY` is absent, wrong, or has been
 * revoked in Ward's console, and no amount of waiting will fix it. Reading
 * "unexpected status 401" in a log at 3am and having to work out that Ward is
 * fine and your own config is broken is the bad half hour this class prevents.
 */
export class WardConfigurationError extends WardUnavailableError {
  override readonly name: string = "WardConfigurationError";
}
