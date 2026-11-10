# Task 01: Base UI 1.9.0

**Depends on:**

- In Atrium: nothing. This brief runs first, so a visual or behavioural change in the later briefs is never blamed on the bump.
- In the owner's skills library: nothing is needed to build it. It is Atrium's row of the brief *Every repo on Base UI 1.9.0*, and replaces it for this repo.

**Runs before:** 02, 03 and 04.

**Before you start:** run `brief-board guide` ([CLAUDE.md](../../../CLAUDE.md)).

## Context

On 2026-11-09 the owner decided that every web app they own runs `@base-ui/react` at the latest stable release, **1.9.0**, pinned exactly. On 2026-11-10 npm's `latest` tag was 1.9.0 (`npm view @base-ui/react dist-tags`). Atrium is on 1.6.0.

### The pin today (read 2026-11-10)

Command: `grep -rn "base-ui" --include=package.json . | grep -v node_modules`.

| File | Spec |
|---|---|
| `package.json` (root) | none |
| `apps/web/package.json:13` | `"1.6.0"`, already exact |
| `apps/api/package.json`, `apps/docs/package.json`, `packages/shared/package.json`, `packages/typeset/package.json` | none |

The lockfile resolves one copy: `package-lock.json:2080-2087`, `node_modules/@base-ui/react` at 1.6.0, with `@base-ui/utils` 0.3.1 (`package-lock.json:2118-2120`). The repo has no `.npmrc`, so the exact pin is only held by the spec itself. Only the version is old.

### The two breaking changes do not touch this repo

1.9.0 renamed `OTPFieldPreview` to `OTPField` (`@base-ui/react/otp-field`) and `sanitizeValue()` to `normalizeValue()`. Command: `grep -rnE "OTPFieldPreview|otp-field|sanitizeValue" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist` printed nothing on 2026-11-10.

### Measured on a scratch copy, 2026-11-10

On a scratch copy holding only the `package.json` files and the lockfile, `npm install @base-ui/react@1.9.0 --save-exact -w @ebook-reader/web --package-lock-only --ignore-scripts`, npm 10:

- `apps/web/package.json` became `"@base-ui/react": "1.9.0"`. No other `package.json` changed.
- The lockfile stays hoisted (`node_modules/@base-ui/react` is still the key). Eight entries change and none is added or dropped (2,015 packages before and after):

  | Package | Before | After |
  |---|---|---|
  | `@base-ui/react` | 1.6.0 | 1.9.0 |
  | `@base-ui/utils` | 0.3.1 | 0.5.0 |
  | `@floating-ui/core`, `@floating-ui/dom` | 1.7.5, 1.7.6 | 1.8.0, 1.8.0 |
  | `@floating-ui/react-dom` | 2.1.8 | 2.1.9 |
  | `@floating-ui/utils` | 0.2.11 | 0.2.12 |
  | `reselect` | 5.2.0 | 5.3.0 |
  | `use-sync-external-store` | 1.6.0 | 1.7.0 |

- `tsc -p apps/web/tsconfig.json --noEmit` against the 1.9.0 package: 0 errors, as it is today.
- Peer dependencies: `react` `^17||^18||^19` (this repo is on 19.2.7). `date-fns` and `@date-fns/tz` are optional peers.

**Not measured here, so step 1 measures it:**

- The 1.6.0 to 1.9.0 changelog (GitHub was not reachable).
- Behaviour in a browser.
- `docker build` of `infrastructure/Dockerfile`.
- The web app has no test files (`find apps/web/src -name "*.test.*"` prints nothing), so the gate for this bump is the typecheck, the build and the browser check. The Playwright hub is local and gitignored.

### What Atrium uses

Seven imports, all subpaths, all in feature files (`grep -rn "@base-ui" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist`):

| File:line | Import | What it uses |
|---|---|---|
| `apps/web/src/library/LookupDialog.tsx:2` | `/dialog` | `Root` (`open`, `onOpenChange`, `onOpenChangeComplete`), `Portal`, `Backdrop`, `Popup` (`finalFocus`), `Title`, `Description`, `Close` |
| `apps/web/src/reader/chrome/SearchPanel.tsx:2` | `/dialog` | `Root`, `Portal`, `Backdrop`, `Popup`, `Title`, `Close` |
| `apps/web/src/reader/chrome/TocDrawer.tsx:2` | `/dialog` | the same set |
| `apps/web/src/library/CoverCard.tsx:3` | `/menu` | `Root` (`modal={false}`), `Trigger`, `Portal`, `Positioner`, `Popup`, `Item` |
| `apps/web/src/reader/chrome/SettingsPopover.tsx:2` | `/popover` | `Root`, `Trigger` (`render`), `Portal`, `Positioner`, `Popup` |
| `apps/web/src/reader/chrome/VersionPicker.tsx:4` | `/popover` | `Root`, `Trigger`, `Portal`, `Positioner`, `Popup` |
| `apps/web/src/reader/chrome/SliderControl.tsx:1` | `/slider` | `Root`, `Label`, `Control`, `Track`, `Indicator`, `Thumb` |

## Owner decisions (defaults this brief builds)

1. **Pin 1.9.0 exactly.** Default: yes, through `npm install ... --save-exact`. No range.
2. **Nothing else moves.** Default: no general `npm update`, no other dependency. The lockfile diff is Base UI's own tree and nothing else.
3. **A visual change the bump causes** is logged in the outcome note and left. Brief 03 owns the markup.

## Files you OWN

- `apps/web/package.json` (the one line) and `package-lock.json`.
- A source file under `apps/web/src` only if a breaking or behavioural change forces it. Expect none.
- Corpus: [wiki/status.md](../../wiki/status.md) and [log.md](../../log.md). Check whether [wiki/decisions.md](../../wiki/decisions.md) or [wiki/design.md](../../wiki/design.md) names 1.6.0 (`grep -rn "1\.6\.0" corpus`) and update that line.

## Files you must NOT touch

- `apps/api`, `packages/`, `apps/docs`, and every other dependency.
- The `className` strings and the markup of the seven files. A fix the bump forces keeps each file's behaviour.

## What to do

One commit for the bump, `chore(deps): @base-ui/react 1.9.0`. Record the baseline first.

1. **Baseline and changelog.**
   - Run `npm run typecheck` and `npm run build` on the untouched tree and record the result.
   - Read the `@base-ui/react` release notes from v1.6.0 to v1.9.0 and write one line per primitive in the outcome note (Dialog, Menu, Popover, Slider): either "nothing in these notes touches what Atrium uses", or the note and what you checked. Look at focus, dismissal, animation and positioning changes.
2. **Re-run the grep** for `OTPFieldPreview`, `otp-field` and `sanitizeValue`. Expect no hits.
3. **Install.** `npm install @base-ui/react@1.9.0 --save-exact -w @ebook-reader/web`. Check the lockfile resolves 1.9.0 and only the eight entries above changed:

   ```
   node -e "const p=require('./package-lock.json').packages;console.log(Object.entries(p).filter(([k])=>k.endsWith('/@base-ui/react')).map(([k,v])=>k+' '+v.version))"
   ```

4. **Scripts.** `npm run typecheck` and `npm run build`. Fix only what the bump broke.
5. **Behaviour in a browser.** Start `npm run dev`, sign in, and check each primitive at 1280 and 390 px wide, with the keyboard and with the pointer, in all three themes. Write down anything that differs from 1.6.0 (the baseline on a second checkout gives the comparison).

   | Primitive | Where to see it | Check |
   |---|---|---|
   | `Dialog` | the library's Look up dialog (`LookupDialog.tsx`), the reader's search panel and contents drawer | open, Esc closes it, a backdrop click closes it (not the Look up dialog while a write runs), Tab stays inside, focus returns to the opener, scroll is locked behind it |
   | `Menu` | a cover's "More actions" menu (`CoverCard.tsx`) | arrows move, Enter chooses, Esc returns focus to the trigger, the popup sits under the trigger and does not clip at 390 px |
   | `Popover` | the reader's settings popover and the version picker | opens on the trigger, closes on Esc and outside press, sits above the reader chrome |
   | `Slider` | the font size, spacing and margin sliders in the settings popover | arrows step, drag works, the value is announced |

6. **Commit** the bump, then update [wiki/status.md](../../wiki/status.md) and [log.md](../../log.md) with a `done` entry in one corpus commit. Run `bash corpus/lint.sh`.

## Acceptance

- [ ] `node -p "require('./apps/web/package.json').dependencies['@base-ui/react']"` prints `1.9.0`.
- [ ] The step 3 command prints one line, ending `1.9.0`.
- [ ] `grep -rnE "OTPFieldPreview|otp-field|sanitizeValue" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist` prints nothing.
- [ ] `git diff --stat HEAD~1` for the bump commit lists only `apps/web/package.json` and `package-lock.json`, unless a forced fix is named in the outcome note.
- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] `docker build -f infrastructure/Dockerfile .` succeeds.
- [ ] The outcome note has one changelog line per primitive and the behaviour table's result, or "no difference found".
- [ ] `bash corpus/lint.sh` ends clean.

## Interplay

- Brief 03 builds the wrappers and the new primitives (`Toast`, `RadioGroup`, `Toggle`) on a tree already at 1.9.0.
- Brief 02 reformats every file; this brief touches two manifests only, so the order costs nothing.
