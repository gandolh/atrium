# Brief 33 — Notes as its own destination

Notes leaves the retired nav-tab row and becomes a first-class destination
reached from the header, with its editor restyled onto Reading Room. Depends on
**briefs 27 + 28**.

## Grilled decisions applied
- **Notes is not a media chip** (D33g): a notebook is *authored*, not
  *collected*. Different verb, different surface.
- It keeps its own route and list; it does not appear in the home grid.

## What to do
1. **Entry** — the header's **Notes** link (brief 28) is the only way in; active
   state uses `accent`. `/notes` unchanged as a route.
2. **List** — [NotesList.tsx](../../../apps/web/src/notes/NotesList.tsx) becomes
   a left column: title, page count, relative date, active row marked with a 2px
   `accent` rule on `paper-raised` (see the comp).
3. **Editor chrome** — [NoteEditor.tsx](../../../apps/web/src/notes/NoteEditor.tsx):
   tool bar above the sheet (pen / highlighter / text / eraser, ink swatches,
   page indicator in **tabular** figures); sheet on `paper-low` ground with the
   L1 card treatment. **Keep the tool bar above the fold on mobile** — that was a
   real audit finding in brief 26, do not regress it.
4. **Tokens** — ink swatch colours come from tokens (`ink`, `accent`, sepia
   accent), not literals; page templates (blank / ruled / grid) use `line-soft`.
5. **Notes tint** — `--tint-note` is used for note artwork/placeholders wherever
   a note is represented outside the editor.
6. **Three themes** — the sheet must stay a readable writing surface in dark;
   ink colours invert sensibly rather than vanishing.

## Must NOT touch
- The ink pipeline: perfect-freehand sampling, coalesced-events handling, and
  the normalized-coordinate fix from brief 26 are all load-bearing bug fixes.
- The notes contract, autosave/debounce, or server storage.

## Acceptance
- Notes reachable only from the header; not present in the home grid or chips.
- Editor restyled with no regression to ink, undo/redo, autosave or mobile
  tool-bar placement.
- Dark theme gives a usable writing surface; ink stays visible.
- Typecheck + build clean; design.md conformance.

## Outcome (2026-08-24) — DONE
Landed as committed `4c29fc0`. Notes is reached only from the header and appears
in neither the grid nor the chips. The ink pipeline was not touched; strokes,
undo/redo and autosave were all re-verified in a browser.

Found and fixed a real bug in lane: `NoteEditor` never called
`useApplyTheme()`, unlike every sibling surface. Since that hook's cleanup
restores a captured `data-theme` on unmount, entering a note could freeze its
chrome on a stale theme — directly undermining this brief's dark-theme
acceptance.

**Deviation, accepted:** the list is a single-column row list, not a persistent
master-detail split with the editor docked beside it. The comp implies the
split, but that is an architectural change to how `/notes` renders rather than a
restyle, and the implementing agent had no access to the comp to confirm intent.
"Active row" is satisfied as a real hover/focus state following `TocSidebar`'s
existing idiom. **Worth revisiting** if the split view was the point.

Page-template rules deliberately keep `--note-sheet-rule` rather than the
theme-remapped `--line-soft`: the sheet is a fixed-light surface in every theme,
so a remapped rule would vanish in dark.
