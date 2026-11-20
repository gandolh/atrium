# atrium: two directions

Written 2026-11-12 by the art director. Repo: atrium, brief 05. The design system is "Reading Room" (D33, enforced in `corpus/wiki/design.md`). Both directions keep D33's moves: one home with kind as a filter chip, Continue as the hero, tint carries kind, playback persists in a dock, Newsreader plus Archivo, a warm dark, Notes and LaTeX as their own places. Both keep the three themes (light, sepia, dark) plus System, the guarded theme `ToggleGroup` (D61), the native sort `<select>` (D61) and the token names (`paper`, `paper-raised`, `paper-low`, `ink`, `ink-variant`, `line`, `accent`, `ink-fill`, `on-ink-fill`, `danger`, `tint-*`). Faces and the blue accent are today's, so the registry allows them. Atrium and Shelfmark stay independent apps. Nothing here may drift toward Shelfmark: no Literata, no teal, no header card over a boxed table.

## 1. Today's strengths (keep all of them)

1. Every place and control fits one header row at 1280: wordmark, search, Notes, LaTeX, Jukebox, Browse catalogs, Add, the profile and the theme switch. Kind is never an address. It's a chip with a count, and zero counts still show ("Music 0").
2. Tiles are raised, tinted cards on a plain ground. The tint says "book" without a badge. The coverless tile (glyph, the title in Newsreader, a faint large initial) looks made, not broken.
3. "Your library" in Newsreader at display size gives the page a clear head. The rule "Newsreader for what a person wrote, Archivo for what the interface says" holds everywhere.
4. One solid ink button (Add) with quiet outlined secondaries. The accent is kept for state: the progress rule, the selected theme, focus.
5. Reading progress is a 3 px accent rule along the foot of the cover, readable at a glance.
6. The four-way theme switch is in plain view, with an icon and an accessible name for each choice.

Fix these faults in both directions:
- At 390 the header takes four rows (about 240 px) before "Your library".
- "SORT BY" and the Continue head use tracked capitals (Floor 9; design.md's `label-caps`).
- Chip counts sit at 55% opacity, which fails 4.5:1.
- "Made Up · EP…" is cut off at 1280, and the dot joins two facts (Floor 10).
- The "+" is glued to "Add". Draw a plus icon and the word "Add".
- At 1280 the tile's offline and more buttons only show on hover.
- Dark tiles barely lift (tint-book on paper 1.13, paper-raised 1.07, both under 1.15).
- In sepia, muted text on the book tint is 4.26:1.
- The header is separated only by a 50% hairline.

## 2. The main screen

The library home with its shell, route `/`, in `board/shots-existing/atrium-03b/`:
- **1280:** `after-light-1280-library.png`. Dark: `after-dark-1280-library.png`. Sepia: `after-sepia-1280-library.png`.
- **390:** `after-light-390-library.png`. Dark: `after-dark-390-library.png`. Sepia: `after-sepia-390-library.png`.

The 390 shots are 390×800 viewports. The 1280 shot of the hovered tile with its menu open is `after-light-1280-covermenu.png`, a state reference only.

## 3. The content fixture (word for word from the shot and `apps/web/src`)

The library is small on purpose: two tiles, no Continue strip (Field notes is finished, so `pickResumeBooks` returns nothing), no dock (nothing is playing), no storage caption. Don't add rows, a Continue card or a dock to the comp. Continue and the dock get one line each in every direction (where they go). Draw them only in the Direction sheet's States strip.

- **Header.** Wordmark `Atrium`. Search field with placeholder `Search title, author, series…` and a `/` key hint. Links `Notes`, `LaTeX`, `Jukebox`. Secondary button `Browse catalogs`. Primary button `Add` with a plus icon. Profile switcher: a tint swatch, `Default`, a chevron, `aria-label="Switch profile"`. Theme switch with four choices, named `Light theme`, `Warm theme`, `Dark theme`, `System theme`. Light is chosen in the light comp, Dark in the dark one.
- **Page.** Heading `Your library`. Chips in this order: `All 2` (active), `Books 2`, `Music 0`, `Video 0`. Then `Sort by` with a select showing `Recent`.
- **Tile 1.** `Field notes`, format `PDF`, no author, tint-book. The cover is a white PDF page. Draw it as a sheet with two small headings, `1 Welcome` and `2 What you can write today`, and grey bars for the body lines. Invent no sentences. The progress rule runs the full width (100%) at the cover's foot.
- **Tile 2.** `A Small Tale`, author `Made Up`, format `EPUB`, tint-book, coverless: the book glyph, `A Small Tale` in Newsreader, and a large faint `A` bleeding off the bottom-left corner (D42).
- **Tile controls.** Both tiles show both controls at rest, in both widths (today's phone rule, now on desktop too): the offline button top-left (`Save for offline reading`) and the more button (`More actions for A Small Tale`, `More actions for Field notes`).
- **Author and format.** Two spans, never joined by a dot. Each direction says how to set them.

States for the Direction sheet: the empty library (`Nothing here yet`, the dropzone, `Browse catalogs`), the filtered empty (`No music yet`, `Nothing in your library matches this filter.`), the load error (`Couldn't load your library`, `The API may be offline. Start it with npm run dev and refresh.`), the loading skeleton (static, no shimmer).

## 4. Directions

### A. Reading Room, settled (Evolve today)
- **Idea:** today's home, with a header that reads as its own surface, stronger kind tints, and a phone header that fits in three rows.
- **Skeleton:** today's.
  - **1280.** The header is a full-width `paper-raised` band with a 1 px `line` bottom edge, holding today's items in today's order, inside the 1152 px container (32 px gutters). Below the band, in order: the Continue slot (absent here), `Your library`, then one toolbar row with the chips on the left and `Sort by` on the right. The grid keeps 2 / 4 / 6 columns. Tiles are raised tint cards with a 1 px `line` edge and the L1 shadow. The caption sits under the cover: title, author on line 2, format on line 3, both `ink-variant`, so nothing truncates.
  - **390.** The header has three rows:
    1. the wordmark, the profile switcher, and a theme button whose popover holds the same guarded four-way `ToggleGroup`;
    2. the search field, full width;
    3. `Notes`, `LaTeX`, `Jukebox`, `Browse catalogs` as links.

    `Add` moves to the right end of the `Your library` row. The grid has 2 columns. The dock stays a full-width bar at the foot.
- **Type:** Newsreader 500 for `Your library` (44/48 at 1280, 34/40 at 390, -0.02em) and the coverless title (18/24). Newsreader 600 for the wordmark (24/28). Archivo for the rest:
  - 14/20 at 500 for nav, buttons, chips and `Sort by` (sentence case);
  - 14/20 at 600 for tile titles;
  - 13/18 at 400 for author and format;
  - 16/24 body, and tabular figures on every count.
- **Palette** (light / dark):
  - Surfaces: paper `#f3f0ea` / `#13120f`; paper-raised `#fffdf9` / `#23211c`; paper-low `#ebe6dd` / `#0d0c0a`.
  - Text: ink `#1c1a16` / `#ede8df`; ink-variant `#5f594f` / `#a69e92`.
  - Edges: line `#d4ccbf` / `#3b362f`; outline (fields) `#8b8376` / `#7b7368`.
  - Accent and buttons: accent `#2b5185` / `#97b8e0`; ink-fill `#26231f` / `#ede8df` with on-ink-fill `#faf8f4` / `#191712`; danger `#a8281e` / `#f0a097`.
  - Tints, a little more chroma than today: book `#ebe1cd` / `#2c2519`; music `#eedcdf` / `#2d2024`; video `#dbe4ee` / `#1d2631`; note `#d9e8dc` / `#1c2a21`. The closest pair moves from 0.018 to 0.029 apart in OKLab.
  - Sepia keeps today's values, except ink-variant goes from `#6b5b42` to `#5e4f38` (5.14 on the book tint `#ddcfaf`) and every raised surface gets its `line` edge. Sepia overrides only `tint-book` (`#ddcfaf`) and takes the new music, video and note tints (muted text on them 4.98 or more). `paper-container` and `line-soft` derive from `paper-low` and `line`. Sketch light and dark only.
  - Pre-checked with WCAG 2 luminance, light / dark:
    - ink on paper: 15.3 / 15.4;
    - ink-variant on paper: 6.1 / 7.1;
    - ink-variant on the tints: 5.26 or more / 5.65 or more;
    - accent on paper-raised: 7.9 / 7.85;
    - outline on paper: 3.3 / 4.0;
    - raised on paper: 1.12 / 1.16;
    - tints on paper: 1.12-1.16 / 1.20-1.25;
    - line on paper: 1.40 / 1.57.

    Re-run `contrast.mjs`.
- **Signature:** the tint does the talking. A mixed grid reads by kind with every badge stripped, and the 3 px accent progress rule sits on the cover's foot.
- **Reference:** `notion`, for pastel-tinted cards that carry a category. Nothing of its palette.
- **Reopens:**
  - design.md's `label-caps` role goes, with no tracked capitals anywhere.
  - The tint values gain chroma. D42 calls a chroma change a D33 change, so flag it as a revision of D33's values. The move itself stays.
  - The theme switch moves into a popover at 390 only.
  - The wordmark keeps today's accent: it is a link to `/`, which design.md's accent rule allows.

### B. Rail and reading table
- **Idea:** the places move into a labelled left rail, so the library owns the whole top of the page, and on the phone a bottom bar replaces the four-row header.
- **Skeleton:**
  - **1280, the rail.** A 232 px left rail, full height and sticky: `paper-raised` with a 1 px `line` right edge. Top: the wordmark. Then the places as a list: `Library` (the current one, on `place-current`), `Notes`, `LaTeX`, `Jukebox`. A divider, then `Browse catalogs`. At the rail's foot: the profile switcher, and under it the four-way theme switch, full width.
  - **1280, the main column.** Max 1000 px, 32 px gutters. It opens with a toolbar band on `paper-raised` (1 px `line` bottom edge) holding the search field (max 420 px) on the left and `Add` on the right. Below the band: the Continue slot (absent here), `Your library`, then the chips with `Sort by` on the right. The grid has 5 columns of at least 168 px.
  - **1280, the tiles.** Tint cards on the ground, each with a 1 px `line` edge (B's light tints sit 1.06-1.10 on its ground, so the edge is required) and the L1 shadow. No panel wraps the grid, so there's never a card inside a card. The caption: title, then author and format on one line as two spans with a 12 px gap, wrapping rather than truncating.
  - **390.** A raised top bar holds the wordmark, the profile switcher and the theme button (a popover with the guarded `ToggleGroup`). Below it: `Your library`, then a row with `Browse catalogs` (secondary) and `Add` (primary), half width each and 48 px tall. Then the search at full width, the chips, `Sort by`, and the 2-column grid. A bottom navigation bar, 64 px plus the gesture inset, holds `Library`, `Notes`, `LaTeX`, `Jukebox`, each with an icon and a label. The current one is in accent.
  - **The dock.** It stays a full-width bar at the foot of the app. At 1280 it runs under both the rail and the main column. At 390 it stacks directly above the bottom bar, and content is padded by both heights.
  - **Kinds stay chips.** They never enter the rail or the bar (D33 move 1).
  - **Not satchel's rail.** Satchel has a 72 px icon rail beside a list pane. B's rail is 232 px with text labels and no list pane, and the grid sits right beside it.
- **Type:** the same faces, a different scale.
  - Newsreader 500 for `Your library` (40/44 at 1280, 32/38 at 390) and the coverless title. Newsreader 600 for the wordmark (26/30) at the head of the rail.
  - Archivo: rail labels 15/20 at 500 (600 for the current one); everything else follows A's Archivo scale.
- **Palette** (light / dark). The ground sits a step deeper so the rail and the toolbar band stand off it.
  - Surfaces: paper `#eeeae2` / `#110f0d`; paper-raised `#fdfbf7` / `#25221d`; paper-low `#e6e0d6` / `#0c0b09`.
  - Text: ink `#1c1a16` / `#ede8df`; ink-variant `#5f594f` / `#a69e92`.
  - Edges: line `#d0c7b9` / `#3d3831`; outline `#887f72` / `#7b7368`.
  - Accent and buttons: accent `#2b5185` / `#97b8e0`; a new token `place-current` (the current place's fill; `accent-soft` already names a lighter accent in `globals.css`) `#e6ecf5` / `#2a3442`; ink-fill `#26231f` / `#ede8df` with on-ink-fill `#faf8f4` / `#191712`; danger `#a8281e` / `#f0a097`. The tints are A's.
  - Sepia keeps today's values, with A's ink-variant fix and place-current `#ecdcc4` (accent on it 5.27). Sketch light and dark only.
  - Pre-checked with WCAG 2 luminance, light / dark:
    - raised on paper: 1.16 / 1.21;
    - tints on paper: 1.06-1.10 (edge required) / 1.22-1.28;
    - line on paper: 1.39 / 1.65;
    - ink-variant on paper: 5.8 / 7.2;
    - ink-variant on the tints: 5.26 or more / 5.65 or more;
    - accent on place-current: 6.75 / 6.14;
    - outline on paper: 3.3 / 4.1;
    - outline on paper-raised (the search on the band): 3.8 / 3.4.
- **Signature:** tinted place tiles. Each place in the rail and the bottom bar carries its icon on a small square of its own tint:
  - Library: a 2×2 of the four kind tints;
  - Notes: tint-note, as the notes list's icon already does today;
  - Jukebox: tint-music;
  - LaTeX: paper-low.

  The way the grid says "kind" also says "place".
- **Reference:** `mintlify`, for a labelled sidebar beside a calm reading column. Nothing of its palette or type.
- **Reopens:**
  - A's three (`label-caps`, tint chroma, the theme popover at 390).
  - The shell. AppHeader's one-row header, which design.md's comps and the AppHeader record describe, becomes a rail at 1280 and a top bar plus bottom bar at 390. Flag it as a revised record, not a decision, since no D-entry fixes the header.
  - PRODUCT.md principle 1 (prefer summoned over persistent UI) and D33 move 1's "no tabs". The rail and the bar hold only today's header links (Notes, LaTeX, Jukebox, Browse catalogs) plus home, and kinds stay chips, so the move is read as kept. Flag both so the owner decides.
  - New copy: `Library` as a place name, taken from the home section's existing `aria-label="Library"`. Put it in a Decision sticky.

## 5. Registry lines

| atrium (A) | Reading Room, settled | Newsreader (today's) | Archivo (today's) | faded-ink blue (today's) | a raised header band with every place and control; the library title; a chip and sort row; a grid of tinted cards with captions; full-width dock |
| atrium (B) | Rail and reading table | Newsreader (today's) | Archivo (today's) | faded-ink blue (today's) | a 232 px labelled rail with tinted place tiles, profile and theme at its foot; a raised toolbar band (search, Add) over the title, chips and a 5-column tinted grid; phone top bar plus a four-place bottom bar with the dock above it (labelled, no list pane, unlike satchel's icon rail) |
