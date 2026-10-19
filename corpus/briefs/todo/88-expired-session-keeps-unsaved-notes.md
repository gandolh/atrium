# Task 88: An expired session must not lose unsaved Notes ink

**Filed 2026-10-19** while building brief 85. Not reproduced yet; the gap is
read from the code.

## Context

Brief 85 found that a 401 replaces any page with the login page in place
(`AuthGate`, D58), which unmounts the open editor. The LaTeX editor now copies
every unsaved buffer to the device and offers it back after the next sign-in
([`unsaved-stash.ts`](../../../apps/web/src/latex/unsaved-stash.ts)). The
Notes editor ([`NoteEditor.tsx`](../../../apps/web/src/notes/NoteEditor.tsx),
brief 56's autosave) keeps its draft only in memory, so strokes drawn after
the session died and before the next save are lost the same way.

## Scope

**In:** unsaved note content survives the sign-in round trip for the same
account and profile and is offered back, with the same rules as brief 85.

**Out:** the LaTeX editor, the 403 and 503 paths, session lifetime.

## Files you OWN

- `apps/web/src/notes/NoteEditor.tsx`
- `apps/web/src/latex/unsaved-stash.ts`, only to generalise it (for example a
  `kind` in the key and a move to `lib/`), keeping the LaTeX editor working
  unchanged
- `apps/web/src/lib/auth.ts`, only for the discard-other-accounts hook

## What to do

1. Reproduce: draw in a note, wait for the save, delete the `atrium_session`
   cookie, draw more, wait for the autosave, sign in again, reopen the note.
2. Mind the size: a note can be up to 16 MiB (`NOTE_TOO_LARGE`), past what
   localStorage holds. Decide between IndexedDB and a capped copy, and write
   the reason in the Outcome.
3. Offer the copy back with Restore and Discard, as the LaTeX editor does.

## Acceptance

- The repro ends with the strokes offered back after signing in as the same
  account, and restoring them saves them.
- Signing in as a different account never shows them, and removes them.
- A successful save clears the copy.
- Typecheck, build and the existing tests are clean.
