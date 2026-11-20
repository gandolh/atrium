# The board's notes: Atrium

The estate redesign board is a private canvas. This file copies what its page for this app said beside the screens: the owner's asks, the decisions, the rules the design reopened, the open questions and the Floor. The owner's answers are in [README.md](../README.md#the-owners-decisions).

## Asks to the owner

- 1. Reopened: PRODUCT.md's "prefer summoned UI over persistent UI" and D33's "one home, no tabs". Approve a persistent 232 px rail (1280) and a four-place bottom bar (390) that hold only Library, Notes, LaTeX, Jukebox and Browse catalogs, with kinds still chips and the reader left immersive? 2. Approve the stronger kind tints (a D33 value change, per D42), the new token place-current, the new place name "Library", and the drop of tracked capitals; and on a phone should a note's Move and Delete stay visible at rest (drawn) or sit behind a ⋮ menu, as the tiles' do? 3. Approve Rail and reading table as Atrium's direction? (beside `atrium-direction`)

## Decisions

- A raised band holds search and Add, the two things you do first, with an edge and a soft shadow so the title and grid read as the content beneath it. Add draws a plus and the word. [conv, S9] (beside `atrium-proposed-library-1280`)
- Tiles stay tinted cards with a 1 px edge, since the light tints sit only 1.06 to 1.10 on the ground; both buttons show at rest. The coverless initial is smaller and in the corner clear of the title; the PDF cover is the seed file's real first page, its text set a little lower than the file's so the offline button never covers it. [conv] (beside `atrium-proposed-library-1280`)
- Chips keep their counts, zero included, at full strength (6.71:1) where today's 55% opacity fails. Author and format are two spans, never dot-joined (Hallmark gate 63). (beside `atrium-proposed-library-1280`)
- Profile and the four-way theme switch sit at the rail's foot as today. Rail icons are neutral and only the current place is tinted, so colour means you are here and the grid keeps the kind colours. [conv] (beside `atrium-proposed-library-1280`)
- Phone: a raised top bar with search right under it, then the title, then Browse catalogs and Add as a matched pair 48 px tall, so finding comes before adding. The bottom bar is 64 px plus the inset, four places with icon and label, the current one on a pill. [S9] (beside `atrium-proposed-library-390`)
- The reader stays immersive: no rail or bottom bar, running heads in the corners, and a floating toolbar that auto-hides as today. The pill gets an edge, a lift and 44 px targets; its home button is named Back to library, as the reader's error page already says. [S11] (beside `atrium-proposed-reader-1280`)
- The text column, the 18/32 Newsreader and the page-jump field are today's, and the words are the seed book's. Only the surfaces and edges change. (beside `atrium-proposed-reader-1280`)
- The progress rule runs along the foot, accent on a line track, with today's dot at the start. [conv] (beside `atrium-proposed-reader-1280`)
- Notes is a place in the rail, and its band holds the title and the two actions, New folder (quiet) and New note (solid), so no second header is needed. [conv] (beside `atrium-proposed-notes-1280`)
- The row shows the folder select and Delete at rest, as today's phone does, in a raised card with an edge. "1 page" and "21m ago" are two spans, not dot-joined. (beside `atrium-proposed-notes-1280`)
- Six columns at 1280, over direction B's "5 columns of at least 168 px": today shows six and density was the pilot's top regression. The grid is 154 px tiles with a 12 px gap in a 1152 px cap, and 150 px minimum under 820 (2 columns at 390 and 360, 4 at 768). (beside `atrium-proposed-library-1280`)
- Notes is one raised list card, 720 px at most, with 68 px one-line rows and a hairline between rows. On a phone the select and Delete stay visible at rest on the row's second line inside the same card. Delete is quiet until hover or focus, then danger. (beside `atrium-proposed-notes-1280`)
- The progress rule carries faint ticks at chapter starts, as today's does, and the comp carries the seed book's own text as today's shot does; a labelled specimen on the sheet shows a full page, 17 lines at 1280 and 19 at 390. (beside `atrium-proposed-reader-1280`)

## Reopened rules

- Recorded: PRODUCT.md principle 1, "Prefer summoned UI (auto-hide, popovers) over persistent UI", and D33 (a), "one home, no tabs: kind is a filter chip with a count, not a route" (wiki/decisions.md). Proposed: a persistent rail, and on a phone a bottom bar, holding only today's header links plus home; kinds stay chips and the reader keeps its auto-hiding chrome. [S9, S10] (beside `atrium-proposed-library-1280`)
- Recorded: D61 makes the theme a guarded four-way ToggleGroup, in plain view in today's header. Proposed: at 1280 it stays in view at the rail's foot; at 390 it moves into a popover on the top bar's theme button, holding the same group. [conv] (beside `atrium-proposed-library-390`)
- Recorded (wiki/design.md, type roles): label-caps, "Archivo 10/1.6, .15em, 600: chips, eyebrows (uppercase)". Proposed: it goes, so "Sort by", the chips and every label are sentence case at 12 px or more (Hallmark Floor 9). (beside `atrium-direction`)
- Recorded (wiki/decisions.md D42): "it stays empty until the tints themselves gain chroma (which is a D33 change)". Proposed: the four kind tints gain chroma, the closest pair 0.029 apart in OKLab against 0.018 today [direction notes], so a mixed grid reads by kind and dark tiles lift 1.22 or more. (beside `atrium-direction`)

## Open questions

- The rail will squeeze the LaTeX editor's source and preview split, and that screen is not drawn. Proposal: the rail hides there, as it does in the reader, and the bottom bar stays on a phone. (beside `atrium-direction`)
- Sepia is drawn on this sheet only; the reader's theme picker keeps Light, Sepia, Dark and System and is not redesigned here. The Continue row and the dock are drawn once, in the States strip, because the library has nothing to continue or play. (beside `atrium-direction`)

## The Floor

- Contrast is scripted over 38 pairs in three themes: text min 5.26 light, 5.65 dark, 5.14 sepia; UI and focus 3.29 or more; rail and band sit 1.16 light and 1.21 dark above the ground, and each tile under 1.09 carries a 1 px edge (1.39 light, 1.65 dark). Nothing overflows the page or its own control at 1280, 1024, 768, 390 or 360 in both themes, and the phone layout answers to the artboard's width, not the window's (checked in a 390 px box at 1440). Every phone control is 44 px or more and the bottom bar sits in the flow, so nothing hides under it. Sloplint --scope app --render on the six Proposed twins: 0 FAIL, 0 REFLEX, 0 WARN, with F24 (the reader pill keeps a hairline and a lift) and 41 (no text sits on an accent fill) dismissed with reasons in the stamp; the fixed 1440 sheet is not linted. States for Library, Notes and the Reader are on the sheet. (beside `atrium-direction`)

## Other notes

- Atrium and Shelfmark stay independent: nothing here is taken from Shelfmark's direction. Faces and the blue accent are today's, and the rail is 232 px with text labels and no list pane, unlike Satchel's icon rail.

## Contrast, as measured

| Pair | Light | Dark | Needs |
|---|---|---|---|
| ink on paper | 14.48 | 15.67 | 4.5 |
| ink on paper-raised | 16.81 | 12.99 | 4.5 |
| ink on tint-book | 13.39 | 12.42 | 4.5 |
| ink on tint-note (note title) | 13.67 | 12.27 | 4.5 |
| ink-variant on paper | 5.78 | 7.22 | 4.5 |
| ink-variant on paper-raised (rail, placeholder, counts) | 6.71 | 5.98 | 4.5 |
| ink-variant on paper-low (key hint, LaTeX) | 5.28 | 7.43 | 4.5 |
| ink-variant on tint-book (author, format, glyph) | 5.34 | 5.72 | 4.5 |
| ink-variant on tint-music | 5.26 | 5.9 | 4.5 |
| ink-variant on tint-video | 5.4 | 5.77 | 4.5 |
| ink-variant on tint-note | 5.46 | 5.65 | 4.5 |
| accent on paper (wordmark, link) | 6.68 | 9.33 | 4.5 |
| accent on paper-raised (wordmark, current tab label) | 7.76 | 7.73 | 4.5 |
| on-place-current on place-current (current place) | 6.75 | 6.14 | 4.5 |
| accent on paper-low (selected theme) | 6.11 | 9.6 | 4.5 |
| on-ink-fill on ink-fill (Add, active chip) | 14.75 | 14.68 | 4.5 |
| danger on paper-raised (Remove, Delete, field error) | 6.8 | 7.68 | 4.5 |
| danger on paper | 5.86 | 9.27 | 4.5 |
| on-ink-fill on ink-fill-hover (Add, hover) | 10.46 | 11.67 | 4.5 |
| pdf-ink on pdf-page (the cover's type) | 11.42 | 11.62 | 4.5 |
| on-callout on callout (board marker) | 5.93 | 7.75 | 4.5 |
| outline on paper (field edge) | 3.29 | 4.09 | 3 |
| outline on paper-raised (search, chips, select, buttons) | 3.82 | 3.39 | 3 |
| focus ring on paper | 6.68 | 9.33 | 3 |
| focus ring on paper-raised | 7.76 | 7.73 | 3 |
| focus ring on place-current | 6.75 | 6.14 | 3 |
| focus ring on tint-book | 6.18 | 7.4 | 3 |
| progress rule on pdf-page | 7.82 | 3.66 | 3 |
| progress rule on tint-book | 6.18 | 3.7 | 3 |
| ink-variant icon on paper-raised (rail, bar) | 6.71 | 5.98 | 3 |
| paper-raised on paper (rail, band, bars) | 1.16 | 1.21 | 1.09 |
| place-current on paper-raised (current place) | 1.15 | 1.26 | 1.09 |
| tint-book on paper (tile, edge 1.3 applies) | 1.08 | 1.26 | 1.09 |
| tint-music on paper | 1.1 | 1.22 | 1.09 |
| tint-video on paper | 1.07 | 1.25 | 1.09 |
| tint-note on paper | 1.06 | 1.28 | 1.09 |
| line on paper (tile edge) | 1.39 | 1.65 | 1.3 |
| line on paper-raised (rail and band edges) | 1.62 | 1.36 | 1.3 |

## The runner-up

**Runner-up: A, Reading Room, settled (sketch only, not built)**

Note: how this direction was picked. Two directions were sketched (A evolve today, B the rail and reading table) and two judges compared every pair against today, in both orders, at 1280 light and 390 dark. All 12 verdicts agreed: B won 4 of 4, A 2, today 0 (today failed structure in every pair: the header shares the page fill). A lost to B on the rail with the current place and the phone's bottom bar. Say so here if you'd rather keep today's summoned places (A) over a persistent rail.

## The artboards on the board

- Direction · Rail and reading table
- Library · 1280 · light · today
- Library · 390 · light · today
- Reader · 1280 · light · today
- Reader · 390 · light · today
- Notes · 1280 · light · today
- Notes · 390 · light · today
- Library · 1280 · light · proposed
- Library · 390 · dark · proposed
- Reader · 1280 · light · proposed
- Reader · 390 · dark · proposed
- Notes · 1280 · light · proposed
- Notes · 390 · dark · proposed
- Runner-up A, Reading Room, settled · light 1280 (sketch)
- Runner-up A, Reading Room, settled · dark 390 (sketch)
