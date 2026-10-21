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

## Outcome (2026-10-21)

**Done.** Reproduced on `main` before any change, with a Playwright script
against a scratch library and a local account: drew a stroke, the autosave
answered 200, deleted the `atrium_session` cookie, drew a second stroke. Its
autosave got a 401 and the login page replaced the editor in place, URL
unchanged. After signing in again the same note showed one stroke, the server
held one stroke, and nothing was offered.

**Size: IndexedDB, not a capped localStorage copy.** A note may be up to
16 MiB (`NOTE_MAX_MB`). localStorage holds about 5 MiB per origin, shared with
the LaTeX copies and the preferences, and `setItem` of a few MiB is a
synchronous stall in the middle of drawing. A cap would drop exactly the large
notebooks, which hold the most ink to lose. IndexedDB stores the pages as they
are (structured clone, no JSON string), off the main thread, under a quota that
is a share of the disk. It is its own small database (`atrium-unsaved`, store
`notes`) rather than a store in the offline library's database, which would
need a version bump through that database's migrations.

**Mechanism.** The module moved to
[`lib/unsaved-stash.ts`](../../../apps/web/src/lib/unsaved-stash.ts) and holds
both kinds. LaTeX stays on localStorage with the same keys, so copies already
on a device are still found; only its import path changed, and its banner
moved to
[`components/RecoveredBanner.tsx`](../../../apps/web/src/components/RecoveredBanner.tsx)
so both editors show the same one (same markup and classes as before). In
[`NoteEditor.tsx`](../../../apps/web/src/notes/NoteEditor.tsx):
- one record per note, keyed by account id, active profile id and note id;
- **written once per save, just before the request**, not on every edit:
  typing in a text box would otherwise clone the whole notebook on every key,
  and a copy written before the request is on the device before the server can
  answer 401. This includes the save on the way out (tab hidden, page left,
  editor unmounted) and the save before a PDF export. The cost: a crash inside
  the 900 ms autosave pause loses that pause's ink, as it did before;
- removed when a save lands with nothing newer waiting (`!isDirty()`);
- opening a note whose copy differs from the server's note shows "Recovered
  unsaved changes to this note from 10:35 AM, which never reached the server"
  with **Restore them** (undoable, and the autosave then sends it) and
  **Discard**. While the offer stands the stored copy is left as found. No
  copy is written until the one found on opening has been read, so an early
  save cannot overwrite it first. The comparison runs both sides through the
  shared page schema, so key order and defaults cannot make a saved copy look
  different;
- `lib/auth.ts`'s sign-in hook now calls one `discardOtherAccounts`, which
  sweeps both the localStorage and the IndexedDB copies.

**Checked**, the same script after the change (scratch library, accounts
`tester` and `tester2`):
- the repro as `tester`: the copy was on the device before signing in, the
  offer appeared, Restore saved (PATCH 200), the sheet and the server both had
  two strokes, the copy was gone, and a reload showed two strokes and no offer;
- the repro, then sign in as `tester2`: the note is another account's (404),
  no offer, and the copy was deleted on sign-in. Signing back in as `tester`
  offered nothing;
- Discard kept the server's one stroke and removed the copy;
- an ordinary save leaves no copy behind;
- the LaTeX editor's brief-85 repro still ends with its offer ("to main.tex"),
  and Restore still saves;
- the banner in Light, Warm and Dark at 1280 px and 390 px, no horizontal
  scroll. Design checklist: tokens only, Archivo for UI text, the time in
  tabular numerals, no accent, the card radius, no motion.
- `npm run typecheck`, `npm test` (647 typeset, 113 API) and `npm run build`
  are clean.

**Left:**
- the autosave's 10 s retry of a failing save (API down, not a 401) runs
  inside `use-notes.ts` and does not go through the copy. If that retry is the
  save that lands and no edit follows, the copy stays, equal to the server's
  note, until the note is opened again, when the comparison removes it without
  an offer.
- a note deleted from the list keeps its copy until another account signs in
  on the device; the delete lives in `NotesList.tsx` and `use-notes.ts`,
  outside this brief. Nothing can open it, so it is only disk.
- a note over the size cap is now copied too, so the offer comes back after
  sign-in; restoring it fails the same way (`NOTE_TOO_LARGE`) and the existing
  alert says so.
- this brief's own link to `latex/unsaved-stash.ts` above no longer resolves;
  the file is `lib/unsaved-stash.ts` now.
