---
summary: The enforced "Reading Room" visual language (D33, revised by D63 as "Rail and reading table") — the rail and bottom bar shell, warm neutrals, four stronger kind tints, the Newsreader/Archivo type ladder, radii, motion rules, and the frontend conformance checklist.
updated: 2026-11-13
---

# Design — "Reading Room"

The single source of truth for the app's **visual language**. Every `apps/web`
change must conform. Adopted 2026-08-24 (D33); replaces **Quiet Paper /
Quiet Gallery** (D27), the book-shaped system the product outgrew when it became
a gallery of books, records, film and notebooks.

Rendered comps for every surface — home, reader, notes, phone, empty state —
live in the design study:
<https://claude.ai/code/artifact/3c194acd-f8fd-431b-964e-f74edb85a8d3>.
This page is authoritative where the two disagree. **2026-11-13 (D63):** the owner approved
the "Rail and reading table" direction on the estate redesign board; this page records what shipped.

> The `--reader-*` theme layer is **unchanged as architecture** — three themes
> (light / sepia / dark) applied via `data-theme`, driving both the reading
> surface and the chrome. Reading Room revalues its light and dark palettes onto
> a warm axis; it does not remove the layer. **System** (2026-11-11, D61) is a
> fourth *choice*, not a fourth theme: it resolves to light or dark.

## The premise
Four structural moves carry the system. A decision that serves none of them is
decoration.

1. **One home.** Kind is a filter chip with a count, not an address. ~~No tabs~~ **REVISED
   2026-11-13 → D63:** the shell is persistent: a 232 px rail at 1280 (Library, Notes, LaTeX,
   Jukebox, Browse catalogs; the profile and the theme at its foot) and a 64 px bottom bar of
   four places on a phone. The reader keeps its summoned chrome and has neither; the LaTeX
   editor hides the rail.
2. **Continue is the hero.** What you left open leads the page, in *time
   remaining*, not percent.
3. **Tint carries kind.** Each media kind owns a paper tone; a mixed grid reads
   without badges.
4. **Playback persists.** A dock at the foot of the app survives navigation.

## Colours
Warm neutrals, one faded-ink accent, four kind tints. The ground is a warm
off-white with a faint grey cast — paper that has been in a room, not bleached
stock. **Accent means state only** (progress, active, focus, links); it never
fills a button. The solid button is ink, not colour.

### Light (canonical)
| Token | Hex | Use |
|---|---|---|
| `paper` | `#eeeae2` | Page ground |
| `paper-raised` | `#fdfbf7` | Rail, band, bars, cards, sheets |
| `paper-low` | `#e6e0d6` | Recessed wells, hover |
| `paper-container` | `#e4ded3` | Fallback fills (revalued onto the new ground) |
| `ink` | `#1c1a16` | Primary text |
| `ink-variant` | `#5f594f` | Secondary text |
| `line` / `line-soft` | `#d0c7b9` | Borders and hairlines (one value) |
| `outline` | `#887f72` | The 3:1 edge of fields, chips, secondary buttons, search |
| `accent` | `#2b5185` | State only |
| `place-current` / `on-place-current` | `#e6ecf5` / `#2b5185` | The current place in the rail and bar |
| `ink-fill` / `ink-fill-hover` / `on-ink-fill` | `#26231f` / `#403b34` / `#faf8f4` | Solid button |
| `danger` | `#a8281e` | Delete, errors |
| `progress` | `#2b5185` | The 3px rule at a cover's foot, the reader's rule |
| `pdf-page` / `pdf-ink` | `#fdfcf9` / `#3a3832` | A PDF cover's paper and type |

### Kind tints (the one decorative move)
| Token | Light | Dark | Kind |
|---|---|---|---|
| `tint-book` | `#ebe1cd` | `#2c2519` | Books (PDF/EPUB) |
| `tint-music` | `#eedcdf` | `#2d2024` | Music |
| `tint-video` | `#dbe4ee` | `#1d2631` | Video |
| `tint-note` | `#d9e8dc` | `#1c2a21` | Notes |

The tints gained chroma in D63: the closest pair is **0.029** apart in OKLab (0.030 dark and
sepia), up from 0.018. `tile-initial` (the faint coverless letter) is `#dccfb2` light, `#3b3224` dark.

**Coverless tiles (D42, coverless tiles of 2026-08-29).** A tile with no cover art — a video that
won't decode, a track never played — carries a **large title initial** in
Newsreader, in `tile-initial`, smaller than it was and sitting in a bottom corner clear of
the title (D63). Its **size and corner vary** by a deterministic hash of the *title* (so
the same book always looks the same, and two uploads of one title match), six
variants in all, so a large collection of same-kind coverless items doesn't
render as a wall of identical rectangles.

**Both axes sit on the letterform; the ground is never touched.** That is a
correction — D42 first put the second axis on the tile's own lightness, and it
was measured and rejected. The old tints were near-achromatic greys, so the kind signal
was small (0.0194 apart in OKLab, against **0.1871** for a 20% lightness ladder: ten times
that, so the grid would read by lightness, not kind). D63's stronger tints raise it to 0.029;
the rule below stands.
No mix value works; by 4% the spread still beat the kind signal while the
steps had already fallen below visibility. **The rule: vary a coverless tile's
foreground, never its ground.**

### Dark (warm, not neutral)
`paper #110f0d` · `paper-raised #25221d` · `paper-low #0c0b09` ·
`paper-container #2f2b25` · `ink #ede8df` · `ink-variant #a69e92` ·
`line #3d3831` · `outline #7b7368` · `accent #97b8e0` · `place-current #2a3442` ·
`ink-fill #ede8df` / `on-ink-fill #191712` · `danger #f0a097` · `progress #4f7fc0`.

**Why warm dark:** a neutral `#181818` under warm cover art makes every cover
look sour. Both grounds sit on the same warm axis so artwork reads true in
either, and the two themes stay recognisably one system.

The theme switch (Light, Sepia, Dark, System; D61): [theme-switch.md](theme-switch.md).

### Sepia
Today's ground, ink and accent (`#f4ecd8`, `#3b2f1e`, `#92400e`) with the D63 changes: `ink-variant`
`#5e4f38` (the contrast fix), `line` `#d9c9a3`, `outline` `#8f7548`, the new tints (`tint-book`
`#ddcfaf`), `place-current` `#ecdcc4`. It is drawn on the direction sheet only; the reader's theme
picker is not redesigned.

## Typography
One rule decides every type choice: **Newsreader for anything a person wrote,
Archivo for anything the interface says.** Playfair Display, Source Serif 4 and
Inter all retire.

| Role | Family | Size / line-height | Weight | Notes |
|---|---|---|---|---|
| `display` | **Newsreader** | 40 / 44, `-.02em` (32 / 38 on a phone) | 500 | Page title |
| `wordmark` | **Newsreader** | 24 / 28 | 600 | The wordmark; section heads |
| `title` | **Newsreader** | 18 / 24 | 500 | Coverless tile titles, empty-state titles |
| `body-reading` | **Newsreader** | 18 / 1.78 | 400 | The reading pane |
| `body` | **Archivo** | 16 / 24 | 400–600 | Place names, note and project titles |
| `ui` | **Archivo** | 14 / 20 | 500 | Card titles (600), buttons, chips, fields |
| `micro` | **Archivo** | 12 / 16 | 500 | Hints, the key chip, small meta |
| `numeric` | **Archivo** | inherits | 500 | **`tabular-nums` always** |
| `code` | **platform monospace** | inherits | 400 | LaTeX source pane, and nothing else |
| `tile-initial` | **Newsreader** | 60 / 72 / 96, 1, no tracking override | 500 | Coverless tile's decorative title-initial watermark (D42, D63) — `aria-hidden`, `text-tile-initial`; the three sizes are two of its six hashed variants' axes |

**The one exception to the two-family rule** (added 2026-08-27. The
LaTeX editor's source pane sets in `--font-code`: the *platform's own* monospace
stack, not a third brand face — nothing is downloaded and the payload argument
below is untouched. It exists because source is the one text in Atrium where
character alignment is semantic: `\begin{tabular}` set proportionally is
unreadable, and the caret stops landing where the eye is. **It applies to the
source pane only** — the diagnostics panel, the file tree and every label around
the editor are still `font-ui`. Any other use is drift, not precedent.

**No tracked capitals.** `label-caps` is gone (D63): every label is sentence case at 12 px or more.

**Numbers line up.** Every figure the interface reports — progress, duration,
size, page count, counts — sets `font-variant-numeric: tabular-nums`.

**Fonts stay self-hosted** (no CDN). Load Newsreader (400, 500, 600 + italic
400) and Archivo (500, 600, 700). Dropping from three families to two is a
payload *reduction*.

## Structure
| Token | Value | Applies to |
|---|---|---|
| Grid | `8px` base, `4px` micro | Layout rhythm; 4px for type alignment only |
| Page margin | `16px` mobile / `26px` desktop | Shell padding — tighter than Quiet Paper's 64px; density is the point |
| Gutter | `14px` | Grid and shelf gaps |
| Reading measure | `620px` | Reader column cap (~68 characters) |
| Radius card | `12px` | Buttons, fields, the rail's links, menus, popovers |
| Radius tile | `16px` | Tiles and the Notes list card |
| Radius cover | `8px` | All artwork — structural, bound |
| Radius chip | `20px` | Filter chips, and the bottom bar's current-place pill |
| Radius round | `full` | **Genuinely circular affordances only** — the `ScrubTrack` rail + handle, the note editor's ink swatches and nib-size dots. These are dots and tracks, not cards; a square colour swatch reads as a tile. Not a fourth general radius, and never on a container. |
| Elevation L1 | 1px `line` + a per-theme shadow (`--elev-1`) | The rail, the band, tiles, the list card |
| Elevation float | `--elev-2` | Menus, popovers, dialogs, the reader's pill |
| Elevation bar | `--elev-bar` | The phone's top and bottom bars |
| Shell | rail `232px`, bar `64px` (+ inset), page cap `1152px` | `--width-rail`, `--height-bar`, `--container-page` |
| Elevation lift | `translateY(-4px)` + `0 14px 30px -18px` | Card hover only |
| Progress | `3px` | Cover bars and the reader rail |

**Depth is tonal**, not shadowy: layered surfaces and hairlines first, a soft
shadow only on cards and the Aa panel. Modals keep the `12px` backdrop blur.

## Components and motion
The rail, the bottom bar, the band, buttons, chips, tiles, the Notes list, the dock, the reader's chrome,
inputs and the motion rules are in [design-components.md](design-components.md).

## Conformance checklist (enforced — see CLAUDE.md)
Any `apps/web` change must, before it's considered done:
- [ ] **Tokens only** — no raw hex in components; colour resolves through
      `globals.css`.
- [ ] **Newsreader wrote it, Archivo says it** — no third family, no ad-hoc
      sizes outside the scale above.
- [ ] **Numbers are tabular** — every reported figure.
- [ ] **Accent means state** — never a button fill, never decoration.
- [ ] **Radii hold** — covers 8, cards and controls 12, tiles and the list card
      16, chips and the phone's current-place pill 20/`full`, `full` otherwise only on
      genuinely circular affordances (scrub track/handle, ink swatches, nib
      dots), nothing else.
- [ ] **The shell holds** — the rail at 1280, the bottom bar on a phone, neither on
      the reader, no rail in the LaTeX editor; nothing hides under a bar or the dock.
- [ ] **Sentence case, 12 px or more** — no tracked capitals, no text under 12 px.
- [ ] **Nothing truncates** a title, author or note.
- [ ] **Contrast** — `npm run check:contrast` clears 4.5:1 (3:1 for UI parts) in
      light, sepia and dark.
- [ ] **Three themes checked**: light, sepia, dark, *including artwork*; System by flipping the system setting
      (the Playwright theme spec does both).
- [ ] **Stacking from tokens**: `z-raised` to `z-toast`, never a number.
- [ ] **Base UI behind `components/ui/`**: form dialogs ignore an outside tap; side panels are drawers; a saved choice is a guarded toggle group.
- [ ] **Motion degrades** — a `prefers-reduced-motion` path exists.
- [ ] **Kind reads without labels** — strip every badge and the tinted grid is
      still legible by kind. If it isn't, the tints are too weak.
