# Task 56 — Note autosave: one save at a time, failures said out loud, and no 1 MiB wall

**Filed 2026-09-25** by the improvements sweep. A well-used notebook will
silently stop saving.

## Context

Three defects in one save pipeline, each confirmed in the source. The failure
each one can cause is unrecoverable data loss that the person is never told
about. [PRODUCT.md](../../../PRODUCT.md) principle 6 is the rule they break: on
an authoring surface, "a failure there is always said out loud rather than
swallowed".

### 1. Autosave sends the whole notebook into Fastify's default 1 MiB body limit

- Every autosave `PATCH /notes/:id` carries **every page's strokes**.
- [`app.ts`](../../../apps/api/src/app.ts) builds `Fastify({ logger: true })`
  with no `bodyLimit`, so Fastify's default of **1 MiB** applies.
- The notes routes set no override
  ([`notes.controller.ts:85`](../../../apps/api/src/modules/notes/notes.controller.ts)).
  The LaTeX file route does, with a comment naming this exact ceiling
  ([`latex.controller.ts:270-279`](../../../apps/api/src/modules/latex/latex.controller.ts)).
- Points are stored at full double precision:
  `toNorm` divides `getBoundingClientRect()` offsets with no rounding
  ([`NoteEditor.tsx:702-706`](../../../apps/web/src/notes/NoteEditor.tsx)).
- Points are captured from **coalesced** pointer events
  ([`NoteEditor.tsx:755-772`](../../../apps/web/src/notes/NoteEditor.tsx)).

Measured on a copy of the real database (2026-09-25): about **40 bytes per point**
and 30 points per mouse stroke. So roughly 26,000 points, or about 870 strokes, is
1 MiB, and fewer with a high-rate pen. Today's notes are 9.5 KB and 0.5 KB, far
from the wall. A notebook in real use will hit it, and after that **every save
returns 413**.

### 2. A failed save is invisible, and the dirty flag is cleared before success

[`NoteEditor.tsx:419-431`](../../../apps/web/src/notes/NoteEditor.tsx):

```ts
save.mutate({ title: title.trim() || "Untitled note", pages });
dirtyRef.current = false;          // ← cleared before the request resolves
```

[`useSaveNote`](../../../apps/web/src/notes/use-notes.ts) has only `onSuccess`,
and nothing in the editor reads `save.isError`. A failed save therefore shows
nothing and is not retried until the next edit. Close the tab after the failure
and the edits are gone.

### 3. The "flush on hide" effect fires a save on every edit

[`NoteEditor.tsx:435-448`](../../../apps/web/src/notes/NoteEditor.tsx) registers
the `visibilitychange` flush in an effect keyed on `[title, pages]`, and its
**cleanup calls `flush()`**:

- React runs that cleanup on every edit, while `dirtyRef` is still true from the
  previous render.
- Each stroke, keystroke in a text box, or eraser move therefore sends an
  **immediate** full-notebook PATCH, one edit behind. The 900 ms debounce is
  defeated.
- The requests are unsequenced (`mutate` does not queue), so an older, smaller
  payload can land after a newer one and revert strokes.

Compare the LaTeX editor, which chains its writes on purpose
(`writeQueueRef`, [`LatexEditor.tsx:150-222`](../../../apps/web/src/latex/LatexEditor.tsx)).

These are one pipeline, so they are one brief. Split, they would edit the same
lines in conflicting waves.

## Scope

**In:** the notes save routes' body limit; point precision at capture; the
editor's save sequencing, dirty tracking, flush and error state.

**Out:**
- the list query's cost, which is [brief 66](66-notes-list-without-ink.md);
- undo snapshots cloning the whole notebook (a Watch item);
- per-page storage, which is a bigger redesign — not this brief;
- the export path's behaviour, beyond keeping it working.

## Files you OWN

- `apps/api/src/modules/notes/notes.controller.ts`
- `apps/api/src/common/config.ts`, only to add an optional `NOTE_MAX_MB` override
  in the existing `numericOverride` style. Coordinate with brief 53 if both are
  in flight.
- `apps/web/src/notes/NoteEditor.tsx`
- `apps/web/src/notes/use-notes.ts`

## Files you must NOT touch

- `packages/shared/src/notes.ts`. The wire schema is fine; rounding happens at
  capture, and old notes must keep reading exactly as they do.
- `apps/api/src/modules/notes/note-pdf.service.ts` (export).

## What to do

1. **Server:** give `POST /notes` and `PATCH /notes/:id` an explicit `bodyLimit`
   from a named constant (default 16 MiB, `NOTE_MAX_MB` to override). Over the
   cap, answer 413 with a stable code, `{ error: "NOTE_TOO_LARGE" }`.
2. **Capture precision:** round normalized x/y to 4 decimals at capture, and
   pressure to 3. 0.0001 of the sheet width is about 0.1 px at 1000 px, which is
   invisible. This roughly halves the payload. Existing notes are untouched.
3. **One save in flight:**
   - Serialize saves through a promise chain, as `writeQueueRef` does.
   - While one is in flight, keep at most one queued save, and let it carry the
     **latest** state when it runs.
   - A save's payload is never older than one already acknowledged.
4. **Dirty until acknowledged:**
   - Clear the dirty flag only when the save that carried the current state
     resolves.
   - On failure keep it dirty, retry on the next edit and on a gentle interval.
   - Flush on `visibilitychange` / `pagehide`, as `lib/preferences.ts` does.
5. **Mount-only flush:** register the hide/unmount flush once and read the
   latest `title`/`pages` from refs, so an edit never triggers it.
6. **Say it out loud:**
   - A quiet "Not saved — retrying" state in the editor chrome while a save is
     failing, cleared by the next success.
   - A specific, persistent message for `NOTE_TOO_LARGE`.
   - Run the design conformance checklist at the bottom of
     [design.md](../../wiki/design.md): accent for state only, all three themes,
     reduced motion.

## Acceptance

- A synthetic note over 1 MiB (e.g. 30,000 generated points) saves with a 200.
- Past the configured cap, the editor shows the `NOTE_TOO_LARGE` message.
- Drawing ten strokes in quick succession produces **at most two** PATCH
  requests, checked in the network log. Today it produces about ten.
- The ordering and retry behaviour hold:
  - With the API stopped mid-session, "Not saved" appears and edits keep
    accumulating.
  - Restarting the API clears the message with one save carrying all of them.
  - No request carries an older state after a newer one was acknowledged.
- Closing the tab within 900 ms of the last stroke still persists that stroke.
- Typecheck and build are clean, and the design checklist passes.
- Verify against a scratch base with all five storage roots set inline and
  asserted before start.
