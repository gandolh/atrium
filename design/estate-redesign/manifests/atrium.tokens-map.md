# Atrium tokens: board role to app token

Mechanism: the app's own raw custom properties on `:root`, `[data-theme="sepia"]` and `[data-theme="dark"]`, exposed to Tailwind through `@theme static inline` in `globals.css`. The file `atrium.tokens.css` replaces the gallery palette, radius, shadow and type groups and adds the new names; z-index, motion, layout rhythm, font stacks, the code palette and the note-sheet palette stay. Light and dark come from the board; sepia is today's with the ink-variant fix and the new kind tints.

## Renamed or remapped (board role to app token)
- paper, paper-raised, paper-low, ink, ink-variant, line, accent, danger, ink-fill, on-ink-fill, tint-book|music|video|note: same names, new values
- line: also feeds `line-soft` (the design has one hairline, so both carry the same value)
- initial (the faint coverless letter) -> `tile-initial`
- focus -> `accent` (the ring already uses the accent)
- radii: cover 8 -> `radius-cover` (was 2); control 12 -> `radius-card` (was 4); chips stay `radius-chip`
- shadows: shadow-1 -> `shadow-l1`; the board's raw values live in `--elev-1|2|bar` so they can differ per theme
- type: the board's six sizes -> new `text-*` (display 40/44, wordmark 24/28, title 18/24, body 16/24, ui 14/20, micro 12/16); the font stacks are unchanged
- reading themes: `theme-light-*` and `theme-dark-*` take the library's new ground, ink, surface, line and accent so the reader and the shell share one palette; `theme-sepia-*` is unchanged

## New tokens (component that needs them)
- `place-current`, `on-place-current`: the current place in the rail and on the bottom bar
- `outline`: fields, chips, secondary buttons, the search box (3:1 edges the app drew in `line-soft` before)
- `ink-fill-hover`: the Add button under the pointer
- `progress`: the 3 px rule at a cover's foot (a lighter blue in dark, so it holds 3:1 on the page)
- `pdf-page`, `pdf-ink`: the PDF cover's paper and type, fixed in every theme except dark's softer paper
- `tile-initial`: the faint letter on a coverless tile
- `radius-tile`: tiles and the list card
- `shadow-float`, `shadow-bar`: menus and the reader pill; the phone bars
- `--text-display-phone`: the title at 32/38 on a phone
- `width-rail` 232 px, `height-bar` 64 px, `container-page` 1152 px: the shell's sizes

## Derived, not drawn on the board (check in the code brief)
- `paper-container`, `paper-container-high`: revalued to sit on the new ground (light #e4ded3 and #d9d2c5, dark #2f2b25 and #38332c)
- `accent-soft`, `on-accent`, `danger-soft`: keep today's values

## App tokens the design no longer uses (keep or drop is the code brief's call)
- `line-soft` as a separate value (it now equals `line`)
- `radius-card` at 4 px
- `shadow-lift` keeps its hover role and is not redrawn
- label-caps and the 10 px chip text: no tracked capitals remain
