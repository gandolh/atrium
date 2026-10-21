# Task 85: An expired Ward session must not lose unsaved LaTeX edits

**Filed 2026-10-09** from README screenshot captures. The finding is from one
session; the code pointers are **leads, not proven causes**.

## Context

The Ward session expired while somebody was editing in the LaTeX editor. The
next save got a 401, the app went to Ward's sign-in page, and the unsaved
source was gone when they came back. The autosave is 900 ms, so the lost text
is whatever was typed since the last successful save, which could be long if
the session had already been dead for a while (the editor says nothing about
a failed save until you look).

## Reproduce

1. Local Ward and a scratch library (README runbook). Open a LaTeX project.
2. Type into `main.tex` and wait for "Saved".
3. Invalidate the session (sign out of Ward in another tab, or delete the
   `ward_session` cookie), then type more and wait for the autosave.
4. The app redirects to `/ward/login`. Sign in and return to the project.

Expected: the typed text is still there or is offered back. Confirm the loss
first; if the text survives, find out which step differs from the report.

## Leads (unverified)

- [`api-client.ts`](../../../apps/web/src/lib/api-client.ts) lines 112-114:
  every 401 calls the global handler before the caller sees the error.
- [`auth.ts`](../../../apps/web/src/lib/auth.ts) lines 423-449: the handler
  clears the profile state and the query cache, then calls `goToWardLogin()`
  (`ward.ts` line 39, a file D58 deleted), a full navigation
  that drops React state. Nothing stashes unsaved work first. **Since D58
  (2026-10-13)** the 401 handler no longer navigates: it resets the store and
  `AuthGate` renders the login page in place, which still unmounts the editor
  and its unsaved `draft`, so the gap stands.
- [`LatexEditor.tsx`](../../../apps/web/src/latex/LatexEditor.tsx): the buffer
  lives only in `draft` state and `draftRef` (lines 125-128); `flush` (line
  188) keeps `dirty` set on a failed write, but the failure is just `false`.
  The `visibilitychange` flush (line ~243) fires a PUT that also 401s.
- The same gap probably applies to Notes
  ([`NoteEditor.tsx`](../../../apps/web/src/notes/NoteEditor.tsx), brief 56's
  autosave), so decide whether the fix is per-editor or in the auth handler.
- `wardLoginUrl` defaults `next` to `/atrium/` on purpose (ward.ts lines
  24-34), so the person lands on the library, not back in the editor.

## Scope

**In:** unsaved source survives the sign-in round trip and is offered back, or
is protected some other way (for example, saving to local storage before the
redirect, or pausing the redirect on an editor with unsaved text).

**Out:** changing Ward's session lifetime, the 403 path, the 503 path (brief
77), other editors unless the fix is shared.

## Files you OWN

- `apps/web/src/latex/LatexEditor.tsx`
- `apps/web/src/lib/auth.ts` and `apps/web/src/lib/ward.ts` if the fix is in
  the redirect

## What to do

1. Reproduce and confirm what is lost and when the editor learns the save
   failed.
2. Choose the mechanism and write it down in the Outcome: a local per-project,
   per-profile stash written on every edit and cleared on a successful save,
   restored with a visible "Recovered unsaved changes" choice, is the simplest
   candidate. Mind that auth.ts clears per-profile data on 401 on purpose
   (the next sign-in may be a different account), so key the stash to the Ward
   subject and the project, and discard it for anyone else.
3. Show a failed save in the editor instead of silently staying "unsaved".

## Acceptance

- Steps 1 to 4 above end with the typed text recovered, or offered, in the
  same project after sign-in as the same account.
- Signing in as a different account never shows the first account's text.
- A successful save clears the stash.
- Typecheck, build and the existing tests are clean.

## Outcome (2026-10-19)

**Done.** Reproduced on `main` with a local account (Ward off; since D58 the
session is atrium's own `atrium_session`, so deleting that cookie is the same
event as Ward ending a session). Typed, waited for "Saved", cleared the
cookie, typed more: the next autosave got a 401 and the login page replaced
the editor in place, URL unchanged. After signing in and picking the profile
the same project reopened with the second edit gone. The editor never showed
the failed save: the 401 handler unmounted it in the same tick.

**Mechanism: a device copy, per editor.** Not a pause on the 401 handler: that
would keep a dead session's page on screen for every request on every page,
and the copy also covers a closed tab or a crash. New file
[`unsaved-stash.ts`](../../../apps/web/src/latex/unsaved-stash.ts):
- one localStorage entry per file, keyed by account id, active profile id,
  project id and path (the account id rather than the Ward subject: since D58
  the account is the identity and a Ward subject maps onto one);
- `LatexEditor.tsx` writes it on every unsaved edit and removes it when a save
  of exactly that text lands, and on rename and delete;
- opening a file whose copy differs from the server's text shows "Recovered
  unsaved changes to main.tex from 03:02 PM, which never reached the server" with
  **Restore them** and **Discard**. A choice rather than an automatic restore,
  because the server copy may be newer. While the offer stands, the copy is
  left as found: typing does not overwrite it and saves do not clear it;
- `lib/auth.ts` subscribes to the auth client and, whenever an account is
  signed in, deletes every copy that belongs to another account, whatever page
  they land on.

The failed save is now shown by that offer after sign-in. A failed save that
keeps the editor mounted (the API down) already showed "Not saved" and the
alert banner. `ward.ts` no longer exists (D58), so nothing changed there.

**Checked** in the browser (local Ward off, scratch library):
- Steps 1 to 4 as `tester`: the offer appeared, Restore put the text back,
  autosave showed "Saved", the copy was gone, and a reload showed the text from
  the server.
- The same as `tester`, then sign in as `tester2`: "Project not found" (the
  project is another profile's), no offer, and the copy was deleted on
  sign-in. Signing back in as `tester` offered nothing.
- Discard left the server's text and removed the copy.
- The banner in Light, Warm and Dark at 1280 px and at 390 px. Design
  checklist: tokens only, Archivo for UI text, the time in tabular numerals,
  no accent (it is not a state), the card radius, no motion.
- Typecheck, build, and the existing tests (647 typeset, 113 API) are clean.

**Left:** Notes has the same gap; filed as
[brief 88](88-expired-session-keeps-unsaved-notes.md), which also needs
a decision on note size against localStorage's limit.
