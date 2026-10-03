# Task 65 — Atrium can be run and signed into locally again

**Filed 2026-09-25** by the improvements sweep. **Needs a decision first:** this
revisits D14.

## Context

Since the Ward move (D53, 2026-09-06), no local development path exists. The
cutover's own log entry says nothing has run in a browser since. A fresh clone,
even with every other brief applied, fails like this:

1. **The browser rejects every API response in dev.** The web client sends
   `credentials: "include"`
   ([`api-client.ts:106`](../../../apps/web/src/lib/api-client.ts)). Its comment
   claims that is what makes dev requests carry the cookie. But the API registers
   CORS with `origin: true` and **no `credentials: true`**
   ([`app.ts:41-44`](../../../apps/api/src/app.ts)), and `@fastify/cors`
   defaults it to `false`. With no `Access-Control-Allow-Credentials` on the
   response, the browser refuses every credentialed cross-origin response from
   `:3001` to `:5173`.
2. **There is no session to send anyway.** `ward_session` is set by Ward on the
   shared origin. Nothing in this repository runs Ward, and `.env.example`
   carries production values only (`WARD_PUBLIC_ORIGIN=https://gandolh.ro`).
3. **The login redirect goes nowhere.** `wardLoginUrl()` returns the relative
   `/ward/login?next=/atrium/`
   ([`ward.ts:150-163`](../../../apps/web/src/lib/ward.ts)). In dev that is the
   Vite server, where no Ward lives.

**The estate already solved this once.** Ward's own UI proxies `/ward-api` in
development "so the browser sees one origin, exactly as it will in production
behind Caddy. Without this the cookies would be cross-site in dev and same-site
in prod — and `SameSite=Lax` behaves differently across that line"
(`wzd_auth/ui/vite.config.ts:18-32`). Ward's cookie is `HttpOnly; SameSite=Lax`
unconditionally (`wzd_auth/api/src/auth/cookie.ts`). That attribute is also
atrium's **entire** CSRF defence: the sweep checked, and atrium has no token and
no Origin check.

**The D14 conflict.** D14 chose "CORS + `VITE_API_URL` (no Vite proxy)" for an
"explicit base URL, deploy-ready". That reason predates D53. Production is now
one origin, and cookie auth makes cross-origin dev diverge from it in exactly the
way Ward's comment describes.

## Decision required before building

Ask the owner. Record the answer as a D14 revision in
[decisions.md](../../wiki/decisions.md), with a [log](../../log.md) note.

- **A (recommended): one origin in dev, like production.**
  - The Vite dev server proxies `/atrium-api` to the API (stripping the prefix, as
    Caddy's `handle_path` does), and `/ward-api` plus `/ward` to a locally running
    Ward.
  - `VITE_API_URL` points at the dev server's own `/atrium-api`.
  - CORS stops mattering in dev.
  - This revises D14.
- **B: keep D14.**
  - Allow credentials for an **explicit allowlist** of dev origins
    (`CORS_ORIGINS`).
  - Make the Ward login origin configurable (`VITE_WARD_ORIGIN`).
  - Run Ward on its own port. Cookies ignore ports, so a `localhost` Ward cookie
    reaches `:3001`.
  - Dev stays cross-origin, unlike production.
- **Rejected in advance: a dev-only auth bypass** (e.g. `WARD_DEV_SUBJECT`). It is
  a switch that turns authentication off, and one mis-set variable ships it.

Under **either** option, never combine `origin: true` with `credentials: true`. A
reflected origin plus credentials is only safe while Ward's cookie stays `Lax`,
and atrium does not control that.

## Scope

**In:** the dev topology (option A or B), the login redirect in dev, and a
written runbook for running atrium against a local Ward:
- starting Ward;
- registering an `atrium` app and issuing its service key;
- granting yourself access;
- which `WARD_*` values to use.

**Out:** Ward's own code; production Caddy; the guard's 401/403/503 semantics
(D53).

## Files you OWN

- `apps/web/vite.config.ts`: the dev proxy (option A)
- `apps/web/src/lib/ward.ts` and `apps/web/src/lib/api-client.ts`: the login
  origin and the stale comment
- `apps/api/src/app.ts`: CORS, restricted to an explicit allowlist, or dev-only
- `.env.example` and `README.md`: the dev section and runbook
- `corpus/wiki/decisions.md` and `corpus/log.md`: the D14 revision, once decided

## Files you must NOT touch

- `apps/api/src/modules/ward/**`: no bypass, no dev branch in the guard.
- The `wzd_auth` repository. If running Ward locally needs a change there, name
  it in the outcome.

## What to do

1. **Get the decision.** Write it down.
2. **Implement the chosen topology**, keeping the production build unchanged: the
   deployed bundle's `VITE_API_URL` and the relative login URL must be
   byte-identical to today's.
3. **Write the runbook** so a fresh clone can sign in locally, and run it once on a
   clean checkout.
4. **Correct `api-client.ts`'s comment.** `credentials: "include"` is necessary
   but not sufficient.

## Acceptance

- Following only the runbook on a fresh clone, a developer reaches the library
  in a browser, signed in through a local Ward.
- A 403 (no grant) shows the no-grant screen, and stopping local Ward shows the
  unavailable state, not a login loop.
- Production unchanged: `npm run build -w @ebook-reader/web` with production env
  produces the same API base URL and the same login path as before.
- CORS no longer reflects arbitrary origins, in production or in dev.
- Typecheck and build are clean, and the storage roots are set inline to a scratch
  base for every local run.

## Outcome (2026-10-03)

Done. The two halves landed separately.

**2026-09-27 (`bc9060d`, D54).** The owner chose option A for every Ward app.
- The web dev server serves `/atrium/` and proxies `/atrium-api` (prefix stripped), plus `/ward` and `/ward-api` to the local Ward container.
- The README has the runbook, and `.env.example` the local values.
- That run was verified in a headless browser against the local Ward: sign-in, the no-grant screen, a 503 with Ward stopped, and a production build unchanged. The log entry has the details.

**2026-10-03, CORS.** CORS was still `origin: true`.
- The registration is removed. Since D54 nothing calls the API cross-origin, so the empty allowlist is the honest one.
- The comment in `app.ts` says why, including what `credentials: true` plus a reflected origin would have exposed.
- `@fastify/cors` is uninstalled from `apps/api`.
- `test/cors.test.ts`:
  - a signed-in `GET /library` with `Origin: https://evil.example` carries no `Access-Control-*` header;
  - a PATCH preflight from there is not granted.
  - Both fail on the old `app.ts`.
- 61 API tests pass, and typecheck is clean for api and web.
- Stale comments are corrected:
  - `api-client.ts`;
  - `vite.config.ts`'s cover cache, which now notes brief 62's `?v=`;
  - `architecture.md`'s backend stack and wiring.

The web bundle's runtime code is untouched by this half, so the production build check from 2026-09-27 stands.

**Not done here: the Ward-down screen.** With Ward stopped the page sits on "Loading…" instead of saying sign-in is unavailable. The API half is brief 61, done. The web half lives in `lib/auth.ts` and `AuthGate.tsx`, outside this brief's files, and needs a choice: an outage must not block offline reading. Filed as [brief 77](../todo/77-ward-down-shows-unavailable-not-loading.md).

The local Ward could not be re-run today, because Docker is unavailable on this machine.
