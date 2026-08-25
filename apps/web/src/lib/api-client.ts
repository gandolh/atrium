/**
 * Base API client. Reads `VITE_API_URL` (decisions.md D14 — explicit CORS
 * base URL, no Vite proxy). Falls back to the local Fastify dev port.
 *
 * This is plumbing only: the `POST /convert` call (with TanStack Query's
 * `useMutation`) lands in brief 05. `apiFetch` is the shared low-level
 * wrapper future calls build on.
 *
 * Auth (brief 09): this module owns the in-memory bearer token and a single
 * "unauthorized" callback, rather than importing `./auth` directly — `auth.ts`
 * imports `apiFetch` from here, so importing it back would be circular.
 * `auth.ts` calls `setAuthToken`/`setOnUnauthorized` to wire itself up.
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

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** Set (or clear, with `null`) the bearer token attached to every `apiFetch` call. */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** Current in-memory token, if any (used by `coverUrl` for `<img>` tags that can't send headers). */
export function getAuthToken(): string | null {
  return authToken;
}

/** Registers the callback fired when any (non-exempt) call gets a 401 — see `skipAuthRedirect`. */
export function setOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

/**
 * Thin fetch wrapper against `API_BASE_URL`. Joins `path` onto the base,
 * attaches `Authorization: Bearer <token>` when one is set, and throws
 * `ApiError` on non-2xx responses.
 *
 * `skipAuthRedirect` opts a call out of the global 401 handler — used only by
 * `POST /auth/login`, where a 401 is the expected "wrong password" signal, not
 * a stale/invalid token that should re-lock the app.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
  options?: { skipAuthRedirect?: boolean },
): Promise<Response> {
  const url = apiUrl(path);
  const headers = new Headers(init?.headers);
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    if (response.status === 401 && !options?.skipAuthRedirect) {
      onUnauthorized?.();
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
