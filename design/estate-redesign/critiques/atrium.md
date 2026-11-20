fix

# Atrium: design critique of "Rail and reading table" (B)

The shell is right and should ship as drawn: the labelled rail, the four-place bottom bar, the raised band and the tinted tiles. The faults are density and fidelity:
- The Notes list breaks its one list island into separate cards and shows half as many rows.
- The 1280 grid loses a column, and 768 drops to two giant tiles.
- The reader loses its chapter ticks.

None of these needs a direction change, and none should be fixed by clamping a title.

## First-screen density, today against the build

Measured on the shots: today is 1280×800 and 390×800, the build is 1280×800 and 390×844. Phone figures are normalised to 844, and the build's 64 px bottom bar is subtracted.

| Screen | Today | Build | Net |
|---|---|---|---|
| Library 1280 | grid at y 243, **6** tiles per row (171 px), 228 px of row 2 | grid at y 230, **5** per row (174 px), 243 px of row 2 | **-1 cover per row (-17 %)** |
| Library 768 | 4 per row (from source, `sm:grid-cols-4`: no shot), about 8 covers | **2** per row (362 px tiles), row 1 cut by the bar at y 961 | **about -6 covers** |
| Library 390 | 2 full tiles, 87 px of row 2 | 2 full tiles, 83 px of row 2 | par. The header shrinks from 240 to 120 px, but the bar and a separate Sort row spend that gain |
| Library 360×800 | n/a | the chips wrap ("Video 0" alone, +52 px); the tiles end at y 718 and the bar starts at 737 | **none of row 2 shows** |
| Notes 1280 | list at y 179, about 57 px rows in one bordered list, **10** rows | list at y 129, 70 px cards with a 24 px gap (94 px pitch), **7** rows | **-3 rows (-30 %)** |
| Notes 390 | list at y 321, 60 px rows, **8** rows | 130 px cards (the actions wrap to line 2) with a 16 px gap, **4** rows | **-4 rows (-50 %)** |
| Reader 1280 / 390 | 15 / 15 lines, the page full to its foot | 13 / 13 lines, then 176 / 262 px of empty page | the comp under-sells itself: the text starts 42 / 68 px higher, so a full page holds **17 / about 19** lines |

## Regressions against today

1. **Notes, at 1280, 768 and 390: one list island became loose cards, and the density halved.** Today the notes sit in one bordered container (`divide-y`, 672 px wide), with folders and nested notes in the same box and rows of about 57 px. The build gives every note its own raised card: 24 px apart at 1280, 16 px at 390, and 936 px wide at 1280. Under 820 px, `.nrow .tools{flex:1 1 100%}` forces the select and Delete onto a second line, even at 768 where 500 px of the row stands empty. Each card is then 130 px tall. Nested folders have no container to sit in.
   Fix: one `paper-raised` list card (radius 16, 1 px `line`, shadow-1), max 720 px wide and left-aligned, 24 px under the band, with a 1 px `line` between rows. Each row is one line:
   - 12 px vertical padding and a 40 px icon;
   - the title and meta column (`flex:1`, wrapping, never clamped);
   - the actions, inline wherever the row is 480 px or wider (select 36 px tall, then Delete).

   Under 480 px, put Move and Delete behind a 44 px "More actions for Garden plan" ⋮ menu. The tiles already use that pattern, and it keeps the title column at about 230 px. Today's phone shows both actions at rest, so the menu is the owner's call. If they must stay inline: icon 36, the select's padding 0 28 0 10, Delete's padding 0 8. That leaves the title about 100 px at 360, so long titles wrap.

   Either way a row is about 68 px, which buys back 8 rows at 390 and 10 at 1280.
2. **Library 1280: one cover fewer per row.** The 232 px rail and the 1000 px cap on `.inner` leave a 936 px grid, so `minmax(168px,1fr)` gives 5 columns. Today's 1100 px grid gives 6. Fix: keep the rail at 232 (the judges kept it) and raise the cap to today's 1152. Use `minmax(152px,1fr)` with a 12 px column gap, so 1280 − 232 − 64 = 984 px gives 6 × 154 px. At 1440 the 1152 cap gives a 1088 px grid, which is 6 columns, par with today. Keep the 16 px row gap. Captions wrap and are never clamped.
3. **Library 768: two 362 px tiles where today has four.** Everything under 820 px gets `grid-template-columns:1fr 1fr`. Fix: under 820, use `repeat(auto-fill,minmax(150px,1fr))` with a 12 px gap. That gives 2 columns at 360 and 390 and 4 at 768.
4. **Reader, both widths: the chapter ticks on the progress rule are gone.** Today's rule has faint ticks at chapter starts (`ProgressRail`; at 1280 they sit at x 274, 731 and 1097), so you can see where you are in the book. The build's rule is plain. Fix: draw 1 × 7 px `line` ticks on the rule at each chapter start, under the accent fill, at both widths.

Nothing a person could do got harder. Every place, control and fact from today is present. The losses are density and the Notes grouping.

## Clashes with the direction and the rulings (for the controller)

- **Regression 2 overrides direction B's own spec.** B specifies "5 columns of at least 168 px" in a 1000 px column. The judges ruled on the comps with two tiles, so they never saw 5 against 6. My fix keeps the rail they kept. Decide whether 6 at 154 px beats 5 at 174 px. Today's tiles are 171 px.
- **The PDF cover's text is set lower than in today's shot.** The ruling says to draw the first page "as today's shot shows it". The build's sticky says the text was lowered so the offline button (now at rest) never covers it. I would accept this, but it is a deviation from the ruling.

## Priority issues (ranked by cost to the user)

1. **Notes density and grouping.** See regression 1. It costs the most because Notes is a list you scan every day.
2. **The 1280 and 768 grid columns.** See regressions 2 and 3.
3. **The PDF cover breaks at 360 and 768.** `.pg` is a fixed 640 px page scaled by 0.247 (158 px). At 360 the cover is about 138 px wide, so the page text runs off the right edge. At 768 the text fills only the top-left quarter of a 342 px sheet. Fix: draw the page as an inline SVG (`viewBox="0 0 640 960"`, `width:100%`) so it scales with the cover. Keep the real text.
4. **The phone Library spends 108 px on the Sort row and the chip wrap.** At 360×800, the Android case, no second row shows at all. Fix:
   - Put `Sort by` and the select at the right end of the `Your library` row. The 32 px serif title takes about 160 px and the sort about 150 px, which fits in 358.
   - Give the chips 12 px side padding under 380 px, which takes them from 353 to 321 px and fits in 328. Keep them 44 px tall.

   This brings about 140 px of the second row of covers above the bar at 390, and about 100 px at 360×800.
5. **The bars float at 768×1024.** In Notes and the Reader, the bottom bar and the reader toolbar end at y 844, leaving 180 px of ground below them, because `.app{min-height:844px}` stands in for the viewport. Fix: `min-height:100dvh`. The bar sits at the foot at every height.
6. **The reader comp stops at 13 lines.** The fixture is 19 or 30 fixed sentences, so the page ends 176 / 262 px above the toolbar and looks emptier than today. Fix: fill the column to the page foot, as pagination does, so the owner sees the real gain (17 / about 19 lines). Restore the ticks (regression 4).
7. **Smaller fixes:**
   - **The phone theme button hides the current theme.** It always draws the "warm" half-circle. Fix: show the chosen theme's icon, named "Theme: Light", for example.
   - **Every Notes row at 1280 shows Delete in full red.** Fix: set it in `ink-variant` at rest, `danger` on hover and focus, keep the confirm step, and put 16 px between the select and Delete.

Minor:
- **Notes' title sits in the band at 32 px; Library's sits on the ground at 40 px.** Set "Notes" at 40 px on the ground, 24 px under the band, and keep the actions in the band, so every place opens the same way.
- **The reader's running heads keep today's ellipsis** (`.rhead span`). Per G3, let each half wrap (`white-space:normal`, max 50 % width) and never clamp it.
- **The 360 captures are 360×800 layouts padded to 844.** Crop them to 800 so the bar doesn't look as if it floats.
- **On the phone, while something plays,** the foot is 128 px (the 64 px bar plus the 64 px dock), against today's 64. Draw that state at 390×844 once, and consider a 56 + 56 split. The dock and Continue appear only as skeletons on the sheet.
- **Open risk: the rail will squeeze the LaTeX editor's split.** It isn't drawn. Say whether the rail hides there, as it does in the reader.

## Strengths to keep

- **A familiar shell.** A labelled rail with the current place on a blue pill, and a four-place bottom bar with icon and label. The phone header drops from 240 to 120 px, and search comes before adding, as ruled.
- **Raised tinted tiles.** Each has a 1 px edge and both controls at rest. Author and format are two spans, which fixes today's "Made Up · EP…" cut. The initial is clear of the title, as ruled.
- **A designed dark theme.** The rail and band lift 1.21 above `#110f0d`, the tiles keep their edges, the accent calms to `#97b8e0`, and the elevation runs L0 to L2 on the sheet.
- **An immersive reader.** It has no rail, and the text starts higher, so it gains lines once the page is filled.

## Heuristic scores (0-4, on the comps)

| # | Heuristic | Score | Reason |
|---|---|---|---|
| 1 | Visibility of system status | 3 | The current place, active chip and progress show; the phone theme trigger hides its state |
| 2 | Match with the real world | 3 | Library, Notes and Browse catalogs are plain names |
| 3 | User control and freedom | 3 | Back to library, Previous and Next |
| 4 | Consistency and standards | 2 | The title placement differs between Library and Notes; tiles use a ⋮ menu, notes rows inline actions |
| 5 | Error prevention | 2 | A full-red Delete sits beside the select on every row |
| 6 | Recognition rather than recall | 4 | Every place is labelled; every icon has text or a name |
| 7 | Flexibility and efficiency | 3 | The `/` hint and the page jump stay |
| 8 | Aesthetic and minimalist design | 3 | The structure is clear; the Notes cards waste height |
| 9 | Error recovery | 3 | The sheet's load-error states name the fix and offer Try again |
| 10 | Help and documentation | 3 | The empty states point to the next step |

Total: 29 of 40 (Good).

**Cognitive load:** low, with 1 of 8 checks failed. Grouping fails on Notes, where the cards stand apart. No decision point shows more than 4 options, apart from the fixed four-way theme group.

**Detector** (`detect.mjs`, run with its parser modules resolved; plain `NODE_PATH` left it degraded with `[]`):
- Library: 3 × `cramped-padding`.
- Notes: 2 × `cramped-padding`.
- Reader: `cramped-padding`, 3 × `clipped-overflow-container`, and `gpt-thin-border-wide-shadow`.
- Direction sheet: 7 × `gpt-thin-border-wide-shadow`.

All are dismissed:
- `cramped-padding` flags the root `.at` wrapper, the band (its `.inner` carries the padding) and the cover (the page and the progress rule sit flush on purpose).
- `clipped-overflow` flags the reader's deliberate `overflow:clip`. The pill's shadow still renders.
- The thin-border shadow on the reader pill is the builder's F24 dismissal: dark needs the edge. On the sheet, the specimens carry the same shadow.

Don't dilute the rail, the bottom bar or the raised tinted tiles. Buy the density back from widths, gaps and stacking, never from titles.
