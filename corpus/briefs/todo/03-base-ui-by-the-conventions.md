# Task 03: Base UI by the conventions, with the theme switch

**Depends on:**

- In Atrium: brief 01 (Base UI 1.9.0) and brief 02 (the gate, the formatter and `.claude/rules/web.md`).
- In the owner's skills library:
  - brief 02, *A base-ui skill, styled with Tailwind*: rules 1-13, the references and `check-base-ui.mjs`;
  - brief 15, *Enforce the base-ui and code-structure skills in every repo*: the checker runs `--warn-only` until this brief is done.
- The owner's answers of 2026-11-10: Q18 (a Light / Dark / System switch), Q19 (visual parity), Q40 (the Drawer for side panels) and Q58 (form dialogs keep `disablePointerDismissal`; inline confirms stay inline). The skills library's open questions Q15, Q16, Q57 and Q59 still apply.

**Runs before:** nothing. Brief 04 is independent and touches no web file.

**Before you start:** run `brief-board guide` ([CLAUDE.md](../../../CLAUDE.md)).

## Context

The owner's call of 2026-11-09 is Base UI everywhere at 1.9.0, styled with Tailwind v4, with the skill's conventions enforced in each repo. **Atrium's web app is already on Tailwind v4**, so this repo has no Tailwind migration brief. This brief covers what is left: the Base UI audit, the wrappers, and the theme switch the owner asked for on 2026-11-10.

### The Tailwind state (read 2026-11-10)

- `apps/web/package.json` has `tailwindcss` 4.3.2 and `@tailwindcss/vite` 4.3.2. `apps/web/src/main.tsx` imports the fontsource CSS, and `apps/web/src/styles/globals.css` (483 lines) starts with `@import "tailwindcss"`.
- **One stylesheet.** `find apps/web -name "*.css" -not -path "*/node_modules/*" -not -path "*/dist/*"` finds only `globals.css`, and no `*.module.css`. The fontsource imports in `main.tsx:22-31` are the only other CSS.
- **What `globals.css` holds** (line numbers from the selector scan):
  - three token layers: `:root` theme constants (`--theme-<name>-*`, line 48), the `--reader-*` layer switched by `[data-theme="light" | "sepia" | "dark"]` (lines 94-117, 176, 208, 330-335), and the gallery tokens exposed through `@theme static inline` (line 249);
  - `body` rules (337, 358), two reader-flow rules (`[data-reader-flow="scroll"] .epub-view` at 441 and `.epub-container` at 448, which style epub.js's own DOM and cannot be utilities), a CodeMirror hook `.cm-atrium-reveal` (472), and a `prefers-reduced-motion` block (479).
  - So the plain CSS left is about 15 rules, all global or third-party. Nothing to migrate file by file.
- **Inline `style`:** 38 `style=` props in `apps/web/src`. 5 set a progress width (`library/CoverCard.tsx:181`, `library/ContinueReading.tsx:95`, `player/PlayerDock.tsx:151`, `player/transport.tsx:101`, `jukebox/NowPlaying.tsx:156`), which is computed geometry. Rule 5 allows those. The rest are listed by step 1.
- **Class hygiene:** no `cn()` helper (`apps/web/src/lib/` has none), and `clsx` and `tailwind-merge` are not dependencies, so class strings are joined with template literals. 59 arbitrary pixel or rem values (`text-[27px]` and the like). No arbitrary colours (`bg-[#…]`: 0), but `bg-black/40` and `text-white` appear 10 times (`grep -rnE "bg-black|text-white|bg-white" apps/web/src --include=*.tsx`).
- **z-index** is a raw utility, not a token: 25 uses (`z-10` 2, `z-20` 4, `z-30` 4, `z-40` 5, `z-50` 10, plus `z-[60]` on `pwa/UpdateToast.tsx`). `@theme` has no `--z-*` scale.

### Dark mode today

Atrium has had a theme switch since before the estate call, but it is not the one the owner chose on 2026-11-10:

- **Three themes, light, sepia and dark** (Reading Room, D33). `useApplyTheme` (`apps/web/src/reader/chrome/use-apply-theme.ts:15`) sets `data-theme` on `document.documentElement`, and the CSS variables switch on that attribute. Because it sits on the root, Base UI's portalled popups inherit it.
- **The switch.** A hand-built three-way `role="radiogroup"` in `apps/web/src/components/AppHeader.tsx:149` calls `setTheme`, and a second one is `reader/chrome/ThemePicker.tsx:33`.
- **Stored per profile**, not per device: `apps/web/src/store/reader-store.ts:222` seeds `theme` from the profile's boot preferences with `"light"` as the default, and `persistPreference` (line 244) syncs it to the server.
- **No `dark:` variant anywhere**: no `@custom-variant`, no `dark:` class, no `prefers-color-scheme` (`grep -rn "dark:" apps/web/src` and `grep -rn "prefers-color-scheme" apps/web/src` print nothing). Components use the themed tokens (`bg-reader-bg`, `text-ink`), so they need no variants.
- **No "System" choice.** A first visit is light, which already matches the owner's rule.

So what Q18 adds is small: a **System** option, and `@custom-variant dark` keyed off `data-theme`. See decision 1.

### The audit against rules 1-13 (2026-11-10)

| Rule | Violations | Where |
|---|---|---|
| 1. Exact pin | 0 after brief 01 | |
| 2. Subpath imports | 0 | All 7 imports are subpaths. |
| 3. Base UI only under a `ui/` folder | **7** | `apps/web/src/library/LookupDialog.tsx:2` (`dialog`), `apps/web/src/library/CoverCard.tsx:3` (`menu`), `apps/web/src/reader/chrome/SearchPanel.tsx:2` (`dialog`), `apps/web/src/reader/chrome/TocDrawer.tsx:2` (`dialog`), `apps/web/src/reader/chrome/VersionPicker.tsx:4` (`popover`), `apps/web/src/reader/chrome/SettingsPopover.tsx:2` (`popover`), `apps/web/src/reader/chrome/SliderControl.tsx:1` (`slider`). There is no `components/ui/` folder. |
| 4. Tailwind on the parts | 0 | Every part carries `className`. |
| 5. One stylesheet, no inline `style` | partly | One stylesheet. 33 inline `style` props beyond the 5 progress widths (step 1 classifies them). |
| 6. Semantic tokens only | **25 z-index** and 10 `bg-black`/`text-white` | The z scale is raw (above). |
| 7. Motion through the state attributes | partly | 8 `starting-style` uses and 51 `motion-safe`/`motion-reduce` uses. The hand-built toast (`pwa/UpdateToast.tsx`) animates with an effect and `requestAnimationFrame`. |
| 8. Floating parts portalled, z from tokens | 2 | Every Base UI popup uses its `Portal`. The hand-built `latex/PublishDialog.tsx:140` uses `createPortal`. The z values are raw (rule 6). |
| 9. Triggers that wrap a component use `render` | 0 | `SettingsPopover.tsx:37` passes `render={trigger}`. The others pass a styled trigger of their own. |
| 10. `Select.Root` with `items` | 0 | No Base UI `Select`. The three `<select>`s are native: `components/QuietSelect.tsx:27`, `notes/NotesList.tsx:627`, `jukebox/NowPlaying.tsx:211`. |
| 11. No native dialogs | 0 | The three `window.confirm`/`prompt` hits are comments saying there is none. |
| 12. Dialogs | **5** | See below. |
| 13. Base UI over hand-built widgets | **8 groups** | See below. |

**Rule 12.**

- `library/LookupDialog.tsx:126-292` has the Escape guard in `onOpenChange` (a write in flight stops it), `finalFocus` and a `Title`, but **no `initialFocus`** and **no `disablePointerDismissal`**. It holds a search form and checkboxes, so Q58 says it stays open on an outside tap.
- `reader/chrome/SearchPanel.tsx:106-196` has a search field (`inputRef`, line 124) and no `disablePointerDismissal`, no `initialFocus` prop.
- `reader/chrome/TocDrawer.tsx:64-117` has a `Title`, a labelled close button, and no `initialFocus`. It holds no form.
- The two hand-built dialogs have no Base UI behaviour at all: they listen for Escape on `window` (`profiles/ManageProfiles.tsx:359`, `latex/PublishDialog.tsx:120`) and close on a backdrop `onMouseDown` (`ManageProfiles.tsx:386`, `PublishDialog.tsx:144`). Neither traps focus or locks scroll by Base UI's rules. See below.

**Rule 13's eight groups** (hand-built widgets that start from Base UI under the skill):

1. **Two hand-built dialogs:** `profiles/ManageProfiles.tsx:394` (the delete-profile confirm, with a reassign choice) and `latex/PublishDialog.tsx:149` (publish a LaTeX project).
2. **Two hand-built menus:** `profiles/ProfileSwitcher.tsx:72` (`role="menu"`, with `aria-checked` rows) and `notes/NoteEditor.tsx:1326`.
3. **A hand-built toast:** `pwa/UpdateToast.tsx:58`, which also sets `z-[60]`.
4. **Radio groups made of `role="radio"` buttons, eight in all:** the theme switch (`components/AppHeader.tsx:149`, `reader/chrome/ThemePicker.tsx:33`), the font family (`reader/epub/EpubSettings.tsx:64`) and four in `notes/NoteEditor.tsx` (`:1301`, `:1410` tool, `:1457` thickness, `:1476` page background). Each is an always-one-chosen choice, the skills library's Q57.
5. **Pressed buttons:** `reader/chrome/ReaderToolbar.tsx:126` and `reader/chrome/PageModeToggle.tsx` (`aria-pressed` toggles), `jukebox/controls.tsx:37`, `notes/NoteEditor.tsx:1447` (the ink colours, `aria-pressed`) and `profiles/ManageProfiles.tsx:471`.
6. **Hand-built sliders:** `reader/chrome/ProgressRail.tsx:174` (`role="slider"`, a reading-progress rail that scrubs by touch and shows a hover tooltip) and `player/transport.tsx:109` (a native `<input type="range">` laid over a bar).
7. **Status chips:** `library/OfflineToggle.tsx:44` and `library/OfflineBanner.tsx:11` use `role="status"` on plain spans. They are not widgets; nothing to move.
8. **A native checkbox** in `library/LookupDialog.tsx:231`.

**Considered and left:**

- **Native by the skill (Q16):** the three `<select>`s and the checkbox in the Look up dialog. Atrium's decisions keep native controls where Reading Room styles them (`components/QuietSelect.tsx` carries its design note).
- **Sliders in group 6.** Default: both stay, as exceptions in `scripts/conventions.json` with the reason, because each is a scrubbing surface with a hover readout and chapter marks, not a value field. Step 1 reads them and confirms. `reader/chrome/SliderControl.tsx` is already Base UI.
- **Not widgets:** the status spans above, and `components/AppHeader.tsx`'s navigation links.

## Owner decisions (defaults this brief builds)

1. **The theme switch** (owner, 2026-11-10, Q18). A Light / Dark / System choice in the app, kept where the app keeps its other settings, a first visit light, and Tailwind's `dark:` keyed off a `data-theme` attribute through `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`. Atrium already has three themes. Default: add **System** as a fourth choice on the same switch, which resolves to light or dark from `prefers-color-scheme` and writes the resolved value to `data-theme`; keep sepia as it is, as a reading theme beside light and dark. The choice keeps today's per-profile server sync (the owner's answer names no storage, so atrium's store stands). *Repo question:* does System apply to sepia? Default: no, sepia has no system equivalent.
2. **Visual parity** (owner, 2026-11-10, Q19: close enough). Before and after screenshots at 1280 and 390 px show no visible change to layout or colour. A few pixels of drift in spacing or rounding need not be fixed or listed.
3. **Base UI only under `ui/`** (Q15, Q59). Default: yes. The seven imports move behind wrappers in `apps/web/src/components/ui/`. Atrium's web already groups by feature folder, so wrappers sit in the shared `components/ui/`.
4. **Side panels use the Drawer** (owner, Q40). `reader/chrome/TocDrawer.tsx` (from the left) and `reader/chrome/SearchPanel.tsx` (from the right) become Base UI 1.9.0's `Drawer`, with `swipeDirection` set toward their edge, closed by a swipe, a tap outside, the X or Esc. A `SwipeArea` to open by edge swipe is left out: the reader's page-turn swipe (`reader/chrome/swipe.ts`) would fight it. *Repo question:* read `swipe.ts` first and confirm the two do not collide on the reader's page.
5. **Form dialogs** (owner, Q58). A dialog that holds a form sets `disablePointerDismissal` and closes with Cancel, the X or Esc: `LookupDialog` and `SearchPanel`. Confirms stay inline where they already are. `ManageProfiles`'s delete confirm is a dialog with a choice, so it stays a dialog on the `Dialog` wrapper.
6. **Hand-built widgets** (Q57). Default: convert groups 1, 2, 3, 4 and 5 as listed in the wrapper set. For group 4 (always one chosen), use `RadioGroup`: arrows choose, which is what these groups do today. Group 6 stays, with an exception.
7. **Tooltips.** Not in this brief. Same default as the other apps.

## The wrapper set: `apps/web/src/components/ui/`

| File | What it is | From |
|---|---|---|
| `Dialog.tsx` | Base UI `Dialog`: controlled, the Escape guard, `initialFocus` in the house order, `disablePointerDismissal` as a prop (default on for forms), a `Title`, a labelled close | the `Dialog` parts in `LookupDialog.tsx`, and the two hand-built dialogs |
| `Drawer.tsx` | Base UI `Drawer`, `swipeDirection` from a prop | `TocDrawer.tsx`, `SearchPanel.tsx` |
| `Popover.tsx` | Base UI `Popover` with `Portal` and `Positioner` | `SettingsPopover.tsx`, `VersionPicker.tsx` |
| `Menu.tsx` | Base UI `Menu` | `CoverCard.tsx`, `ProfileSwitcher.tsx`, `NoteEditor.tsx:1326` |
| `Slider.tsx` | Base UI `Slider` | `SliderControl.tsx` |
| `Toast.tsx` | Base UI `Toast`, a module-level manager so it can be called outside React | `pwa/UpdateToast.tsx` |
| `RadioGroup.tsx` | Base UI `RadioGroup` + `Radio` | the eight groups in group 4 |
| `Toggle.tsx` | Base UI `Toggle` | the pressed buttons in group 5 |
| `index.css` additions | `--z-*` tokens, `@custom-variant dark` | `styles/globals.css` |

New: `apps/web/src/lib/cn.ts` (`clsx` plus `tailwind-merge`, both pinned). These two dependencies are the only ones added.

## Files you OWN

- `apps/web/src/components/ui/**` (new), `apps/web/src/lib/cn.ts` (new), and every file that imports Base UI today (the seven above).
- The files with a hand-built widget in groups 1 to 5: `profiles/ManageProfiles.tsx`, `profiles/ProfileSwitcher.tsx`, `latex/PublishDialog.tsx`, `pwa/UpdateToast.tsx`, `notes/NoteEditor.tsx`, `components/AppHeader.tsx`, `reader/chrome/ThemePicker.tsx`, `reader/epub/EpubSettings.tsx`, `reader/chrome/ReaderToolbar.tsx`, `reader/chrome/PageModeToggle.tsx`, `jukebox/controls.tsx`.
- `apps/web/src/styles/globals.css`: the `--z-*` scale and `@custom-variant`, nothing else.
- `apps/web/src/store/reader-store.ts` and `apps/web/src/reader/chrome/use-apply-theme.ts`, for the System choice (decision 1).
- `apps/web/package.json` (`clsx`, `tailwind-merge`, `eslint-plugin-better-tailwindcss`, pinned) and `package-lock.json`.
- `eslint.config.js`: `better-tailwindcss` on `apps/web/src`. `scripts/conventions.json`: the two slider exceptions.
- `.claude/rules/web.md`: the Tailwind lines.
- Corpus: [wiki/design.md](../../wiki/design.md) (the theme switch and the checklist), [wiki/decisions.md](../../wiki/decisions.md), [wiki/status.md](../../wiki/status.md), [log.md](../../log.md).

## Files you must NOT touch

- `apps/api`, `packages/`, and the vendored Ward folders (`apps/web/vendor/`).
- The Reading Room tokens' values. Their names and values stay (D33), and the three themes keep rendering as they do.
- `reader/pdf/` and `reader/epub/` rendering code beyond the files named above, and `epub.js`'s own DOM rules in `globals.css`.
- Native controls: the three `<select>`s and the checkbox.

## What to do

One commit per numbered step. After each, `npm run check` passes with `check-base-ui` still `--warn-only`.

1. **Before.** Run `check-base-ui` strict and record counts by rule. Classify the 33 other inline `style` props (computed geometry stays, a colour from data needs an exception). Read `reader/chrome/swipe.ts`, `ProgressRail.tsx` and `player/transport.tsx`. Take Playwright screenshots at 1280 and 390 px, in light, sepia and dark, of: the library, the Look up dialog, a cover's menu, the profile switcher, the delete-profile confirm, the reader with its settings popover, version picker, contents drawer and search panel, the notes toolbar and the publish dialog. The Playwright hub is local and gitignored.
2. **`cn()` and the tokens.** Add `cn.ts` and the two dependencies. Add the `--z-*` scale (`z-overlay`, `z-popup`, `z-toast`) to `@theme`, and replace the 25 raw `z-` utilities. No visible change.
3. **The seven wrappers**, one commit each family: `Dialog`, `Popover`, `Menu`, `Slider`, then `Drawer`. Each moves its Base UI import under `components/ui/`; call sites import the wrapper. `Dialog` sets `initialFocus` (first `[data-autofocus]`, else the first field, else the popup). Rule 3's count reaches 0.
4. **Form dialogs and drawers.** `LookupDialog` and `SearchPanel` get `disablePointerDismissal`. `TocDrawer` and `SearchPanel` use `Drawer` per decision 4; check a swipe on the open panel closes it and a page-turn swipe on the reader still turns the page.
5. **The two hand-built dialogs** on the `Dialog` wrapper. Keep the "busy" guard (`ManageProfiles.tsx:359, 386`): no Esc or outside tap while the request runs, as a test of the wrapper's props if the app has a harness, or as a Playwright step.
6. **The menus, the toast, the radio groups and the toggles**, one commit each, keeping each widget's keys and labels. The toast keeps its trigger (`needRefresh`) and its two actions.
7. **The theme switch.** Add `@custom-variant dark` keyed on `data-theme`. Add **System** to the switch in `AppHeader.tsx` and `ThemePicker.tsx`: it resolves through `matchMedia("(prefers-color-scheme: dark)")`, follows later changes, and writes the resolved light or dark to `data-theme`. Store the choice through the existing per-profile `persistPreference`, with `"light"` as the default on a first visit. Check all three themes and System, in the library, the readers and the notes editor.
8. **`better-tailwindcss`.** Add it to `eslint.config.js` on `apps/web/src`, with the class registry pointed at `globals.css`. Fix what it finds; list any left, with the reason.
9. **The exceptions.** `scripts/conventions.json` with the `ProgressRail` and `transport` slider entries and their reason.
10. **After.** Take the screenshots again. Compare at 1280 and 390 px: no visible change in layout or colour (decision 2). Run `check-base-ui` strict, drop its `--warn-only`, and update [wiki/design.md](../../wiki/design.md), [wiki/decisions.md](../../wiki/decisions.md), [wiki/status.md](../../wiki/status.md), [log.md](../../log.md) and `.claude/rules/web.md`. Run `bash corpus/lint.sh`.

## Acceptance

- [ ] `grep -rn "@base-ui/react" apps/web/src --include=*.ts --include=*.tsx | grep -v "components/ui/"` prints nothing.
- [ ] `check-base-ui` strict passes, with the two slider exceptions in `scripts/conventions.json` and their reason.
- [ ] `grep -rnE "\bz-\[?[0-9]+\]?\b" apps/web/src --include=*.tsx` prints nothing (z-index comes from the tokens).
- [ ] `grep -rn "role=\"\(dialog\|menu\|radio\|radiogroup\)\"" apps/web/src --include=*.tsx | grep -v "components/ui/"` prints nothing.
- [ ] `@custom-variant dark` is in `apps/web/src/styles/globals.css`, and `grep -rn "prefers-color-scheme" apps/web/src` finds it only in the System resolver and `reader-store`/theme code. A first visit with no stored choice renders light even when the system prefers dark (a Playwright step with `colorScheme: "dark"`).
- [ ] The Light, Dark, Sepia and System choices each set `data-theme` as documented, and a reload keeps the choice.
- [ ] Before and after screenshots at 1280 and 390 px, in all three themes, show no visible change in layout or colour.
- [ ] The Look up dialog and search panel stay open on an outside tap and close with Cancel, the X or Esc. A swipe closes the contents drawer, and a page-turn swipe on the reader still turns the page.
- [ ] `npm run check` passes, and `bash corpus/lint.sh` ends clean.

## Interplay

- The skills library's `check-base-ui` heuristic for rule 9 may flag `Dialog.Close` around an icon. That is a false positive, to report to the skill rather than to except here.
- Atrium's `data-theme` has three values and a per-profile store today. Both stay: the estate's rule asks for the switch and a light first visit, not a storage place.
- If brief 02's width differs from the one the owner settles on, run the formatter again after this brief's last step.
