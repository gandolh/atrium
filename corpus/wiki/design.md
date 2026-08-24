---
summary: The enforced "Reading Room" visual language (D33) — warm neutrals, four kind tints, the Newsreader/Archivo type split, motion rules, and the frontend conformance checklist. Replaces Quiet Paper.
updated: 2026-08-24
---

# Design — "Reading Room"

The single source of truth for the app's **visual language**. Every `apps/web`
change must conform. Adopted 2026-08-24 (D33); replaces **Quiet Paper /
Quiet Gallery** (D27), the book-shaped system the product outgrew when it became
a gallery of books, records, film and notebooks.

Rendered comps for every surface — home, reader, notes, phone, empty state —
live in the design study:
<https://claude.ai/code/artifact/3c194acd-f8fd-431b-964e-f74edb85a8d3>.
This page is authoritative where the two disagree.

> The `--reader-*` theme layer is **unchanged as architecture** — three themes
> (light / sepia / dark) applied via `data-theme`, driving both the reading
> surface and the chrome. Reading Room revalues its light and dark palettes onto
> a warm axis; it does not remove the layer.

## The premise
Four structural moves carry the system. A decision that serves none of them is
decoration.

1. **One home, no tabs.** Kind is a filter chip with a count, not an address.
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
| `paper` | `#f7f5f2` | Page ground |
| `paper-raised` | `#fffefd` | Cards, header, sheets |
| `paper-low` | `#f1eee9` | Recessed wells |
| `paper-container` | `#e9e4dc` | Progress track, fallback tile |
| `ink` | `#1a1917` | Primary text |
| `ink-variant` | `#6c665e` | Secondary text |
| `line` | `#ddd7cc` | Borders |
| `line-soft` | `#e9e4dc` | Hairlines |
| `accent` | `#2f5486` | State only |
| `ink-fill` | `#2b2926` | Solid button |
| `on-ink-fill` | `#faf8f5` | Text on the ink button |

### Kind tints (the one decorative move)
| Token | Light | Dark | Kind |
|---|---|---|---|
| `tint-book` | `#efe9dd` | `#241f16` | Books (PDF/EPUB) |
| `tint-music` | `#f1e6e8` | `#241a1d` | Music |
| `tint-video` | `#e4ebf1` | `#171f28` | Video |
| `tint-note` | `#e4eee7` | `#16221b` | Notes |

### Dark (warm, not neutral)
`paper #141310` · `paper-raised #1c1a17` · `paper-low #100f0d` ·
`paper-container #24211d` · `ink #ece7de` · `ink-variant #948d82` ·
`line #302c26` · `accent #8fb3dd` · `ink-fill #ece7de` / `on-ink-fill #17150f`.

**Why warm dark:** a neutral `#181818` under warm cover art makes every cover
look sour. Both grounds sit on the same warm axis so artwork reads true in
either, and the two themes stay recognisably one system.

### Sepia
Unchanged from the previous system (`#f4ecd8` ground, `#3b2f1e` ink,
`#92400e` accent) — it was already on the warm axis.

## Typography
One rule decides every type choice: **Newsreader for anything a person wrote,
Archivo for anything the interface says.** Playfair Display, Source Serif 4 and
Inter all retire.

| Role | Family | Size / line-height | Weight | Notes |
|---|---|---|---|---|
| `display` | **Newsreader** | 44 / 1.05, `-.03em` | 500 | Page greeting |
| `section` | **Newsreader** | 27 / 1.2, `-.02em` | 500 | Section heads |
| `body-reading` | **Newsreader** | 18 / 1.78 | 400 | The reading pane |
| `card-title` | **Archivo** | 14 / 1.25, `-.01em` | 600 | Card + row titles |
| `label-ui` | **Archivo** | 13.5 / 1.4 | 500 | Nav, buttons, settings |
| `label-caps` | **Archivo** | 10 / 1.6, `.15em` | 600 | Chips, eyebrows (uppercase) |
| `numeric` | **Archivo** | inherits | 500 | **`tabular-nums` always** |

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
| Radius default | `4px` | Cards, tiles, buttons, inputs |
| Radius cover | `2px` | All artwork — structural, bound |
| Radius chip | `20px` | Filter chips **only** — the single pill in the system |
| Radius scrub | `full` (pill) | `ScrubTrack`'s rail + handle **only** — the shape a circular scrub affordance needs; not a fourth general radius |
| Elevation L1 | 1px `line` + `0 4px 10px -5px` | Cards at rest |
| Elevation lift | `translateY(-4px)` + `0 14px 30px -18px` | Card hover only |
| Progress | `3px` | Cover bars and the reader rail |

**Depth is tonal**, not shadowy: layered surfaces and hairlines first, a soft
shadow only on cards and the Aa panel. Modals keep the `12px` backdrop blur.

## Components
- **Buttons — primary:** solid `ink-fill`, `on-ink-fill` text, 4px radius.
- **Buttons — secondary:** 1px `line` outline, transparent fill.
- **Filter chips:** 20px radius, `line` border on `paper-raised`; active chip
  inverts to `ink-fill`. Count sets in Archivo tabular at 55% opacity.
- **Tiles:** `tint-*` ground by kind, 1px `line-soft`, 4px radius, artwork at
  2px. Book 2:3, music 1:1, video 16:9 (kept from brief 25).
- **Resume cards:** artwork + title + source + **time remaining** + a 3px bar.
- **Player dock:** full-width, `paper-raised`, 1px top `line`; artwork, title,
  transport, scrub track, tabular times. Survives navigation.
- **Reader chrome:** running header (title / chapter), footer `chapter · %`,
  and the scrubbable rail with chapter ticks. All fade on idle.
- **Aa panel:** theme swatches drawn as miniature pages, face toggle, A−/A+.
- **Inputs:** 1px `line`, 4px radius; border turns `accent` on focus.
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

## Conformance checklist (enforced — see ../CLAUDE.md)
Any `apps/web` change must, before it's considered done:
- [ ] **Tokens only** — no raw hex in components; colour resolves through
      `globals.css`.
- [ ] **Newsreader wrote it, Archivo says it** — no third family, no ad-hoc
      sizes outside the scale above.
- [ ] **Numbers are tabular** — every reported figure.
- [ ] **Accent means state** — never a button fill, never decoration.
- [ ] **Radii hold** — 4px default, 2px artwork, 20px chips, full on the scrub
      track/handle only, nothing else.
- [ ] **Three themes checked** — light, sepia, dark, *including artwork*.
- [ ] **Motion degrades** — a `prefers-reduced-motion` path exists.
- [ ] **Kind reads without labels** — strip every badge and the tinted grid is
      still legible by kind. If it isn't, the tints are too weak.
