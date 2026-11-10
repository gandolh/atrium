# Task 02: The house style and the quality harness

**Depends on:**

- In Atrium: brief 01, so the reformat lands on a tree already on Base UI 1.9.0.
- In the owner's skills library:
  - brief 27, *A house style, and a quality harness that enforces it*: the `house-style` package at `v1.0.0`, the `house-style` skill, and the plugin's `Stop` and `PostToolUse` hooks;
  - brief 15, *Enforce the base-ui and code-structure skills in every repo*: how the convention checkers are wired and when they run `--warn-only`.
- The owner's grilling of 2026-11-10 and the skills library's open questions Q5-Q14, Q27, Q47-Q51.

**Runs before:** 03 and 04. The reformat touches about 185 files, and those briefs rewrite or move many of them. Formatting first gives one clean reformat commit, and the formatter hook keeps every later diff formatted.

**Before you start:** run `brief-board guide` ([CLAUDE.md](../../../CLAUDE.md)).

## Context

On 2026-11-09 the owner made three calls for every web app they own: Base UI 1.9.0 everywhere, the whole app on Tailwind v4, and the researched conventions enforced in each repo. The skills library's brief 27 found the house style consistent but unenforced, and answers with a two-layer harness: the repo's gate (`npm run check` and `npm run check:fast`) and the Claude Code layer (the plugin's `Stop` and `PostToolUse` hooks, `.claude/rules/`, a short root `CLAUDE.md`). This brief adopts both in Atrium. Atrium is the one app in the estate that starts with **no ESLint config at all**, so the config is built from scratch here.

### What Atrium has today (read 2026-11-10)

- **A monorepo of five workspaces:** `packages/shared`, `packages/typeset`, `apps/api`, `apps/web`, `apps/docs` (Docusaurus). Not the `server/ web/ shared/` names the skills use; every rule below applies to the paths named here.
- **`tsconfig.base.json`** has `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `isolatedModules`, `module: ESNext` and `moduleResolution: Bundler`. It lacks `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `erasableSyntaxOnly`.
  - `packages/typeset/tsconfig.json` already sets `verbatimModuleSyntax` and `erasableSyntaxOnly`, with a comment: Node's type stripping runs its tests (`node --test` on the `.ts` files).
  - `apps/api/tsconfig.test.json` and `packages/typeset/tsconfig.test.json` typecheck `test/` without emitting it. `apps/web` has no tests, so nothing is hidden.
- **No ESLint, no Prettier.** `find . -name "eslint*" -o -name ".prettierrc*"` outside `node_modules` finds nothing, and no `package.json` mentions either. There are 11 leftover `eslint-disable` comments, all for `react-hooks/exhaustive-deps` (the rule once ran; the config is gone).
- **Scripts** (root `package.json`): `typecheck` runs each workspace's own, after a `pretypecheck` that builds `shared` and `typeset`; `test` has a `pretest` that builds the packages; there is no `lint`, `format` or `check`. So `npm test` already works on a fresh clone.
- **Tests run on `node:test`**, not vitest: `apps/api` with `node --import tsx --import ./test/setup.ts --test 'test/**/*.test.ts'` (25 files, 147 tests, passing on 2026-11-10 in the scratch copy), `packages/typeset` with `node --test`. The skills library's Q27 default keeps Atrium on `node:test`.
- **A root `CLAUDE.md` exists**, but it is the corpus schema (120 lines) and holds no commands. There is no `corpus/CLAUDE.md`. `.claude/` holds only `settings.local.json`.
- **No `.npmrc`.** Dependencies are pinned exactly by hand in each manifest.
- **The Docker image** (`infrastructure/Dockerfile:31`) runs a full `npm ci` in its builder stage, so dev dependencies install there. It copies only the manifests, `tsconfig.base.json`, `packages` and `apps`.

### Measured on 2026-11-10

Taken on a scratch copy with Prettier 3.8.4 (from another repo's install), typescript-eslint 8.72.2 and eslint 9.39.5 installed outside the repo, and the repo's own TypeScript 5.9.3 for `tsc`. The ESLint runs resolved typescript-eslint's TypeScript as 6.0.3, not the repo's 5.9.3; step 1 repeats them with the repo's own.

**Prettier churn.** `--trailing-comma all`, otherwise defaults, on the 325 TypeScript, JavaScript and CSS files in `apps/` and `packages/` outside `vendor/`, `dist/` and `assets/` (about 78,000 lines):

| `printWidth` | Lines added | Lines removed | Files changed |
|---|---|---|---|
| 90 | 9,915 | 2,907 | 223 |
| 100 | 5,209 | 1,799 | 185 |
| 110 | 3,145 | 2,008 | 192 |
| **120** | **1,992** | **2,580** | **185** |
| 130 | 1,841 | 3,560 | 202 |
| 140 | 1,882 | 4,473 | 214 |
| 150 | 1,963 | 5,148 | 222 |

120 has the least total churn (4,572 lines). 130 adds fewer lines but removes 1,000 more, because Atrium's code wraps at about 100 and wider widths join lines. The biggest single change at 120 is `packages/typeset/src/macro/builtins.ts` (+330, -75). The skills library's Q51 default is one estate width of 120 or 130. JSON and Markdown were not measured.

**TypeScript flags**, added to `tsconfig.base.json` on the scratch copy:

| Flag | `apps/web` | `apps/api` (src and test) | `packages/shared` | `packages/typeset` |
|---|---|---|---|---|
| `verbatimModuleSyntax` + `erasableSyntaxOnly` | 0 | 6 | 0 | 0 (already set) |
| `noUncheckedIndexedAccess` (Q50, **not** added) | 107 | 17 src, 46 with tests | 0 | 0 src, 47 with tests |
| `exactOptionalPropertyTypes` (not added) | 39 | 10 src, 14 with tests | 0 | 6 |

The six `erasableSyntaxOnly` errors are parameter properties: `apps/api/src/modules/jukebox/jukebox.service.ts:55, 56` and `apps/api/src/modules/lookup/lookup-http.ts:93, 94, 115, 116`. `apps/api` also compiles with 0 errors under `module` and `moduleResolution` `NodeNext` (measured; every relative import in `apps/api/src` and `apps/api/test` already carries a `.js`, `.ts` or `.json` suffix, 0 without).

**The house shapes**, counted with the TypeScript parser over the 312 `.ts`, `.tsx`, `.js` and `.mjs` files in `apps/` and `packages/` (vendored Ward code excluded):

| Shape | Count | Where |
|---|---|---|
| `enum` | 0 | |
| `any` (the keyword) | 0 | |
| `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` | 0 | |
| `TODO` / `FIXME` / `XXX` / `HACK` | 0 | |
| namespaces | 0 | |
| non-null `!` | **485** | `apps/api/src` 34, `apps/api/test` 12, `apps/web/src` 7, `packages/typeset/src` 129, `packages/typeset/test` 303 |
| `console` | 26 | see below |
| default exports | 7 | `apps/docs/docusaurus.config.ts:90`, `apps/docs/sidebars.ts:86`, `apps/web/vite.config.ts:34` (configs); `apps/docs/src/components/Diagram.tsx:33` (a component); `packages/typeset/src/layout/hypher.d.ts:47, 53` and `packages/typeset/src/pdf/pdf-lib-fontkit.d.ts:27` (module declarations, which require it) |
| parameter properties | 6 | the six above |

`console` calls in `apps/api/src`: `common/config.ts:94, 223`, `index.ts:59`, `scripts/seed-user.ts:101, 120, 131` (the CLI), migrations (`20260830000000-baseline.ts:518`, `20260925000000-prune-cutover-orphans.ts:56, 75`), and in services `modules/latex/latex-compile.service.ts:552, 584`, `modules/library/convert.service.ts:235, 262`, `modules/library/extract.service.ts:248`. The other 15 are in `apps/api/test`.

**The six typed rules**, through `parserOptions.project` listing the four test-aware tsconfigs (the web one, `apps/api/tsconfig.test.json`, `packages/shared`, `packages/typeset/tsconfig.test.json`), on the same files, cold, in 27 s:

| Rule | Findings | Where |
|---|---|---|
| `no-floating-promises` | 823 raw: **814 are `describe`/`it`/`test` from `node:test`**, which return promises. With `allowForKnownSafeCalls` for `node:test` the count is **9**. | `apps/web/src/latex/LatexEditor.tsx:332, 344, 353, 369, 464`, `apps/web/src/reader/epub/EpubReader.tsx:350`, `apps/web/src/reader/epub/dev/use-dev-sample-epub.ts:21`, `apps/web/src/reader/pdf/dev/use-dev-sample-file.ts:21`, `apps/web/src/reader/pdf/use-pdf-outline.ts:25` |
| `no-misused-promises` | **20**, all `apps/web/src` | async functions passed to event props: `auth/AccountSettings.tsx:175, 210`, `auth/AuthGate.tsx:81`, `auth/LoginPage.tsx:83`, `latex/LatexEditor.tsx:321, 329, 331`, `latex/LatexList.tsx:71`, `lib/video-cover.ts:426`, `notes/NoteEditor.tsx:670, 694, 695`, `notes/NotesList.tsx:125`, `player/use-playback-element.ts:142`, `profiles/ManageProfiles.tsx:144, 279, 435`, `profiles/ProfilePicker.tsx:73`, `profiles/ProfileSwitcher.tsx:88`, `routes/discover.tsx:214` |
| `await-thenable` | 0 | |
| `consistent-type-imports` | 0 | |
| `switch-exhaustiveness-check` (with `considerDefaultExhaustiveForUnions`) | 1 | `packages/typeset/test/doc.test.ts:44` |
| `no-unnecessary-type-assertion` | **608**: `apps/api` 28 src and 16 test, `apps/web` 10, `packages/shared` 2, `packages/typeset` 226 src and 326 test | 251 of the source findings read "does not change the type": they are `!` on values the compiler already types as non-null, because `noUncheckedIndexedAccess` is off |

The last row matters. The 485 `!` are mostly `array[i]!`. Turning on `noUncheckedIndexedAccess` (Q50) would make them necessary again; turning on `no-non-null-assertion` makes every one a finding. The owner's Q47 default is error in source and warning in tests, which leaves 170 source findings (`apps/api/src` 34, `apps/web/src` 7, `packages/typeset/src` 129) to fix and 315 test warnings.

**Not measured here:** lint time with `projectService` against `project` (step 1 measures it), knip's findings, and the full `check` time. Warm `tsc` times: `apps/web` 9 s, `apps/api` 3.8 s, `packages/shared` 2.3 s, one workspace at a time.

## Owner decisions (defaults this brief builds)

1. **Where the configs come from** (skills library Q6). Default: the `house-style` package, extended from Atrium's configs. The Docker builder stage runs `npm ci` without `git` (check the image: `infrastructure/Dockerfile:31`); depend on the tagged tarball URL, which needs none. If the owner picks `github:`, add `git` to the builder stage in the same commit.
2. **Width** (Q8, Q51). Default: the estate's one width. If it is not settled when this runs, use **120**, Atrium's least churn, and record it.
3. **Markdown and the generated docs stay out of Prettier.** Default: `.prettierignore` lists `*.md`, `apps/docs/docs/wiki/` (generated, gitignored), `apps/docs/dist`, `apps/docs/.docusaurus`, `apps/web/public/`, `packages/typeset/assets/`, the two `vendor/` folders, `package-lock.json`, `dist/` and the library data folders. Prettier covers the TypeScript, TSX, JS, CSS and JSON the repo writes.
4. **tsconfig** (Q11, Q50). Default: add `verbatimModuleSyntax` and `erasableSyntaxOnly` to the base (typeset already has them), and **not** `exactOptionalPropertyTypes` or `noUncheckedIndexedAccess`. The second costs 107 errors in the web app and 17 in the API source, and it changes what the 485 `!` mean; it is a separate brief if the owner wants it. *Repo question.*
5. **`NodeNext` for the API.** Default: set `module` and `moduleResolution` to `NodeNext` in `apps/api/tsconfig.json` only (measured: 0 errors). Under `Bundler` a missing `.js` suffix typechecks and then fails when Node runs `dist/`. The web app, which Vite builds, stays on `Bundler`. *Repo question.*
6. **Typed lint** (Q12). Default: the six rules, through `projectService` unless `project` measures faster. `no-floating-promises` is configured with `allowForKnownSafeCalls` for the `node:test` functions. Without it the rule is unusable here.
7. **The house shapes as errors** (Q13, Q47). Default: `enum`, `console` outside the CLIs, default exports outside configs, `TODO`/`FIXME` are errors. `no-non-null-assertion` is an error in source and a warning in tests. `.d.ts` module declarations are excepted from the default-export rule. `no-process-env` (from `eslint-plugin-n`) starts as a **warning** and brief 04 makes it an error.
8. **Test lint.** No test-lint plugin applies to `node:test`. Record that in the outcome note; `describe.only` and `it.only` are caught by `node --test --test-only` only if used, so add a plain `no-restricted-syntax` selector for `.only(` calls on those names if it takes one line.
9. **`check:fast`** (Q10). Default: a typecheck of the touched workspaces plus ESLint on the changed files, under about 15 s warm with one changed file.
10. **The Claude Code layer** (Q7). Default: the plugin's hooks. If the owner chooses committed hooks, add them to `.claude/settings.json` here.
11. **The root `CLAUDE.md`.** Default: add a "Commands" section and a "Hard rules" pointer at the top of the existing file, and leave the corpus schema where it is. Alternative: move the schema to `corpus/CLAUDE.md`, as Almanac has it, leaving a root file under about 60 lines. *Repo question.*

## Files you OWN

- `tsconfig.base.json`, `apps/api/tsconfig.json` (decision 5), and the `.d.ts` or source files a typed rule asks to change.
- New: `eslint.config.js`, the Prettier config, `.prettierignore`, `.git-blame-ignore-revs`.
- The root `package.json` (scripts, devDependencies) and `package-lock.json`. Pin each new dev dependency exactly.
- The reformat itself: whitespace-only changes to every file Prettier covers.
- The fixes the new rules ask for:
  - `apps/api/src/modules/jukebox/jukebox.service.ts` and `apps/api/src/modules/lookup/lookup-http.ts` (the six parameter properties);
  - the 9 floating and 20 misused promises in `apps/web/src` (list above): `void` the first, wrap the second in a sync handler;
  - the 170 `!` in source and the rest found in step 1.
- New: `.claude/rules/web.md`, `.claude/rules/server.md`, and the changes to `CLAUDE.md`.
- `scripts/conventions.json` (brief 15's exceptions file), if an exception is needed.
- The `infrastructure/Dockerfile` builder stage, only under decision 1's `github:` branch.
- Corpus: [wiki/decisions.md](../../wiki/decisions.md) (a new entry), [wiki/status.md](../../wiki/status.md), [log.md](../../log.md).

## Files you must NOT touch

- Behaviour. Apart from the fixes listed above, every change is formatting or configuration.
- `apps/api/vendor/` and `apps/web/vendor/`: generated copies of the Ward library, ignored by ESLint and Prettier.
- The layout of `apps/api/src` and the CSS, which are briefs 04 and 03.
- The skills library and the `house-style` repo. A rule that seems wrong for Atrium is reported back, not patched locally.

## What to do

One commit per step, each with `npm run typecheck`, `npm test` and `npm run build` green.

1. **Measure first.** Record in the `log.md` entry:
   - the six typed rules' counts with the repo's own TypeScript 5.9.3, and `projectService` against `project` timings;
   - `npx knip` from the `house-style` preset (expect unused-dependency findings: say which);
   - the `tsc` counts with the new flags;
   - the 11 `react-hooks/exhaustive-deps` disables, checked against `eslint-plugin-react-hooks` 7.1.1 `recommended`.

   Any rule that finds more than about 20 real problems, or mostly false ones, goes back to the owner before it is turned on (brief 27's rule: bring it, don't loosen it).
2. **Prettier, and the reformat.**
   1. Add `prettier` (pinned) and the config: `printWidth` per decision 2, `trailingComma: "all"`, the rest default.
   2. Add `.prettierignore` per decision 3.
   3. Add `"format": "prettier --write ."` and `"format:check": "prettier --check ."`, and commit this alone.
   4. Run `npm run format` and commit only that, as `style: format with Prettier`. Run it when no other brief has uncommitted work.
   5. Add that commit's full hash to `.git-blame-ignore-revs`, in its own commit.
   6. Hand the owner the one-time `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
3. **tsconfig.** Add `verbatimModuleSyntax` and `erasableSyntaxOnly` to the base, and `NodeNext` to the API per decision 5.
   - Fix the six parameter properties with a declared field assigned in the constructor. Behaviour and `readonly` stay.
   - `npx tsc -b`-equivalent builds still pass: `npm run build` and `docker build` of `infrastructure/Dockerfile`.
4. **ESLint, from scratch.** `eslint.config.js` at the root: `@eslint/js` recommended, typescript-eslint recommended, `eslint-plugin-react-hooks` 7.1.1 recommended on `apps/web/src`, the six typed rules, and the table below. Ignore `**/vendor/**`, `**/dist/**`, `apps/docs/**`, `apps/web/public/**`. Typed linting needs the four tsconfigs as `project`, or `allowDefaultProject` for config files.

   | Rule | After | Findings today |
   |---|---|---|
   | the six typed rules | error | 9 + 20 + 1 + 608 (step 1 re-measures) |
   | `@typescript-eslint/no-non-null-assertion` | error in source, warn in tests | 170 source, 315 test |
   | `no-restricted-syntax` on `TSEnumDeclaration` | error | 0 |
   | `no-warning-comments` (`todo`, `fixme`), pointing at `corpus/briefs/` (there is no `todos/`, see [CLAUDE.md](../../../CLAUDE.md)) | error | 0 |
   | `no-console` outside the CLIs | error | 11 in `apps/api/src` beyond the seed CLI: migrations (3), `config.ts` (2), `index.ts` (1), three services (5) |
   | `no-default-export` (`eslint-plugin-import-x`) outside `*.config.*`, `sidebars.ts` and `.d.ts` | error | 1: `apps/docs/src/components/Diagram.tsx:33` (docs are ignored, so 0 in scope) |
   | `no-process-env` (`eslint-plugin-n`) on `apps/api/src` outside `common/config.ts` and tests | **warn**; brief 04 makes it an error | 6 sites, listed in brief 04 |
   | `no-explicit-any`, `ban-ts-comment` | error (recommended) | 0 |

   The `console` findings are real log calls. The default is to route the ones in `latex-compile.service.ts`, `convert.service.ts` and `extract.service.ts` through the `log` those services already receive or build; if one has no logger in reach, list it in `scripts/conventions.json` with the reason. Fix what the typed rules find, or list each finding left, with its reason, in the outcome note.
5. **The gate.** In the root `package.json`:
   - `check` runs `typecheck`, `lint`, `format:check`, `check:conventions` and `test`;
   - `check:conventions` is knip plus the two convention checkers from the `house-style` package. `check-base-ui` runs `--warn-only` until brief 03 is done, `check-structure` `--warn-only` until brief 04 is done;
   - `check:fast` runs the typecheck, then ESLint on the files changed against `HEAD` plus untracked ones. Use the package's script, or a small Node script in `scripts/`. No shell-only syntax: the owner works on Windows under WSL;
   - `lint` is `eslint .`.

   Time `check:fast` warm with one changed file, and `check` in full. Record both.
6. **`.claude/rules/`.** Each file under about 40 lines, scoped by `paths:`, pointing at the skill for the rest.
   - **`web.md`** (`apps/web/src/**`): the Reading Room conformance checklist in [wiki/design.md](../../wiki/design.md) is the design gate; Base UI only through `components/ui/` wrappers (brief 03); light, sepia and dark are all checked; no raw hex in components; the `data-theme` attribute is the theme switch.
   - **`server.md`** (`apps/api/src/**`, `packages/shared/src/**`): read [wiki/api-layering.md](../../wiki/api-layering.md); a controller owns HTTP, a service the rules, a model the SQL; a service returns a tagged union for a normal outcome; every notes, folders and LaTeX query is keyed on `profile_id`, and a foreign id is a 404, never a 403; `apps/api/vendor/` is generated; tests go through `buildTestApp` in `apps/api/test/harness.ts`; a thrown error is a 500 that says nothing.

   Briefs 03 and 04 add the Tailwind, Base UI and structure lines.
7. **`CLAUDE.md`** per decision 11: the commands (`npm run dev`, `npm run check` before every hand-back, `npm run check:fast`, one API test with `node --import tsx --import ./test/setup.ts --test apps/api/test/<file>`, `npm run seed:user -w @ebook-reader/api`), and the places that mislead: `pretest` and `pretypecheck` build `shared` and `typeset` first, `.env` sits at the repo root, the internal scope is `@ebook-reader/*` on purpose (D32), and the web app is served under `/atrium/`. Also the hard rules the repo holds today: no secrets in the repo, no CI, no pushes by agents.
8. **Corpus.** Add a [wiki/decisions.md](../../wiki/decisions.md) entry "The house style, formatted and checked" (the width, the config source, what was rejected and why). Update [wiki/status.md](../../wiki/status.md) and [log.md](../../log.md). Run `bash corpus/lint.sh` until it is clean.

## Acceptance

- [ ] `npm run check` passes. Its run time and `check:fast`'s, warm with one changed file, are in the outcome note, and `check:fast` is under about 15 s or the owner has accepted the time.
- [ ] `npx prettier --check .` passes. The reformat is one commit that changes whitespace only (`git diff -w <hash>^ <hash>` shows nothing outside the reformat), and its hash is in `.git-blame-ignore-revs`.
- [ ] `tsconfig.base.json` has `verbatimModuleSyntax` and `erasableSyntaxOnly`. `npm run typecheck` and `docker build` of `infrastructure/Dockerfile` pass.
- [ ] `npx eslint .` reports zero errors. The counts before and after are in the outcome note, with every finding left and its reason.
- [ ] A deliberate `enum`, `!` in `apps/api/src`, `console.log` in a service, `// TODO` and `export default` in a non-config file each fail `npm run lint`. Revert them after.
- [ ] `npm test` passes from a fresh clone (`pretest` builds the packages).
- [ ] `.claude/rules/web.md` and `server.md` exist with `paths:` frontmatter, and `CLAUDE.md` lists `npm run check`.
- [ ] With the plugin's hooks on, an agent's edit is formatted on save, and a type error stops it at `Stop`.
- [ ] `bash corpus/lint.sh` ends clean.

## Interplay

- Brief 03 adds `better-tailwindcss` and drops `check-base-ui`'s `--warn-only`. Brief 04 adds dependency-cruiser, drops `check-structure`'s `--warn-only`, and turns `no-process-env` into an error.
- If brief 04 moves `apps/api/src/modules/` to `features/`, the reformat's hash still holds: the `git mv` keeps blame through the ignore file.
- The 303 test `!` in `packages/typeset/test` and the 129 in `packages/typeset/src` are the bulk of the debt, in a package nothing else here touches. If the owner prefers, the typeset package takes `no-non-null-assertion` as a warning until a later brief.
