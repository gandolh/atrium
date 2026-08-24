---
title: Rebrand ebook-reader → a media gallery (books + music + video)
created: 2026-07-20
status: promoted
tags: [branding, design, ia, frontend, corpus, epic]
---

> Promoted 2026-07-20 → briefs [24 (identity)](../briefs/done/24-atrium-brand.md)
> + [25 (IA + per-media cards)](../briefs/done/25-per-type-ia-and-cards.md),
> both shipped (name = **Atrium**). Remaining open items from this epic not yet
> done: PWA icon PNG regeneration, `BASE_PATH` rename decision, the copy/corpus
> sweep beyond what shipped, and the optional internal `book`/`library` +
> npm-scope vocabulary cleanup.

# Rebrand ebook-reader → a media gallery (books + music + video)

The app started as an **ebook reader** and, through briefs 21–23, quietly became
a **personal media gallery**: one library now holds books (PDF/EPUB), music
(mp3), and video (mp4/webm), each with per-user resume, plus grouping, offline
(books-only), and a Gutenberg discover page. But every *surface* still says
"ebook reader": the name, the npm scopes, the wordmark, the 📖 favicon, the PWA
manifest, the "Quiet Paper" design system, the copy ("Recent Reads", "read
anywhere"), and the book-only metaphors (paper, shelves/stacks, 2:3 covers,
music squeezed into a book tile, video rendered as a text-only tile).

This todo captures **the rebrand**: a new name in a warm/curated, media-neutral
direction, plus a design + IA evolution that treats all three media as
first-class. It's an **epic** — at promote time it should split into several
briefs (see "Suggested brief split" below), not built as one.

## Grilled decisions (2026-07-20, owner-confirmed)

1. **Name direction — warm & curated, media-neutral.** Keep the calm, literary
   *soul* but a name that isn't book-specific. Shortlist below; **exact name is
   the one remaining open decision** (see Acceptance).
2. **Design — evolve, don't pivot.** Keep the restraint, warm palette, serif
   display type, tonal depth, and the three themes. **Drop the book-only
   metaphors** (rename the "paper" system, retire shelves/stacks language,
   media-neutral icons/accents). Not a Plex-style thumbnail-forward pivot.
3. **Structure — split into separate library areas.** Books / Music / Videos
   become distinct top-level destinations (nav tabs / routes), each its own
   page — not the current single unified gallery with an in-place
   All/Books/Music/Videos filter. The existing type filter effectively
   *becomes navigation*.
4. **Cards — per-media shapes.** Books stay **2:3 portrait**, music becomes
   **square** (album art), video becomes **16:9 landscape** — the
   Plex/Jellyfin convention. Fixes the current mismatch (music centered in a
   2:3 tile; video as a typographic 2:3 tile).

## Inline research (2026-07-20)

**How mature media libraries handle mixed content:** Plex and Jellyfin both
differentiate media types primarily by **card aspect ratio** — movies/episodes
as 16:9 (or 2:3 posters), music as square album art, books as 2:3 — and by
**separate library sections** per type rather than one mixed grid. Plex reads as
"a premium streaming service" largely because artwork drives the layout and each
media type gets a shape that matches its native artwork; Jellyfin is more
utilitarian but themeable. The lesson for us: uniform 2:3 for everything is the
clearest "still an ebook reader" tell — matching shape to media is the
single highest-signal design change. Sources:
[Plex vs Jellyfin 2026](https://corelab.tech/plexvsjellyfin/),
[Jellyfin vs Plex (features/UI)](https://www.rapidseedbox.com/blog/jellyfin-vs-plex).

**General multi-media UX best practices (2025):** a **design system** is what
makes mixed content feel like one product (Spotify cited as the canonical
example — consistent tokens across very different content types); **media
players should get out of the way** once playback starts (content becomes the
focus, chrome recedes) — which matches our existing "the page is the interface"
principle and extends cleanly to audio/video; **intuitive, filter-first
navigation** so users find items without hunting. Sources:
[Mobile UI best practices 2025](https://nextnative.dev/blog/mobile-app-ui-design-best-practices),
[Media players in UI design](https://www.uinkits.com/blog-post/what-are-media-players-in-ui-design-and-how-to-design-them).

**Takeaway that shaped the grill:** keep our differentiator (quiet restraint,
typographic craft — most media apps are loud), but adopt the two things the
mature apps get right that we don't yet: **per-media card shapes** and
**per-type sections**. Both are now locked decisions above.

## The change inventory (what actually has to change)

### A. Name & brand identity (blocks much of the rest)
- **npm scope + package names:** root `package.json` (`name: "ebook-reader"`,
  the `-w @ebook-reader/*` dev script), and `@ebook-reader/{web,api,shared}` in
  all three workspace `package.json`s. Renaming the scope touches **every
  `import … from "@ebook-reader/shared"`** across the codebase (many files).
- **Wordmark:** the `ebook-reader` text in
  [AppHeader.tsx](../../apps/web/src/components/AppHeader.tsx) (home-link,
  Playfair).
- **Browser title + favicon:** `<title>ebook-reader</title>` and the inline 📖
  SVG favicon in [index.html](../../apps/web/index.html).
- **PWA manifest:** `name: "Ebook Reader"`, `short_name: "Ebooks"`, the
  book-only `description` ("upload PDFs and EPUBs, then read anywhere") in
  [vite.config.ts](../../apps/web/vite.config.ts); plus the PWA icon PNGs in
  `apps/web/public/` (apple-touch + 3 manifest icons — currently 📖-based) need
  regenerating.
- **README** (`# ebook-reader`), **PRODUCT.md** (entirely book/reading-framed
  and already stale — says "stateless, no library, no accounts", all reversed).
- **Deploy sub-path:** `BASE_PATH` is `/ebook-reader/` (see the vite.config
  comment + `.env.example`). Changing it changes the deploy URL **and** the PWA
  scope/start_url/service-worker precache — a migration concern for anyone with
  the current PWA installed. **Decision needed:** keep `/ebook-reader/` or move
  to `/<newname>/` (see open questions). *(Per the no-VPS-in-git rule, don't
  write any real host into tracked files.)*

### B. Design system — evolve "Quiet Paper" → media-neutral
- **Rename the system** ("Quiet Paper" → a media-neutral name) in
  [wiki/design.md](../wiki/design.md), the `globals.css` header comment, and D27.
- **`--paper*` tokens:** the palette is literally named for paper
  ([globals.css](../../apps/web/src/styles/globals.css) `--paper`,
  `--paper-raised`, `--paper-low`, `--paper-container`, …). Rename to a neutral
  surface family (e.g. `--surface*`) or keep the values but re-document the
  metaphor. Values can stay (warm off-white is fine for a gallery); it's the
  *name/metaphor* that's book-specific.
- **Fonts stay** (Playfair Display / Source Serif 4 / Inter) — "evolve" keeps
  the serif warmth. `body-reading` (Source Serif 4) is still correct for the
  reading pane; confirm it isn't over-applied to media chrome.
- **Icons:** the theme toggle's **book glyph** for sepia
  ([AppHeader.tsx](../../apps/web/src/components/AppHeader.tsx)) and any
  book-motif iconography → media-neutral.
- **design.md rewrite:** the "Cards (book covers)", "Book covers: 2px",
  "stands on a shelf" shadow, and Shapes sections all assume books; rewrite for
  three card shapes (see D). Update the conformance checklist + the
  `design/stitch_extracted/screen.png` visual-check reference (it's the old
  library home).

### C. Information architecture — split into per-type areas
- **New routes/nav:** Books / Music / Videos as distinct destinations (e.g.
  `/books`, `/music`, `/videos`) with nav tabs in `AppHeader`. Decide the
  **home/default** (redirect to Books? a unified landing with a cross-media
  "Continue" strip? — see open questions).
- **The type filter becomes navigation:** `TypeFilterControl`
  ([LibraryHeader.tsx](../../apps/web/src/library/LibraryHeader.tsx)) and the
  `typeFilter` pref (`library-prefs.ts`)
  are replaced by (or repurposed as) route-driven navigation. `home.tsx`
  (`filteredBooks`, `TYPE_FILTER_NOUNS`, per-filter empty states) gets
  restructured per area.
- **Grouping/sort per area:** Group-by (author/series/subject) and
  Shelves/Stacks are book-oriented; per area they should mean sensible things
  (music: artist/album; video: probably just sort). Retire "Shelves/Stacks"
  naming if it reads too booky (decision B).
- **"Continue reading" strip** ([ContinueReading.tsx](../../apps/web/src/library/ContinueReading.tsx)):
  decide unified (one cross-media resume) vs per-area, and reword ("Continue"
  covers reading + listening + watching).
- **Discover** (Gutenberg, books-only) lives under the **Books** area.
- **Upload routing:** the whole-window dropzone + header "Add" currently accept
  all types into one gallery; per-area they should default to that area's
  formats (Books → pdf/epub, Music → mp3, Video → mp4/webm) while still routing
  by detected `kind`.

### D. Per-media card shapes
- **Books:** 2:3 portrait (unchanged).
- **Music:** **square** album-art card (today it's square art *centered inside*
  a 2:3 tile in [CoverCard.tsx](../../apps/web/src/library/CoverCard.tsx) →
  make the card itself square).
- **Video:** **16:9 landscape** tile (today a typographic 2:3 fallback; no
  frame extraction stays — brief 23 — so a media-neutral 16:9 fallback with
  title + duration).
- **Grids:** each area needs a grid tuned to its shape (portrait / square /
  landscape columns) instead of the single `grid-cols-2 … lg:grid-cols-5`
  portrait grid in `home.tsx`.
- **`CoverFallback` + `CoverArt`:** per-shape variants; `--radius-cover`
  (currently 2px "bound book" look) may want a per-media value.
- Badges/duration/progress overlays already exist per-kind — re-fit to the new
  shapes.

### E. Copy & microcopy
- "Recent Reads" heading, "Browse free classics", "Your library is empty —
  upload your first book", "read anywhere" (manifest), `TYPE_FILTER_NOUNS`,
  and the CoverCard comment "a book app that cuts titles…" — all book-only.
  Reword to media-inclusive per area.

### F. Corpus & docs (LLM-owned, do last so it matches shipped reality)
- Rename across [index.md](../index.md), [routing.md](../routing.md) (title
  "Routing — ebook-reader"), [CLAUDE.md](../CLAUDE.md) (project one-liner),
  [wiki/overview.md](../wiki/overview.md), [wiki/design.md](../wiki/design.md),
  and touch points in the other wiki pages.
- **PRODUCT.md** full rewrite (Register/Users/Purpose/Brand — currently
  describes a stateless single-user *reader*).
- **decisions.md:** add a new decision recording the rebrand (name + design
  evolution + per-type IA + per-media shapes); mark **D27 revised** ("Quiet
  Paper" → new system name, metaphors neutralized). Note the naming choice so
  it isn't relitigated.
- Existing **briefs are immutable** — leave them; the new decision + status
  note carry the rename forward.

### Explicit scoping call — internal `book`/`library` nouns
The **data model** is book-nouned: the `books` table, `libraryBookSchema` /
`LibraryBook`, the `/library` routes, `use-library.ts`, etc. (brief 23
deliberately *mapped* audio/video onto the book columns —
artist→`author`, album→`series`). Renaming these to `item`/`media` is a large
internal churn with **zero user-facing benefit**. **Recommendation:** keep the
internal `book`/`library` nouns for the rebrand; scope the rebrand to
user-facing surfaces + the design system + IA. Flag as an open question if the
owner wants the code vocabulary cleaned up too (could be a separate later
brief).

## Suggested brief split (at promote time)
1. **Name & identity swap** — final name, npm scope rename, wordmark, title,
   favicon, PWA manifest + icons, README, `BASE_PATH` decision. (Keystone;
   unblocks the rest.)
2. **Design system evolution** — rename "Quiet Paper" + `--paper*` tokens,
   neutralize metaphors/icons, rewrite design.md + conformance checklist,
   refresh the visual-check screenshot.
3. **IA: per-type areas** — routes + nav tabs, filter→navigation, per-area
   grouping/sort/empty-states/upload, Continue strip, Discover under Books.
4. **Per-media card shapes** — square music, 16:9 video, per-area grids,
   fallback variants.
5. **Copy pass + corpus/PRODUCT/decisions update** — fold into the wiki, log,
   new decision, D27 revision.

(1→2→3/4 have real ordering; 3 and 4 can parallelize; 5 lands last.)

## Acceptance

Not specified yet — capture-stage. **Name is now settled: `Atrium`**
(owner-confirmed 2026-07-20 — a light-filled central space where things are
gathered; warm, architectural, media-agnostic). Everything else is settled by
the grill above. Naming knock-ons to apply in brief 1: npm scope becomes
`@atrium/{web,api,shared}`; wordmark, `<title>`, and PWA `name`/`short_name`
become "Atrium"; favicon/icons regenerate off the new brand.

**Other open questions for the promote-time grill:**
- **Deploy sub-path:** keep `/ebook-reader/` or move to `/<newname>/` (PWA
  scope/SW-precache migration cost for installed instances).
- **Home/default destination:** redirect to Books, or a unified landing with a
  cross-media "Continue" strip above the per-type areas?
- **Continue strip:** one cross-media resume, or per-area?
- **Grouping in Music/Video:** keep author/series (as artist/album) for Music;
  what, if anything, groups Video?
- **Internal vocab:** leave `book`/`library` code nouns, or clean up to
  `item`/`media` in a later brief? (Recommendation: leave.)
- **Icon set:** commission/generate a new media-neutral app icon + favicon in
  the new brand.
