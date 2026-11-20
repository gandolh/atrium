# The redesign: "Rail and reading table"

This folder is the design record of Atrium's redesign. The estate redesign board, where it was drawn and approved, is a private canvas; this is a copy of the app's page on it plus the build behind that page. The owner approved it on 2026-11-13, and [brief 05](../../corpus/briefs/done/05-a-redesign-with-hallmark-on-the-estate-board.md) built it. The code is now the source of truth: where the app and these files differ, the app wins, and later work may have moved a screen on. Read this folder to see what was decided and why before reshaping a screen.

## The owner's decisions

The owner approved the whole board on 2026-11-13, with every question standing at what the board proposed unless they reopened it. The questions this app's page asked:

- **Ask:** 1. Reopened: PRODUCT.md's "prefer summoned UI over persistent UI" and D33's "one home, no tabs". Approve a persistent 232 px rail (1280) and a four-place bottom bar (390) that hold only Library, Notes, LaTeX, Jukebox and Browse catalogs, with kinds still chips and the reader left immersive? 2. Approve the stronger kind tints (a D33 value change, per D42), the new token place-current, the new place name "Library", and the drop of tracked capitals; and on a phone should a note's Move and Delete stay visible at rest (drawn) or sit behind a ⋮ menu, as the tiles' do? 3. Approve Rail and reading table as Atrium's direction?
- **Open question:** The rail will squeeze the LaTeX editor's source and preview split, and that screen is not drawn. Proposal: the rail hides there, as it does in the reader, and the bottom bar stays on a phone.
- **Open question:** Sepia is drawn on this sheet only; the reader's theme picker keeps Light, Sepia, Dark and System and is not redesigned here. The Continue row and the dock are drawn once, in the States strip, because the library has nothing to continue or play.
- **Reopened:** Recorded: PRODUCT.md principle 1, "Prefer summoned UI (auto-hide, popovers) over persistent UI", and D33 (a), "one home, no tabs: kind is a filter chip with a count, not a route" (wiki/decisions.md). Proposed: a persistent rail, and on a phone a bottom bar, holding only today's header links plus home; kinds stay chips and the reader keeps its auto-hiding chrome. [S9, S10]
- **Reopened:** Recorded: D61 makes the theme a guarded four-way ToggleGroup, in plain view in today's header. Proposed: at 1280 it stays in view at the rail's foot; at 390 it moves into a popover on the top bar's theme button, holding the same group. [conv]
- **Reopened:** Recorded (wiki/design.md, type roles): label-caps, "Archivo 10/1.6, .15em, 600: chips, eyebrows (uppercase)". Proposed: it goes, so "Sort by", the chips and every label are sentence case at 12 px or more (Hallmark Floor 9).
- **Reopened:** Recorded (wiki/decisions.md D42): "it stays empty until the tints themselves gain chroma (which is a D33 change)". Proposed: the four kind tints gain chroma, the closest pair 0.029 apart in OKLab against 0.018 today [direction notes], so a mixed grid reads by kind and dark tiles lift 1.22 or more.

Where the files below disagree, the later layer wins: the owner's decisions, then the controller's rulings, then the judges' rulings, then the directions file.

## What is here

| Path | What it holds |
|---|---|
| `directions/atrium.md` | The director's brief: both directions (the winner is the one built), the shared fixture and the screens to draw. |
| `judge/atrium/RESULT.md` | The blind judging against today and the rulings that came with the win. |
| `critiques/atrium-controller.md`, `critiques/atrium.md` | The design critic's review against today, and the controller's rulings over it. |
| `manifests/atrium.tokens.css`, `manifests/atrium.tokens-map.md` | The token hand-off in the app's own names, and the renamed, new and unused tokens. |
| `manifests/atrium.board-notes.md` | What the board said beside the screens: the asks, decisions, reopened rules, open questions, the contrast table and the runner-up. |
| `work/atrium/twins/*.html` | Each drawn screen as static HTML, light and dark: open one in a browser. |
| `work/atrium/shots/` | The twins rendered at 1280 and 390, light and dark, WebP. `direction.webp` is the board's direction sheet. |
| `shots/atrium/` | Today's screens as the board showed them before the redesign. |

People's names and data in the pictures come from seeded demo accounts or are invented.

## Not here

The sketches and the judges' images, the runner-up's build (its notes are in the board's notes), the build's scripts, and the screenshots taken while it was built. They stay in the estate build folder.
