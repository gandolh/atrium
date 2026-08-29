# Task 51 — a richer ink tool set for notes

**Promoted 2026-08-29** from the `notes-tab` epic, where "pencil / fountain-pen
textures" were left as an open question at v1 ("pen + highlighter + eraser only,
or also pencil/fountain-pen textures?"). Owner selected it on 2026-08-29.
Independent of briefs 49 and 50.

## Context

v1 shipped two ink tools. `NOTE_TOOLS = ["pen", "highlighter"]` in
[`packages/shared/src/notes.ts`](../../../packages/shared/src/notes.ts) is the
**stored** set; the editor's own `Tool` union
([`NoteEditor.tsx:41`](../../../apps/web/src/notes/NoteEditor.tsx)) adds
`eraser` and `text`, which are modes rather than stored stroke kinds. Geometry
comes from `perfect-freehand` in a ×1000 viewBox, with `thinning: 0.55` for pen
and `0` for highlighter ([`NoteEditor.tsx:94-108`](../../../apps/web/src/notes/NoteEditor.tsx)).

Samsung Notes — the feel this was built against — offers pen, fountain pen,
pencil, highlighter and eraser.

## This one needs a design pass before it needs code

The other two notes briefs are mechanism. This is **taste**, and D33 makes the
Reading Room system enforceable rather than advisory. A pencil is a texture
decision and a fountain pen is a pressure-response decision; neither is
answerable from a spec sentence. **Produce a comp or a live side-by-side of the
candidate nibs and get the owner's eye on it before building the tool bar.**
Building four nibs to taste and discovering the pencil reads as noise is the
predictable waste here.

## Scope

**In:** additional stored ink kinds (candidates: fountain pen, pencil), their
`perfect-freehand` parameterisation, and the tool-bar UI that selects them.

**Out:** brushes with bitmap textures, image stamps, shape recognition, rulers
and guides. Out: any change to the eraser or text-box tools. Out: the ink
palette and thickness steps, which shipped and are not this brief's business.

## Files you OWN

- `packages/shared/src/notes.ts` — `NOTE_TOOLS` and anything a new nib must store
- `apps/web/src/notes/NoteEditor.tsx` — nib parameters, tool bar, rendering
- `apps/api/src/notes-routes.ts` — only if validation needs it
- tests for the schema's back-compatibility

## Files you must NOT touch

- `apps/web/src/notes/NotesList.tsx`, `apps/api/src/db.ts`. The `notes.data`
  column is opaque JSON — a new tool needs **no migration**, and if it seems to,
  stop and say so.

## What to do

1. **Widening `NOTE_TOOLS` is a contract change with a back-compat trap in both
   directions.** `noteToolSchema` is a `z.enum`. Old notes carrying `pen` and
   `highlighter` must keep parsing — trivially true. The real risk is the other
   way: a note saved with a **new** nib, then opened by a client that predates
   it, fails the enum and the whole note refuses to parse. Decide and write down
   which way this fails, and prefer a permissive read (unknown tool renders as
   `pen`) over a note that will not open. Losing a nib style is a blemish;
   losing the notebook is not.
2. **Every new nib is `perfect-freehand` parameters, not a new renderer.**
   Fountain pen = high `thinning` plus tilt/speed response; pencil = a grainy
   edge achieved through `streamline`/`smoothing` and opacity, not a bitmap.
   If a nib cannot be expressed as parameters over the existing outline path,
   it is out of scope — say so rather than introducing a second ink pipeline.
3. **Keep the ×1000 viewBox.** It exists because perfect-freehand degenerates on
   normalized 0..1 coordinates — that was live-audit bug #3 in brief 26. Storage
   stays normalized; geometry stays scaled.
4. **Colours from tokens.** Ink swatches come from `ink` / `accent` / the sepia
   accent, never literals — brief 33 item 4, and the D33 checklist enforces it.
5. **The tool bar must stay above the fold on mobile.** That was a real audit
   finding in brief 26 and brief 33 restates it: *do not regress it.* Every new
   nib is another control competing for that space — if they do not fit, group
   them behind a nib picker rather than letting the bar grow.
6. **Pressure and stylus behaviour must not regress** — `getCoalescedEvents()`
   with its empty-array fallback (live-audit bug #2), palm rejection, and
   `touch-action: none` all stay exactly as they are.

## Acceptance

- The owner has seen the candidate nibs side by side and picked. **Do not skip
  to implementation.**
- Each shipped nib is visibly distinct from the others at the same colour and
  thickness — the point of the brief. If two are hard to tell apart, ship one.
- A note saved with a new nib reloads identically after a round-trip through the
  API.
- **A note containing an unknown tool value still opens**, with a test that
  proves it.
- Notes created before this brief render exactly as before — compare against a
  screenshot taken first.
- Tool bar above the fold on a 375px-wide viewport, verified in a browser.
- Stylus pressure, palm rejection and fast-stroke smoothness unchanged.
- All three themes checked; `design.md` conformance checklist run.
- Typecheck + `apps/web` build clean.
