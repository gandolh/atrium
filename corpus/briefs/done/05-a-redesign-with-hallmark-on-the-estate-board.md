# Task 05: A redesign with Hallmark, on the estate board

**Depends on:**

- In Atrium: [brief 03](../done/03-base-ui-by-the-conventions.md), which puts the Base UI wrappers in `components/ui/`, the z-index tokens in `@theme`, and the Light / Dark / System switch on `data-theme`. A redesign is then mostly a new token set and layout. Brief 02's formatter and lint run on every redesign commit.
- In the owner's skills library:
  - brief 24, which vendors Hallmark as the design skill and adopts taste-skill 2.5's ideas (palettes and type dealt by trade, its copy layer);
  - the estate redesign board: one artifact with a page per app, owned by the skills library.
- The owner's answer of 2026-11-10 (Q39): no bake-off; Hallmark redesigns every web UI, keeping what is useful from taste-skill 2.5, and the owner approves each app on the board before any code changes.

**Runs before:** nothing. **Runs after:** 02 and 03, the redesign last. Brief 04 is server-only and does not block it.

**Before you start:** run `brief-board guide` ([CLAUDE.md](../../../CLAUDE.md)).

## Context

Atrium is a personal cloud space (D36): a library of books, music and video, three readers' worth of reading surface, Notes and a LaTeX editor, behind profiles and an account. One design system governs all of it, "Reading Room" (D33), and [wiki/design.md](../../wiki/design.md) is its **enforced** source of truth with a conformance checklist. This brief redesigns inside that system. It is the largest web UI in the estate, so its proposal is several pages on the board, one per area below.

### The screens (read 2026-11-10, `apps/web/src/router.tsx`)

| Area | Route | Files |
|---|---|---|
| The shell: the header, navigation, the profile switcher, the persistent player dock | every page | `routes/root-layout.tsx`, `components/AppHeader.tsx`, `profiles/ProfileSwitcher.tsx`, `player/PlayerDock.tsx` |
| The library: Continue (the hero), the kind filter chips, the cover grid, the Look up dialog, uploads | `/`, and `/books`, `/music`, `/videos` | `library/LibraryHome.tsx`, `ContinueReading.tsx`, `CoverCard.tsx`, `LibraryHeader.tsx`, `LookupDialog.tsx`, `UploadZone.tsx` |
| The readers: EPUB and PDF, the toolbar, settings popover, contents drawer, search panel, progress rail, version picker | `/read` | `routes/read.tsx`, `reader/epub/`, `reader/pdf/`, `reader/chrome/` |
| Music | the player and the dock | `player/AudioPlayer.tsx`, `player/transport.tsx`, `player/PlayerDock.tsx`, `jukebox/` for the shared-room page at `/jukebox` |
| Video | the player | `player/VideoPlayer.tsx`, `player/MediaFrame.tsx` |
| Notes: the list, the paged ink editor, its toolbars | `/notes` | `routes/notes.tsx`, `notes/NotesList.tsx`, `notes/NoteEditor.tsx` |
| The LaTeX editor: project list, file tree, source editor, preview, diagnostics, the publish dialog | `/latex` | `routes/latex.tsx`, `latex/LatexList.tsx`, `latex/LatexEditor.tsx`, `latex/SourceEditor.tsx`, `latex/LatexPreviewPane.tsx`, `latex/PublishDialog.tsx` |
| Discover (Project Gutenberg) | `/discover` | `routes/discover.tsx` |
| Profiles, login, account settings | `/profiles`, `/login`, `/settings` | `profiles/ManageProfiles.tsx`, `profiles/ProfilePicker.tsx`, `auth/LoginPage.tsx`, `auth/AccountSettings.tsx` |

The docs site (`apps/docs`) is not part of the product UI and is out of scope.

### What the design docs fix today

- [wiki/design.md](../../wiki/design.md) is enforced: warm neutrals, one faded-ink accent that means state only, four kind tints, the Newsreader and Archivo type split, a 4 px default radius, tonal depth, and the motion rules. Its conformance checklist applies to any change here.
- [wiki/decisions.md](../../wiki/decisions.md) holds the locks the redesign starts from: D33 (Reading Room: one home with no tabs, Continue as the hero in time remaining, tint carries kind, playback persists in a dock, Newsreader plus Archivo, a warm dark, Notes as its own destination) and D36 (a personal cloud space, with authored destinations outside the media grid). [PRODUCT.md](../../../PRODUCT.md) is the product truth.
- Three themes, light, sepia and dark, are applied through `data-theme` and drive both the reading surface and the chrome. Brief 03 adds the System choice on the same switch (a first visit is light, and the choice keeps its per-profile sync). The redesign keeps all of it.
- The readers' page-turn swipe (`reader/chrome/swipe.ts`) and the Drawers' swipe from brief 03 must keep not colliding.

The redesign stays inside these decisions. Because the design system is enforced, a proposal that changes it is a **revision of D33**, flagged on the board as a reopened decision, and the owner's approval is what lets `wiki/design.md` change.

## Decisions

Decided 2026-11-10 (owner, Q39): Hallmark, with taste-skill 2.5's useful parts; the owner approves each app on the board before any code changes. Default: the proposal keeps D33's four moves, the two type families, the kind tints and the three themes, and restyles within them (palette values, spacing, layout of each area, the dock, motion). Anything that moves one of those is a reopened decision.

## Files you OWN

- `apps/web/src/styles/globals.css` (the tokens) and the components listed above, one commit each.
- [wiki/design.md](../../wiki/design.md), revised from the shipped result, and `.claude/rules/web.md` if its checklist lines change.
- Corpus: [wiki/decisions.md](../../wiki/decisions.md) (a new decision revising D33, if the owner approves one), [wiki/status.md](../../wiki/status.md), [log.md](../../log.md).

## Files you must NOT touch

- `apps/api`, `packages/`, and the vendored Ward folder (`apps/web/vendor/`).
- Behaviour: reading progress, offline reading, the player's state, the editors' logic, the API calls.
- `epub.js`'s own DOM rules and the PDF canvas rendering, beyond the theme tokens they read.
- The copy's meaning. No invented titles, counts or claims; a book's cover is its own artwork.

## What to do

1. **Today.** Take Playwright screenshots of every area above at 1280 and 390 px, in light, sepia and dark, kept out of git. Include the reader with each panel open, the dock with music and with video, the notes editor with a page of ink, and the LaTeX editor with a compile result.
2. **Propose.** With Hallmark (and taste-skill 2.5's trade palettes and copy layer where they help), make a proposal per area, inside the recorded decisions. Check each against the Floor (contrast, a visible focus ring, a reduced-motion path, no invented facts, no broken phone layout) and against the conformance checklist in `wiki/design.md`, including that kind still reads without labels.
3. **Board.** Put the proposals on this app's pages of the estate board, beside today's screenshots at both widths, in the three themes.
4. **Approval.** The owner approves on the board. Nothing below starts before that, and the approval is recorded in `log.md` with its date.
5. **Build.** First as a token change in `globals.css` (colours for the three themes, type, radii, depth, motion), then one area per commit: the shell and dock, the library, the readers, music and video, notes, the LaTeX editor, then the small pages. Keep the Base UI wrappers, the theme switch and the page-turn swipe working.

## Acceptance

- [ ] The owner's approval is on the board and recorded in `log.md` with the date.
- [ ] Contrast: every text and icon pair in light, sepia and dark clears 4.5:1 (3:1 for large text and UI parts), measured with a script over the built tokens and listed in the outcome note, including text over cover artwork.
- [ ] A Playwright test tabs through each area and asserts a visible focus ring on every stop.
- [ ] A Playwright test with `reducedMotion: "reduce"` asserts no running animation or transition on each area.
- [ ] A Playwright test at 390 px asserts `document.documentElement.scrollWidth <= window.innerWidth` on each area.
- [ ] Every title, figure and cover shown comes from the data; the outcome note lists none invented.
- [ ] The conformance checklist in `wiki/design.md` passes in all three themes, and a page-turn swipe on the reader still turns the page.
- [ ] `npm run check` passes, and `bash corpus/lint.sh` ends clean.

## Interplay

- Brief 03 owns the wrappers, the `z-` tokens and the theme switch, and this brief changes the tokens and layout on top. The `ToggleGroup` theme switch must survive in all three themes.
- Brief 02's formatter and lint run on every redesign commit, and brief 04 touches no web file.
- If the redesign changes `wiki/design.md`, the "Reading Room" name and D33's four moves are revised on purpose, with a decision entry, not drifted from.

## Outcome (2026-11-13)

Built in 13 commits after the approval entry (301c409): tokens 2172e87; Playwright harness 964db03; shell c3a1cee; library 0a4893b; Notes b893ee0; reader b2b874a; undrawn screens 4c839d9; specs 433bd2e; contrast script e771d9f; a PDF cover below the offline button, the PWA colours and the stubbed catalogue 57a3318; the docs 3edc963; then this closeout. Direction "Rail and reading table", recorded as D63.

- **Contrast** (`npm run check:contrast`, from `globals.css`): minimum over the 4.5:1 text pairs light 5.18, sepia 5.14, dark 5.31; over the 3:1 UI pairs light 3.29, sepia 3.71, dark 3.39. Text over cover artwork (the duration chip, worst of a white and a black picture): 5.38 or more in every theme. Reader text at 70% or less failed in sepia, so it is 80% now. The dark progress fill against its own track is 2.84, so it is not a listed pair; against the tile and page grounds it holds 3.66 and 3.70.
- **Playwright** (`apps/web/e2e`, `--workers=2`, headless Chromium, a scratch library with a seeded account, the Gutenberg catalogue stubbed): focus ring on every tab stop of seven areas, reduced motion, no 390 px overflow (seven areas, the LaTeX editor, the reader), the theme group at 1280 and the phone popover (light, sepia, dark, System), and the page-turn swipe all pass. 72 screenshots (12 screens, 3 themes, 2 widths) are in the board's `impl/atrium` folder, outside git.
- **First screen against the critic's counts**: 6 covers per row at 1280 (154 px tiles), 4 at 768, 2 at 360 and 390 (`minmax(150px, 1fr)`); 1 note row at 1280 and 390 on the scratch library (68 px rows).
- **Data**: every title, figure and cover comes from the scratch library (`Field notes`, `A Small Tale` by `Made Up`, `Garden plan`) or the API; none invented. The catalogue stub holds made-up titles with no covers.
- **Against the comps** (pixels differing by more than a small threshold, build against the rendered twin): library 1.2% light 1280, 7.7% light 390, 5.7% dark 1280, 25.9% dark 390; Notes 0.7%, 1.6%, 0.6%, 1.4%; the reader 7.7%, 14.3%, 8.2%, 14.7%. The library gaps are tile order (the scratch library lists `A Small Tale` first; the comps put `Field notes` first) and the real first page of the PDF where the comp draws a mock; the reader gaps are epub.js's own text layout (the real EPUB has 7 to 9 pages, the twin says 12) and the twin's fonts. Notes matches.
- **Deviations**: the comps' sepia, which the board draws on the sheet only, takes the tokens file's values (so `--line`, `--paper-low` and `--on-ink-fill` moved too). The reader pill on a phone is a full-width bar, not a floating pill. The reader's chapter hint and file names in the LaTeX tree still truncate (not titles, authors or notes). The dock's title wraps inside its fixed 64 px height. The icon PNGs in `public/` keep their old grounds. The favicon and the PWA colours follow the new tokens. `D61`'s row never placed the theme in the header, so its marker covers the placement clause only.
- **Undrawn screens restyled** with the new tokens and patterns, no new layout: the profile picker, Manage profiles, sign-in, Account, Discover, Look up, uploads and the empty states, the PDF reader, the settings popover, the contents drawer, search panel and version picker, the players, the Jukebox, the Notes editor, and the LaTeX list, editor, preview, diagnostics and publish dialog. Not shot (no fixture): the music and video players, the Jukebox with a bot, the search panel and the version picker open.
- **Checks**: `npm run check` exits 0 (typecheck, lint with 361 existing warnings and no errors, Prettier, knip, dependency-cruiser, the two house checks, 647 typeset and 158 API tests); `bash corpus/lint.sh --index` is clean.

**Owner steps.** From the vps-deploy checkout: `node cli.ts atrium deploy` (static web only; nothing in the API changed). Look at the library, Notes and a book on a phone, and at the rail's profile menu.
