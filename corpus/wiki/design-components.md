---
summary: Reading Room's components (rail, bottom bar, band, buttons, chips, tiles, Notes list, dock, reader chrome, inputs) and the motion rules, as shipped by D63. Split from design.md.
updated: 2026-11-13
---

# Design — components and motion

Split from [design.md](design.md), which holds the premise, colours, type, structure and the conformance checklist.

## Components
- **Rail (1280) and bottom bar (phone):** `paper-raised` with a hairline and a soft shadow. The rail's icons
  are neutral; only the current place takes `place-current`. The bar is four places, an icon over a label,
  the current one on a pill, fixed to the foot with the inset; the shell pads for it.
- **Band and top bar:** a raised band at 1280 holds search at the left and the page's actions at the right
  (Add, or New folder and New note). A phone gets a raised top bar (wordmark, profile, a theme button that
  opens the guarded group in a popover) with search right under it; its actions become a matched 48 px pair
  under the page title.
- **Buttons — primary:** solid `ink-fill`, `on-ink-fill` text, 44 px, 12px radius (a plus and the word for Add).
- **Buttons — secondary:** 1px `outline` edge on `paper-raised`. **Quiet:** no edge, `ink-variant`.
- **Filter chips:** pill, `outline` edge on `paper-raised`; active chip inverts to `ink-fill`. The count
  is full strength (`ink-variant` on an idle chip), zeros included.
- **Tiles:** `tint-*` ground by kind, 1px `line`, 16px radius, artwork at 8px, the offline button and ⋮
  both visible at rest. Book 2:3, music 1:1, **video 4:3** — the tile's box; stored video art is
  letterboxed inside it (`object-contain`), because a frame grabbed from a video
  keeps that video's own aspect (D40, video covers of 2026-08-28: `fit: "inside"` at a 640 bound,
  never cropped). A PDF's cover is the file's real first page, set below the offline button's row. The
  grid fills the width: six 154 px tiles at 1280, two at 360 and 390, four at 768. Titles, authors and notes
  never truncate. **Coverless** tiles keep the flat kind ground and add the D42 title-initial watermark.
- **Notes list:** one raised card, 720 px at most, 68 px rows with hairlines; Move and Delete visible at rest
  (on a phone, the row's second line). Delete stays `ink-variant` until hover or focus, then danger.
- **Resume cards:** artwork + title + source + **time remaining** + a 3px bar.
- **Player dock:** `paper-raised`, 1px top `line`; artwork, title, transport, scrub track, tabular times.
  Survives navigation. It clears the rail (at 1280) and sits above the bottom bar (on a phone).
- **Reader chrome:** running header (title / chapter), footer `chapter · %`,
  and the scrubbable rail with chapter ticks. All fade on idle.
- **Aa panel:** theme swatches drawn as miniature pages, face toggle, A−/A+.
- **Inputs:** 1px `outline`, 12px radius, 44 px tall; a 2px `accent` outline on focus.
- **Icons:** line icons, unified **1.75 stroke**, inline SVG (no icon font).

## Motion
Paper moves like paper: things lift, settle and fade. Nothing bounces, springs
past its mark, or slides in from off-screen.

| Moment | Behaviour | Timing | Built with |
|---|---|---|---|
| Card hover | Lift 4px, shadow deepens | 300ms `(.2,.7,.3,1)` | CSS |
| Grid re-filter | Tiles settle, 20ms stagger | 340ms | Motion Primitives |
| Cover → reader | Cover expands into the page | 420ms | Motion Primitives (shared layout) |
| Chrome fade | Reader chrome fades on idle | 600ms out / 150ms in | CSS |
| Progress rail | Scrub preview tracks pointer, commits on release | continuous | anime.js timeline |
| Dock enter | Rises from the foot on playback start | 280ms | Motion Primitives |

**One idiom.** Motion Primitives is the base (copy-in components on Motion +
Tailwind — this exact stack). **anime.js** earns its place only on the progress
rail, where an imperative timeline beats React state. **SmoothUI is
deliberately out**: it overlaps Motion Primitives almost entirely, and two
motion idioms in one app read as two apps.
