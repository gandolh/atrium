---
summary: The reader experience — PDF + EPUB renderers sharing one Kindle-style frame: nav, TOC, search, themes, progress rail, resume, a paged⇄scroll mode toggle, and a shared running header.
updated: 2026-08-24
---

# Reader

The heart of the app. Two renderers (PDF, EPUB) sharing one **Kindle-style
chrome**. 100% client-side.

## Entry: the library home
The home (`/`) is not part of the reader — see [overview.md](overview.md) for
its shape and [design.md](design.md) for the Reading Room rules it follows.
What matters here: opening a card navigates to `/read` **instantly**, and the
route's hydrate hook streams `GET /library/:id/file` behind an opening screen
(cover + title + a determinate download bar, with a retry on error — brief 10)
while reading progress `PATCH`es back. Detection is still by extension/MIME
(D13), and **both formats open the reader directly** — EPUB→PDF export is a
secondary "Download as PDF" action in the EPUB toolbar (see
[conversion.md](conversion.md)).

## The reading surface
The page is the interface (PRODUCT.md). EPUB renders as a **single centered,
measure-capped column** (`spread: none`). Orientation lives at the edges and
fades with the chrome: running header (title / chapter), a footer "chapter · %"
button that opens the TOC at the current chapter, and the shared **progress
rail** (chapter ticks in locations-space, hover tooltip, click / drag / arrow
seek — one seek committed on release; brief 08, both readers mount it).
Loading is a skeleton page; TOC/search jumps crossfade via an overlay **veil** —
never opacity on the iframe's ancestors, which triggers Chromium raster
staleness.

## Renderers
- **PDF** — `react-pdf` (PDF.js): lazy per-page rendering, text layer for
  selection/search. Fixed-layout.
- **EPUB** — `react-reader` (epub.js): reflowable text, native. Reflow is the
  Kindle magic.

Both cap the column at **620px** (`max-w-measure`) and set body text in
**Newsreader** at 18/1.78. The section iframe needs its own injected
`@font-face` rules (Newsreader 400/500/600, Archivo 400/600/700, roman +
italic, via `?url`) — the parent document's `@fontsource` CSS does not cascade
into it, and registering only weight 400 makes every bold heading synthesise.
The Aa panel's family list is now a two-way **Newsreader / Archivo** face
toggle. The progress rail's drag preview runs on an **anime.js** timeline (the
one sanctioned use) and still commits exactly one seek on release.

## v1 feature set

| Feature | EPUB | PDF | Notes |
|---|---|---|---|
| Page nav (keys / click-zones / arrows) | ✅ | ✅ | core |
| Progress indicator (% / page count) | ✅ | ✅ | EPUB = accurate book-wide pages (pre-paginated, see below) |
| Scrub rail (click / drag / arrow-key seek) | ✅ | ✅ | shared `ProgressRail` (brief 08); PDF ticks from outline |
| Table of contents drawer | ✅ | ⚠️ if outline | Base UI drawer |
| Auto-hiding chrome | ✅ | ✅ | Kindle feel |
| Themes (light / sepia / dark) | ✅ full | ⚠️ invert-only | reflow vs fixed |
| Font size / family / line-spacing / margins | ✅ | ❌ | EPUB-only |
| Zoom / fit-width | ❌ | ✅ | PDF-only |
| In-book search | ✅ | ✅ | text layer (D19) |
| **Bookmarks / highlights** | ❌ | ❌ | **excluded v1** (D18, no persistence) |
| Single-page vs continuous scroll | ✅ | ✅ | layout mode |

## Format-adaptive toolbar
The chrome is shared, but the toolbar's controls swap by format:
- EPUB → font controls (size/family/spacing/margins), full themes.
- PDF → zoom/fit, invert-only "dark" hack.

Both bottom bars cluster identically (brief 12): `ReaderToolbar` is a
**`grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`** shell with three slots —
**Home** / **actions + settings gear** / **page number + progress**. The grid
(not the old `justify-between`) pins the middle cluster to its content width
between two equal side tracks, so the bar doesn't shift when the chapter label or
page-digit count changes. Side tracks are `minmax(0,1fr)` and the right slot
fills its track (no `justify-self-end`, `min-w-0 overflow-hidden`), so a long
chapter label truncates instead of overflowing onto the middle actions.
The paged⇄scroll `PageModeToggle` and the settings popover both live in the
middle actions for both formats.

## Reading modes: paged ⇄ scroll (brief 11)
A `pageMode` toggle in the bottom bar switches the current reader between
single-page-per-view and continuous vertical scroll:
- **EPUB** → **`manager: "continuous" + flow: "scrolled"`** via a `key={flow}`
  remount (reworked 2026-07-13; was `scrolled-doc`/default manager, one isolated
  section per iframe). The continuous manager stitches spine sections into one
  seamless vertical scroll + preloads the next off-screen — epub.js's canonical
  pairing; remount is required (can't swap managers live, #995). "Page N/M" → a
  %-only chip (scrolled flow has no `displayed.page`); page-map walk skipped.
  Two scroll-mode CSS pitfalls (both fixed, `isScroll`-gated): (a) **image-height
  trap** — `themeRules`' `max-height: 94vh` img cap is circular in scrolled flow
  (`vh` = the iframe's own content height) and collapses illustration pages;
  dropped in scroll mode (width-only; epub.js's `adjustImages` clamps height
  anyway). (b) **stray horizontal scrollbar** — `.epub-container` scrolls both
  axes, so classic scrollbars shrink client width below the full-width view;
  `globals.css` clips it in scroll mode (`.epub-container,.epub-view{overflow-x:
  hidden}` + `overflow-anchor:none`) plus iframe `html,body{overflow-x:hidden}`.
- **PDF** → windowed multi-page render (only pages within [-2,+3] of the top
  page mount a real canvas; the rest are aspect-sized placeholders); an
  IntersectionObserver syncs the top-of-viewport page to `currentLocation` so
  resume + the rail keep tracking. A `suppressObserverRef` guards programmatic
  jumps/resume (incl. across the async page-aspect reflow) from being
  overwritten. `PageNav` edge-bar flip buttons render **only in paged mode**;
  in scroll mode the PDF scroll container is `overflow-x: hidden` and pages are
  fit-to-width (zoom ignored) so continuous reading never scrolls sideways.

## Shared reading frame (brief 14)
Both readers now use one 3-row grid — a shared `ReaderHeader` (running
title/detail, fades with the chrome) / a centered `max-w-4xl` column / the
bottom bar — over `bg-reader-bg`, so a PDF and an EPUB sit in an identical
frame; only the page content differs. PDF header title = `file.name`, detail =
current outline section. Per-format TOC differs intentionally (EPUB docked
sidebar vs PDF overlay drawer). Enforced by design.md (D27).

## State (Zustand)
Current page/location, theme, font settings, chrome visibility, and `pageMode`
(`"paged"|"scroll"`, **persisted to localStorage**). Reading *position* resumes
per-user from the library (D24); the old `layoutMode` field was dead and was
removed (brief 11/review).

## Styling
Tailwind + Base UI (`@base-ui/react`) primitives: **Dialog** (TOC side-panel +
settings sheet — chose Dialog over the heavier swipe Drawer), **Popover**
(settings), **Slider** (font size/zoom), **Tabs** (theme picker). Base UI is
unstyled → bend toward a clean Kindle look; state via `data-*` attrs maps to
Tailwind variants.

## Implementation map (built in brief 06)
Shared, format-agnostic chrome lives in `apps/web/src/reader/chrome/`:
- **`PageNav`** — two **visible full-height edge bars** (faint fill + hairline
  border + centred chevron); clicking a bar flips, the page BODY doesn't. Paged
  only; keyboard arrows still flip. (Replaced invisible tap-zones, 2026-07-13.)
- **`ReaderToolbar`** — the toolbar shell with the **format-adaptive seam**: slots
  `leftControls` / `formatControls` / `rightControls`. Each reader supplies its
  own `formatControls` (PDF = zoom/fit/invert; EPUB = font/theme). This is the
  reuse contract — brief 07 fills the slot, doesn't fork the toolbar.
- `PageNav` (visible full-height edge bars — see above), `use-page-nav-keys`
  (Arrow/PageUp-Down/Space), `use-auto-hide-chrome` (idle-hide → Zustand
  `chromeVisible`), `ProgressIndicator`, `ProgressRail` (bottom-edge scrub strip,
  moved here from `epub/` in brief 08: hover tooltip, chapter ticks,
  pointer-capture drag with live preview + commit-on-release, touch-safe),
  `TocDrawer` (Base UI Dialog panel; entries
  carry an opaque `target` the reader resolves), `SettingsPopover`, `SliderControl`,
  `ThemePicker` (Tabs → `theme`), `use-apply-theme` (`data-theme` → `--reader-*`).
- **`search-seam.ts`** — typed STUB (`SearchProvider`/`SearchMatch`); brief 07
  implements search for both formats against it (D19).

PDF reader in `apps/web/src/reader/pdf/`: `PdfReader`, `PdfControls`,
`use-pdf-outline`. Mounts the shared `ProgressRail` (brief 08): percent =
`currentPage / numPages`, ticks from top-level outline entries, seek =
`goToPage(round(pct × numPages))`. Worker via `pdfjs-dist/build/pdf.worker.min.mjs?url` (bundled).
**PDF TOC only when the doc has an outline.** Invert-dark = CSS `invert(1)
hue-rotate(180deg)` on the canvas (fixed layout can't be re-themed).
Store fields: `theme`, `fontSettings`, `currentLocation`, `chromeVisible`,
`layoutMode`, `zoom`, `loadedFile`/`loadedFormat`.

EPUB reader in `apps/web/src/reader/epub/` (built in brief 07, reuses the shared
chrome verbatim): `EpubReader` (react-reader; loads `file.arrayBuffer()`,
`locationChanged` → Zustand CFI, paginated; hides react-reader's built-in
arrows/TOC so shared `PageNav`/`TocDrawer` drive), `EpubControls` (fills the
`formatControls` seam), `EpubSettings` (font size/family/line-spacing/margins +
ThemePicker), `use-epub-theme` (applies **full** light/sepia/dark + fonts to the
epub.js *rendition* — real reflow theming, not PDF's invert hack), `use-epub-toc`
(flatten `book.navigation.toc`), `epub-search.ts` (spine walk → `section.find`).

## EPUB book-wide page count (2026-07-07, pre-pagination)
Reflowable EPUB has no intrinsic pages, so "Page N/M" is derived. **`epub-page-map.ts`**
pre-paginates every spine item **on the reader's own rendition** (not a hidden
one — a ±1px width mismatch would jump the count at chapter boundaries, epub.js
#274) after the column width settles, reading each chapter's
`currentLocation().start.displayed.total` and building a prefix sum. Book page =
`offset[section] + displayed.page` → ticks by exactly 1, book-wide total is
exact. The walk runs **behind a full loading veil** on open (the book isn't
shown until pages are counted) and is recomputed (debounced, veil, position
preserved) on font size/family/spacing/margin change + viewport resize — the
only inputs that change visual page counts. Char-based `locations` are retained
**only** for the % rail + seek + chapter ticks (they're layout-independent, so
the rail stays stable across font changes). Superseded: the old
locations-as-page-unit counter (stepped by 2, chunk-count "total"). PDF is
unchanged (true fixed pages).

**Cost + caching (brief 16, measured 2026-07-13).** The page-map walk (~2.8 s
on a 24 MB EPUB) and `locations.generate(1000)` (~4.7 s) run in the background
*after* the reader is visible, not behind a veil. Both are now cached
session-scoped: `locations` via `save()/load()` keyed by book identity
(`name|size|lastModified`), the page-map in a bounded module-level LRU keyed by
identity + font settings + stage size (`toFixed(1)`, sub-pixel-sensitive). A
same-book re-open skips both walks (locations ~4.7 s→66 ms, page-map ~2.8 s→376
ms). The walk is skipped entirely in scroll mode (no discrete pages there).
See [performance.md](performance.md). Follow-up: durable (IndexedDB) locations
cache to survive a full reload.

## Search (built in brief 07, both formats)
Shared **`SearchPanel`** (`reader/chrome/`, right-anchored Base UI Dialog: query +
results + click-to-jump) is format-agnostic — it consumes a `SearchProvider`
(`search-seam.ts`) and reports the chosen `target` via `onJump`. Both readers mount
it with their own provider:
- **EPUB** (`epub-search.ts`): walk the spine, `section.load()` → `section.find()`
  → matches carry a CFI `target` + chapter label; jump = `rendition.display(cfi)`.
- **PDF** (`pdf-search.ts`): **search-on-demand** over the PDF.js text layer
  (`getTextContent()` per page, cached) — keeps open instant, pays cost only on
  search; matches carry page + snippet; jump = go to page. (Chosen over
  index-on-load.)
