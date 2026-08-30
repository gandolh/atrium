# Task 09 — Gate the platform behind a shared password

## Context

From `todos/add-platform-password.md`.
Single shared password for the whole platform — no per-user accounts (D2
stands: this is a credential, not an account system). Design locked with the
user (2026-07-07): **API-enforced** (the deployment is public; a UI-only gate
would leave the library open) and **remembered per device** (localStorage —
unlock once per browser).

Key code facts:
- Web talks to the API cross-origin via `apiFetch`
  (`apps/web/src/lib/api-client.ts`, base = `VITE_API_URL`, D14) — one seam to
  attach a credential to every call.
- Cover thumbnails are plain `<img src={coverUrl(id)}>` — an img can't send an
  `Authorization` header, so the guard must also accept a `?token=` query param.
- API routes register in `apps/api/src/index.ts` (`/health`, convert, library);
  env config pattern lives in `apps/api/src/config.ts`; missing-Calibre startup
  warning is the precedent for "misconfigured but not fatal".

## Design (settled — do not relitigate)

- **Password source:** `APP_PASSWORD` env var on the API. Unset/empty →
  **auth disabled**, loud multi-line startup warning (Calibre-warning style).
  This keeps `npm run dev` frictionless.
- **Token scheme (stateless):** `token = SHA-256(APP_PASSWORD) as hex`,
  computed server-side. `POST /auth/login { password }` → constant-time compare
  (`crypto.timingSafeEqual` on hashes) → `200 { token }` or `401`. No sessions,
  no expiry; changing the password invalidates all devices.
- **Guard:** Fastify `onRequest` hook, registered before the routes: every
  request needs `Authorization: Bearer <token>` **or** `?token=<token>`
  (constant-time compare), except `POST /auth/login`, `GET /health`, and CORS
  preflights (`OPTIONS`). Failure → `401 { error: "UNAUTHORIZED" }`.
- **Frontend:** token in `localStorage` (`ebook-reader.token`). `apiFetch`
  attaches the header; `coverUrl` appends `?token=`. A full-screen lock screen
  (Quiet Paper styled, see wiki/design.md) renders instead of the app when the
  API says auth is required and no valid token is held; any 401 from `apiFetch`
  clears the token and re-locks. `GET /auth/status` → `{ required: boolean }`
  lets the frontend skip the lock screen entirely when auth is disabled (dev).

## Files you OWN

- `packages/shared/src/auth.ts` (new) + `packages/shared/src/index.ts` (export)
- `apps/api/src/auth.ts` (new: guard hook + login/status routes)
- `apps/api/src/config.ts` (add `APP_PASSWORD`)
- `apps/api/src/index.ts` (register guard + routes, startup warning)
- `apps/web/src/lib/api-client.ts` (attach token, 401 handling)
- `apps/web/src/lib/library-api.ts` (`coverUrl` token param)
- `apps/web/src/lib/auth.ts` / `apps/web/src/auth/LockScreen.tsx` (new)
- `apps/web/src/main.tsx` or `apps/web/src/routes/root-layout.tsx` (mount gate)

## Files you must NOT touch

- `apps/api/src/db.ts`, `extract.ts`, `library-routes.ts`, `convert-route.ts`
  (the guard is a hook — routes stay auth-unaware)
- Reader code (`apps/web/src/reader/**`)

## What to do

1. **Shared contract** (`packages/shared`): `loginRequestSchema`
   (`{ password: string (min 1) }`), `loginResponseSchema` (`{ token: string }`),
   `authStatusSchema` (`{ required: boolean }`). Export types.
2. **API**: `APP_PASSWORD` in config; `auth.ts` with the token derivation, the
   `onRequest` guard (allowlist: `/auth/login`, `/health`, `OPTIONS`), and the
   `POST /auth/login` + `GET /auth/status` routes; wire into `index.ts` with the
   startup warning when unset. Auth disabled → guard passes everything through
   and `/auth/status` reports `required: false`.
3. **Web**: token storage helpers; `apiFetch` sends `Authorization` when a token
   exists and maps 401 → clear token + notify the gate; `coverUrl(id)` appends
   `?token=`; `LockScreen` (centered card, Playfair heading, password input +
   error state per design.md tokens); gate component queries `/auth/status`
   once, shows the lock screen when `required && !token`, re-locks on any 401.

## Acceptance

- With `APP_PASSWORD` set: every library/convert/file/cover request without the
  token 401s (verify with curl); the web app shows the lock screen first; the
  right password unlocks and the library loads (covers included); a wrong
  password shows an inline error; refresh stays unlocked (localStorage); wiping
  the token or a server password change re-locks on next request.
- With `APP_PASSWORD` unset: startup warning, no lock screen, everything works
  as today.
- `npm run typecheck` clean; lock screen passes the design.md conformance
  checklist (theme tokens only, type roles, spacing/radii).

---

**Outcome (2026-07-07):** Shipped as specced, via plan-split-dispatch (shared
contract → haiku; API guard → opus; web gate → sonnet; 2 sonnet review finders
+ 1 sonnet fix pass). Review found and fixed three things beyond the spec:
`?token=` redacted from request logs (pino req serializer), duplicate
`?token=a&token=b` handled as 401 instead of crashing the guard into a 500,
and React Query no longer retries 401s. Accepted as-is (noted, not fixed):
brief app-shell flash when a stale token is later 401'd (self-healing),
no cross-tab token sync (single-user), `<img>` cover 401s don't re-lock on
their own (a co-occurring data 401 does). Verified end-to-end headless:
10/10 checks with auth on (401 without token, lock screen, wrong/right
password, covers via `?token=`, refresh persistence, authed book open,
bogus-token re-lock) and disabled mode clean. Gate mounted in
`root-layout.tsx`. Decision recorded as D28 (revises D2).
