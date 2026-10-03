# Task 77 — With Ward down, the app says so instead of sitting on "Loading…"

**Filed 2026-10-03** while closing brief 65. That brief's log entry
(2026-09-27) recorded the symptom and assigned it to brief 61, but 61 was the
API half only.

## Context

Brief 61 made the API answer **503 `IDENTITY_UNAVAILABLE`** whenever Ward
cannot vouch for a session, the key-fetch path included. The web client never
turns that into a state anyone can read:

- `checkStatus` in [`lib/auth.ts`](../../../apps/web/src/lib/auth.ts) treats
  any failure other than 401 or 403 as `unlocked`, on purpose. Sending somebody
  to a login page served by a service that is down is a loop that looks like a
  rejected password, and an offline device must still open its downloaded books
  (brief 20).
- With no profile list, though, nothing renders a message. The
  2026-09-27 run against a stopped local Ward sat on "Loading…".

Two outages need telling apart, because only one of them should block:

| Probe result | Meaning | Right outcome |
|---|---|---|
| network error | this device is offline | today's `unlocked`: the offline library works |
| `503 IDENTITY_UNAVAILABLE` | the API is up, Ward is not | say so, with a retry; offline books stay reachable |

## Scope

**In:** an explicit unavailable state in the session gate for a 503 from the
probe, with retry, and keeping offline reading reachable.

**Out:** the API (brief 61, done); the login redirect; the 403 screen.

## Files you OWN

- `apps/web/src/lib/auth.ts`
- `apps/web/src/auth/AuthGate.tsx`

## What to do

1. Add an `unavailable` gate status, set when `GET /profiles` answers 503 with
   `IDENTITY_UNAVAILABLE`, keeping the error body.
2. Render it in the gate's quiet register, in the same place and tone as the
   `forbidden` message: "Sign-in is unavailable right now. Atrium will try
   again." Add a Retry button, an automatic retry on an interval and on
   `online`/`visibilitychange`, and a link to downloaded books if the device
   has any.
3. Keep a network error resolving to `unlocked`, as today.
4. Run the design conformance checklist (design.md).

## Acceptance

Against a local Ward (README runbook) and a scratch base with all five storage
roots set inline and asserted:
- Stopping Ward, then reloading once the introspection cache expires, shows the
  unavailable message: no "Loading…", no login redirect.
- Starting Ward again recovers without a manual reload.
- Taking the device offline still opens a downloaded book.
- Typecheck and build are clean.
