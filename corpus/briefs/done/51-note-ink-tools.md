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

---

## Outcome (2026-08-30) — shipped, `0a5fb60` (D45)

The design gate was honoured: a design pass built a live comparison of four
candidates on identical sample strokes with real perfect-freehand ink, and the
owner picked from it. **Shipped: `fountain-pen` and a three-pass `pencil`.**

**Two candidates rejected on evidence.** The params-only pencil is a genuine
negative result — `outlineToPath` re-smooths every outline with quadratic
midpoints, so lowering `smoothing`/`streamline` moves the spine but never reaches
the eye, leaving a nib that differs from the pen by opacity alone. A broad-edge
calligraphic nib is **inexpressible** here: perfect-freehand's per-point radius is
a scalar, so the outline is always isotropic; faking the angle from direction of
travel overwrites real stylus pressure and breaks joins on tight curves. A real
one needs an ellipse-swept second pipeline.

The pencil's grain is three seeded passes; the seed is a sin-hash of the point
index, not `Math.random`, or the grain crawls on every re-render. Its jitter
scales with `size`, so it is weak at the thinnest nib — accepted.

**The integration point neither brief anticipated:** brief 49 had duplicated the
outline logic in `note-pdf.ts`, so adding nibs in the editor alone would have made
PDF export render them as plain pen — silently. The nib table now lives in
`packages/shared` (`nibPasses`, `nibNoise`, `nibPassPoints`) and both consume it.
Verified in the emitted PDF: pencil produces 4 fill ops and 6 alpha states against
the pen's 2 and 2; fountain-pen's taper yields different geometry.

The tool bar does not grow: one `NibSlot` holds the selected nib behind a picker,
so its width is independent of nib count and brief 26's above-the-fold finding
cannot regress by adding more.

**Not verified: the browser pass.** On-screen nib distinctness, the three themes,
and a pre-existing note rendering unchanged were never checked — the build was cut
off at exactly those steps. Everything else above is verified programmatically.
