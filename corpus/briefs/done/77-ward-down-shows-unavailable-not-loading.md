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

## Outcome (2026-10-03)

Done.

**Change:**
- `lib/auth.ts`: a new `unavailable` status, set only when the probe answers 503 with `{ error: "IDENTITY_UNAVAILABLE" }`. A 503 without that body (a proxy in front of a stopped API) and a network error still resolve to `unlocked`. `continueWithoutSignIn()` leaves the screen for the app.
- `auth/AuthGate.tsx`: the message in the `forbidden` register, a Retry button, and `checkStatus` again every 15 s, on `online`, and when the tab is shown. "Read downloaded books" appears when the device has any; it unlocks and goes to `/books`, where the library falls back to the downloads on its own.

**Outside the owned files, needed for the third acceptance line.** Two pre-existing bugs meant a downloaded book did not open whenever the library list could not load. Neither came from this brief:
- `routes/read.tsx`: the twin resolution (brief 34) handed the hydrate no id until `GET /library` answered. With the list failed, or paused because the browser went offline, a downloaded book sat on "Opening your book…" forever. It now opens the requested id (the id a download is stored under) and freezes it.
- `lib/use-library.ts`: the downloaded-books query reads IndexedDB, but react-query's default network mode paused it once the browser reported offline, so a tab that went offline showed an empty library. It runs with `networkMode: "always"`.

**Verified** against the local Ward container (README runbook) and a scratch base, with all five roots set inline and asserted before the app loaded. Signed in through Ward's own page; Ward's API container was stopped and started for each check.
- Ward stopped, then a reload once the 30 s introspection cache had expired: the message and Retry, with no "Loading…" and no redirect. "Read downloaded books" appears once a book is downloaded, and the book opens from it. That takes about 10 s, because `GET /library` retries the 503 twice before the reader falls back.
- Ward started again: the open page left the screen within about 10 s, without a reload, on the same session. Retry recovers at once (checked against a scripted Ward flipped by a flag file).
- On the production build (service worker active), a downloaded book opens after a cold boot offline, and after going offline in-session from Notes.
- The screen in light, sepia and dark themes. Typecheck and build are clean.
