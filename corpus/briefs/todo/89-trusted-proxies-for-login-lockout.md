# Task 89: Set `AUTH_TRUSTED_PROXIES` wherever atrium runs behind a proxy

## Context

`apps/api/src/modules/auth/auth.guard.ts:127-146` registers the vendored Ward library without
`trustedProxies`; the library falls back to `AUTH_TRUSTED_PROXIES` (`vendor/ward/ward-auth.js`
around 5159). `.env.example` has no line for it; only `docs/getting-started.md:57` and a comment in
`infrastructure/docker-compose.yml:6` mention it. Behind the container the socket peer is the Docker
bridge, so with the variable unset every client shares one login counter: six wrong passwords from
anyone on the internet lock the owner, every household member and the Discord bot out of password
sign-in for 15 minutes, as often as they like. Reproduced on `buildApp()` with peer 172.18.0.1;
with `AUTH_TRUSTED_PROXIES=172.16.0.0/12` the owner's sign-in succeeds. A client cannot spoof its
way round the lockout (untrusted peers' X-Forwarded-For is ignored). The accounts rework (18e9c2e)
is not deployed yet.

Improvement sweep of 2026-10-20 (auth lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `.env.example`
- `docs/getting-started.md`
- `infrastructure/docker-compose.yml` (comments)
- the API's boot code (a warning)
- `apps/api/test/` (a lockout test)

## Files you must NOT touch

- `apps/api/vendor/ward/*` (never edited, D58)

## What to do

1. Add `AUTH_TRUSTED_PROXIES` to `.env.example` with the bridge range used in production and a comment.
2. Log a warning at boot when it is unset in production.
3. Add a test: with trusted proxies set, two clients with different X-Forwarded-For have separate counters.
4. Owner step, outside the repo: set it in vps-deploy's env before deploying 18e9c2e.

## Acceptance

- The test passes.
- .env.example lists the variable.
- Boot warns when it is missing in production.
