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
  ([`ward.ts`](../../../apps/web/src/lib/ward.ts) line 39), a full navigation
  that drops React state. Nothing stashes unsaved work first.
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
