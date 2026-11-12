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
