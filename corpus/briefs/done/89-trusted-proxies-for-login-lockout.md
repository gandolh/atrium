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

## Outcome (2026-10-27)

**Done**, code in `9f2aec2`.

- [`.env.example`](../../../.env.example) lists `AUTH_TRUSTED_PROXIES=172.16.0.0/12`
  with a comment: why the container needs it, that a client cannot spoof past it,
  how to find the real subnet (`docker network inspect`), and the log line that
  means the range is wrong. The line is set, not commented: locally the web dev
  server proxies from loopback, which the library always trusts, so the value is
  harmless there and right in a container if the file is copied.
- **The value is Docker's default pool, not a verified production range.** The
  compose file defines no network of its own, so the project network gets a
  subnet from the daemon's default pools (172.17-172.31, then 192.168.0.0/16 in
  /20s once those run out). On a VPS with many compose projects the network can
  land in 192.168; the deploy should name the subnet it actually has.
- [`index.ts`](../../../apps/api/src/index.ts) warns at boot (`checkTrustedProxies`,
  next to the Calibre check) when `NODE_ENV=production`, which the image sets, and
  the variable is unset, empty or only commas and spaces; the library reads all
  three as an empty list. Not fatal.
- [`lockout.test.ts`](../../../apps/api/test/lockout.test.ts), with the variable set
  before the app is built and every request from the bridge peer 172.18.0.1: five
  wrong passwords from `203.0.113.5` lock that client (429, `Retry-After`), and the
  owner from `198.51.100.7` still signs in (200); a request that prepends the
  owner's address to the locked one is still 429; a peer outside the range
  (`192.0.2.44`) is keyed on itself whatever it forwards.
- [`getting-started.md`](../../../docs/getting-started.md): the table row gives the
  value and says it is required behind a container proxy, and Common problems has
  "Everyone gets 429 on password sign-in, in a container".
  [`docker-compose.yml`](../../../infrastructure/docker-compose.yml)'s header comment
  says the same.

**Checked:**
- the new test passes (3 of 3), and with the variable deleted the first case fails
  with the owner refused (`actual: 429, expected: 200`), which is the sweep's
  repro;
- the built API booted with `NODE_ENV=production`, scratch storage roots and port
  3997: unset, it logged `WARNING: AUTH_TRUSTED_PROXIES is not set.` between the
  Calibre line and `Server listening`; with `172.16.0.0/12` it did not;
- `npm run typecheck` is clean and the API suite passes (116 of 116).

**Owner step, outside the repo:** set `AUTH_TRUSTED_PROXIES` in vps-deploy's env for
atrium before deploying the accounts rework (`18e9c2e`), to the subnet of the
network the container is on.
