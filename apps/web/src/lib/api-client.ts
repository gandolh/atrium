/**
 * Base API client. Reads `VITE_API_URL`: the estate's `/atrium-api` in the
 * deploy, and the web dev server's own `/atrium-api` in development, which Vite
 * proxies to the API (decisions.md D54, revising D14). Either way the page and
 * the API share an origin.
 *
 * This is plumbing only: the `POST /convert` call (with TanStack Query's
 * `useMutation`) lands in brief 05. `apiFetch` is the shared low-level
 * wrapper future calls build on.
 *
 * ## This module carries no token
 *
 * Atrium's session is the `atrium_session` cookie (D58), `HttpOnly` and scoped
 * to the API prefix (`Path=/atrium-api`). Every URL built by `apiUrl()` below
 * lives under that prefix, so the browser attaches the cookie to every API
 * request without this module doing anything, `<img>` tags for cover art and
 * `<audio>`/`<video>` sources included. A URL built any other way might
 * fall outside the prefix and arrive without the cookie.
 *
 * What survives is the single "unauthorized" callback, for the same
 * circular-import reason as before: `auth.ts` imports `apiFetch` from here, so
 * this file must not import it back.
 *
 * ## `credentials: "include"` is necessary, not sufficient
 *
 * What actually gets the cookie to the API is the shared origin: `fetch` sends
 * cookies on a same-origin request by default. The flag only matters if
 * `VITE_API_URL` ever points at another origin, and there it is not enough on
 * its own. The browser also wants `Access-Control-Allow-Credentials` from the
 * API, and atrium sends no CORS headers at all (brief 65), so it refuses every
 * response. That is why development proxies the API instead of going
 * cross-origin (D54).
 */

// Required — `vite.config.ts` throws at startup if VITE_API_URL is unset, so
// there is no silent localhost fallback here (see .env.example).
export const API_BASE_URL: string = import.meta.env.VITE_API_URL;

/**
 * Join an API path onto `API_BASE_URL`, PRESERVING any path prefix on the base
 * (e.g. a reverse-proxy prefix like `http://host/atrium-api`). The obvious
 * `new URL(path, base)` is wrong here: a leading-slash path resolves against
 * the origin and silently drops the base's path segment. `path` must start
 * with "/". Every API URL in the app must be built through this.
 */
export function apiUrl(path: string): URL {
  return new URL(API_BASE_URL.replace(/\/+$/, "") + path);
}

export class ApiError extends Error {
  readonly status: number;
  /**
   * The failed response's parsed JSON body, when it had one — e.g. the
   * profile routes' `{ error: "PROFILE_HAS_NOTES", noteCount: 2 }` (brief 35).
   * Undefined for a non-JSON or empty body (a 204, a proxy's HTML error page,
   * etc.); callers must not assume it's present, only that when it IS, its
   * shape matches whatever that endpoint documents for that status.
   */
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

let onUnauthorized: (() => void) | null = null;
let onForbidden: (() => void) | null = null;

/** Registers the callback fired when a call gets a 401: the login page goes up. */
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

/**
 * Registers the callback fired on a **403**.
 *
 * Kept separate from the 401 handler, and that separation is the point: a 403
 * from atrium means a live session whose role may not do this (the Discord
 * bot's `jukebox` account, D55). Signing in again changes nothing, so they need
 * to be told that, not shown the login page.
 */
export function setOnForbidden(handler: () => void): void {
  onForbidden = handler;
}

/**
 * Thin fetch wrapper against `API_BASE_URL`. Joins `path` onto the base, sends
 * the session cookie, and throws `ApiError` on non-2xx responses.
 *
 * `skipAuthRedirect` opts a call out of the global 401 handler. Nothing uses it:
 * the sign-in routes go through the library's own client (`auth/client.ts`),
 * where a 401 means "wrong password" rather than "stale session". It is kept
 * because the distinction it encodes is real.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
  options?: { skipAuthRedirect?: boolean },
): Promise<Response> {
  const url = apiUrl(path);
  const headers = new Headers(init?.headers);

  // See the header: without this, cookies are dropped on the cross-origin dev
  // request and every call 401s in development while production works.
  const response = await fetch(url, { ...init, headers, credentials: "include" });

  if (!response.ok) {
    if (response.status === 401 && !options?.skipAuthRedirect) {
      onUnauthorized?.();
    }
    if (response.status === 403) {
      onForbidden?.();
    }
    // Best-effort: most error responses in this app are JSON (`{error, ...}`),
    // but a 204 has no body and a reverse proxy can hand back an HTML error
    // page, so a failed parse just leaves `body` undefined rather than
    // throwing a second, more confusing error out of the error path itself.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    throw new ApiError(
      `Request to ${path} failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }

  return response;
}
