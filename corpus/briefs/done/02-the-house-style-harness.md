# Task 02: The house style and the quality harness

**Depends on:**

- In Atrium: brief 01, so the reformat lands on a tree already on Base UI 1.9.0.
- In the owner's skills library:
  - brief 27, *A house style, and a quality harness that enforces it*: the `house-style` package at `v1.0.0` (vendored here, decision 1), the `house-style` skill, and the plugin's `Stop` and `PostToolUse` hooks;
  - brief 15, *Enforce the base-ui and code-structure skills in every repo*: how the convention checkers are wired and when they run `--warn-only`.
- The owner's grilling of 2026-11-10 and its technical calls: Q5-Q14, Q27, Q45, Q46 and Q47-Q51. Every question is answered; the decisions below record each.

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

120 has the least total churn (4,572 lines). 130 adds fewer lines but removes 1,000 more, because Atrium's code wraps at about 100 and wider widths join lines. The biggest single change at 120 is `packages/typeset/src/macro/builtins.ts` (+330, -75). The estate's one width is **120** (Q8 and Q51), so Atrium's least-churn width is the estate's, and the one-off reformat is the 1,992 lines added and 2,580 removed above, in one commit that blame ignores. JSON and Markdown were not measured.

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

## Decisions

Items marked "decided" are final. The rest are defaults this brief builds.

1. **Where the configs come from** (decided 2026-11-10, technical call, Q6). `house-style` is **vendored**: a copy under `vendor/house-style/` at the repo root with a version header (`v1.0.0`), refreshed by a `house-style:sync` script in the root `package.json` that finds the `house-style` checkout by name. No git, `github:` or tarball dependency. The Docker builder stage copies only the manifests, `tsconfig.base.json`, `packages` and `apps`, and runs no lint, so the image never needs the vendored folder or `git`. The one shared file the build reads is `tsconfig.base.json`, so the house tsconfig flags are written into it, not extended from the vendored copy. `vendor/house-style/` is in `.prettierignore` and ESLint's ignores.
2. **Width** (decided 2026-11-10, technical call, Q8 and Q51). `printWidth` is **120**, which is already Atrium's least churn. The measured table is kept.
3. **Markdown and the generated docs stay out of Prettier** (decided 2026-11-10, technical call, Q45). `.prettierignore` lists `*.md`, `apps/docs/docs/wiki/` (generated, gitignored), `apps/docs/dist`, `apps/docs/.docusaurus`, `apps/web/public/`, `packages/typeset/assets/`, the two `apps/*/vendor/` folders, `vendor/house-style/`, `package-lock.json`, `dist/` and the library data folders. Prettier covers the TypeScript, TSX, JS, CSS and JSON the repo writes.
4. **tsconfig** (decided 2026-11-10, technical call, Q11 and Q50). Add `verbatimModuleSyntax` and `erasableSyntaxOnly` to the base now (typeset already has them; the TypeScript here is 5.9.3, past the 5.8 these need), and the six parameter properties become fields. `exactOptionalPropertyTypes` waits for a count. **`noUncheckedIndexedAccess` is deferred** (Q50): 107 errors in the web app, 17 in the API source (46 with tests) and 47 in typeset's tests, and it changes what the 485 `!` mean. A later brief per repo where it is off takes it, with these counts as its start. That brief is not written yet.
5. **`NodeNext` for the API.** Default: set `module` and `moduleResolution` to `NodeNext` in `apps/api/tsconfig.json` only (measured: 0 errors). Under `Bundler` a missing `.js` suffix typechecks and then fails when Node runs `dist/`. The web app, which Vite builds, stays on `Bundler`. *Repo question.*
6. **Typed lint** (decided 2026-11-10, technical call, Q12). The six rules, through `projectService` unless `project` measures faster. `no-floating-promises` names `node:test`'s `describe`, `it` and `test` in `allowForKnownSafeCalls`. Without it the rule is unusable here.
7. **The house shapes as errors** (decided 2026-11-10, technical call, Q13, Q47 and Q48). `enum`, `console` outside scripts and CLIs, default exports outside framework files (config files, route modules) and `TODO`/`FIXME` are errors. `no-non-null-assertion` is an **error in source and a warning in tests** (Q47), and `switch-exhaustiveness-check` sets `considerDefaultExhaustiveForUnions: true` (Q48). `.d.ts` module declarations are excepted from the default-export rule. `no-process-env` (from `eslint-plugin-n`) starts as a **warning** and brief 04 makes it an error.
8. **Test lint** (decided 2026-11-10, technical call, Q27: Atrium stays on `node:test`). No test-lint plugin applies to `node:test`. Record that in the outcome note; `describe.only` and `it.only` are caught by `node --test --test-only` only if used, so add a plain `no-restricted-syntax` selector for `.only(` calls on those names if it takes one line.
9. **`check:fast`** (decided 2026-11-10, technical call, Q10). A typecheck of the touched workspaces plus ESLint on the changed files, built incrementally, target about 15 s warm with one changed file, accepted up to about 30 s where `tsc` alone is slower.
10. **The Claude Code layer** (decided 2026-11-10, technical call, Q7). The plugin's hooks: `Stop` runs `check:fast`, `PostToolUse` formats the saved file.
11. **The root `CLAUDE.md`** (decided 2026-11-10, technical call, Q46). A short root `CLAUDE.md` with the commands, under about 60 lines. The corpus schema it holds today moves to a new `corpus/CLAUDE.md`, as Almanac has it, and the root file points at it.

## Files you OWN

- `tsconfig.base.json`, `apps/api/tsconfig.json` (decision 5), and the `.d.ts` or source files a typed rule asks to change.
- New: `eslint.config.js`, the Prettier config, `.prettierignore`, `.git-blame-ignore-revs`.
- The root `package.json` (scripts, devDependencies) and `package-lock.json`. Pin each new dev dependency exactly.
- The reformat itself: whitespace-only changes to every file Prettier covers.
- The fixes the new rules ask for:
  - `apps/api/src/modules/jukebox/jukebox.service.ts` and `apps/api/src/modules/lookup/lookup-http.ts` (the six parameter properties);
  - the 9 floating and 20 misused promises in `apps/web/src` (list above): `void` the first, wrap the second in a sync handler;
  - the 41 `!` in `apps/api/src` (34) and `apps/web/src` (7), in step 5, and the 129 in `packages/typeset/src`, in step 6, each in its own commits;
  - the rest found in step 1.
- New: `vendor/house-style/`, `.claude/rules/web.md`, `.claude/rules/server.md`, `corpus/CLAUDE.md` (the schema moved out of the root file), and the rewritten root `CLAUDE.md`.
- `scripts/conventions.json` (brief 15's exceptions file), if an exception is needed.
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
   1. Add `prettier` (pinned) and the config: `printWidth: 120` (decision 2), `trailingComma: "all"`, the rest default.
   2. Add `.prettierignore` per decision 3.
   3. Add `"format": "prettier --write ."` and `"format:check": "prettier --check ."`, and commit this alone.
   4. Run `npm run format` and commit only that, as `style: format with Prettier`: the one-off reformat at 120. Run it when no other brief has uncommitted work.
   5. Add that commit's full hash to `.git-blame-ignore-revs`, in its own commit.
   6. Hand the owner the one-time `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
3. **tsconfig.** Add `verbatimModuleSyntax` and `erasableSyntaxOnly` to the base, and `NodeNext` to the API per decision 5.
   - Fix the six parameter properties with a declared field assigned in the constructor. Behaviour and `readonly` stay.
   - `npx tsc -b`-equivalent builds still pass: `npm run build` and `docker build` of `infrastructure/Dockerfile`.
4. **ESLint, from scratch.** `eslint.config.js` at the root: `@eslint/js` recommended, typescript-eslint recommended, `eslint-plugin-react-hooks` 7.1.1 recommended on `apps/web/src`, the six typed rules, and the table below. Ignore `**/vendor/**`, `**/dist/**`, `apps/docs/**`, `apps/web/public/**`. Typed linting needs the four tsconfigs as `project`, or `allowDefaultProject` for config files.

   | Rule | After | Findings today |
   |---|---|---|
   | the six typed rules | error | 9 + 20 + 1 + 608 (step 1 re-measures) |
   | `@typescript-eslint/no-non-null-assertion` | error in source, warn in tests | 170 source (41 in `apps/api/src` and `apps/web/src`, 129 in `packages/typeset/src`), 315 test |
   | `no-restricted-syntax` on `TSEnumDeclaration` | error | 0 |
   | `no-warning-comments` (`todo`, `fixme`), pointing at `corpus/briefs/` (there is no `todos/`, see [CLAUDE.md](../../../CLAUDE.md)) | error | 0 |
   | `no-console` outside the CLIs | error | 11 in `apps/api/src` beyond the seed CLI: migrations (3), `config.ts` (2), `index.ts` (1), three services (5) |
   | `no-default-export` (`eslint-plugin-import-x`) outside `*.config.*`, `sidebars.ts` and `.d.ts` | error | 1: `apps/docs/src/components/Diagram.tsx:33` (docs are ignored, so 0 in scope) |
   | `no-process-env` (`eslint-plugin-n`) on `apps/api/src` outside `common/config.ts` and tests | **warn**; brief 04 makes it an error | 6 sites, listed in brief 04 |
   | `no-explicit-any`, `ban-ts-comment` | error (recommended) | 0 |

   The `console` findings are real log calls. The default is to route the ones in `latex-compile.service.ts`, `convert.service.ts` and `extract.service.ts` through the `log` those services already receive or build; if one has no logger in reach, list it in `scripts/conventions.json` with the reason. Fix what the typed rules find, or list each finding left, with its reason, in the outcome note. The `!` findings are left to steps 5 and 6, so step 4 turns `no-non-null-assertion` on as a warning and steps 5 and 6 make it an error.
5. **The `!` in `apps/api/src` and `apps/web/src`** (41 sites: 34 and 7). One commit per workspace. Where the compiler already types the value as non-null (`no-unnecessary-type-assertion` says "does not change the type"), delete the `!`. Where it is a real assertion, narrow with a check or a named error. Behaviour stays. The rule is an error for these two workspaces at the end.
6. **The `!` in `packages/typeset/src`** (129 sites, the bulk of the debt, in a package nothing else here touches). Its own commits, one per source folder that holds `!` (`macro/`, `layout/`, `pdf/` and the rest; list them in step 1), so a regression bisects to a folder. The same rule: delete a no-op `!`, narrow a real one. `npm test -w` the package after each commit: its 303 test `!` stay warnings. The rule becomes an error for `packages/typeset/src` at the end.
7. **The gate.** In the root `package.json`:
   - `check` runs `typecheck`, `lint`, `format:check`, `check:conventions` and `test`;
   - `check:conventions` is knip plus the two convention checkers from the `house-style` package. `check-base-ui` runs `--warn-only` until brief 03 is done, `check-structure` `--warn-only` until brief 04 is done;
   - `check:fast` runs the typecheck, then ESLint on the files changed against `HEAD` plus untracked ones. Use the package's script, or a small Node script in `scripts/`. No shell-only syntax: the owner works on Windows under WSL;
   - `lint` is `eslint .`.

   Time `check:fast` warm with one changed file, and `check` in full. Record both.
8. **`.claude/rules/`.** Each file under about 40 lines, scoped by `paths:`, pointing at the skill for the rest.
   - **`web.md`** (`apps/web/src/**`): the Reading Room conformance checklist in [wiki/design.md](../../wiki/design.md) is the design gate; Base UI only through `components/ui/` wrappers (brief 03); light, sepia and dark are all checked; no raw hex in components; the `data-theme` attribute is the theme switch.
   - **`server.md`** (`apps/api/src/**`, `packages/shared/src/**`): read [wiki/api-layering.md](../../wiki/api-layering.md); a controller owns HTTP, a service the rules, a model the SQL; a service returns a tagged union for a normal outcome; every notes, folders and LaTeX query is keyed on `profile_id`, and a foreign id is a 404, never a 403; `apps/api/vendor/` is generated; tests go through `buildTestApp` in `apps/api/test/harness.ts`; a thrown error is a 500 that says nothing.

   Briefs 03 and 04 add the Tailwind, Base UI and structure lines.
9. **`CLAUDE.md`** per decision 11: move the corpus schema to `corpus/CLAUDE.md`, and write the short root file with the commands (`npm run dev`, `npm run check` before every hand-back, `npm run check:fast`, one API test with `node --import tsx --import ./test/setup.ts --test apps/api/test/<file>`, `npm run seed:user -w @ebook-reader/api`), and the places that mislead: `pretest` and `pretypecheck` build `shared` and `typeset` first, `.env` sits at the repo root, the internal scope is `@ebook-reader/*` on purpose (D32), and the web app is served under `/atrium/`. Also the hard rules the repo holds today: no secrets in the repo, no CI, no pushes by agents.
10. **Corpus.** Add a [wiki/decisions.md](../../wiki/decisions.md) entry "The house style, formatted and checked" (the width, the config source, what was rejected and why). Update [wiki/status.md](../../wiki/status.md) and [log.md](../../log.md). Run `bash corpus/lint.sh` until it is clean.

## Acceptance

- [ ] `npm run check` passes. Its run time and `check:fast`'s, warm with one changed file, are in the outcome note, and `check:fast` is under about 15 s or the owner has accepted the time.
- [ ] `npx prettier --check .` passes. The reformat is one commit that changes whitespace only (`git diff -w <hash>^ <hash>` shows nothing outside the reformat), and its hash is in `.git-blame-ignore-revs`.
- [ ] `tsconfig.base.json` has `verbatimModuleSyntax` and `erasableSyntaxOnly`. `npm run typecheck` and `docker build` of `infrastructure/Dockerfile` pass.
- [ ] `npx eslint .` reports zero errors, including `no-non-null-assertion` in all source folders (the 41 and the 129 gone) and still only warnings in tests. The counts before and after are in the outcome note, with every finding left and its reason.
- [ ] A deliberate `enum`, `!` in `apps/api/src`, `console.log` in a service, `// TODO` and `export default` in a non-config file each fail `npm run lint`. Revert them after.
- [ ] `npm test` passes from a fresh clone (`pretest` builds the packages).
- [ ] `.claude/rules/web.md` and `server.md` exist with `paths:` frontmatter, and the root `CLAUDE.md` (under about 60 lines) lists `npm run check`, with the corpus schema in `corpus/CLAUDE.md`.
- [ ] With the plugin's hooks on, an agent's edit is formatted on save, and a type error stops it at `Stop`.
- [ ] `bash corpus/lint.sh` ends clean.

## Interplay

- Brief 03 adds `better-tailwindcss` and drops `check-base-ui`'s `--warn-only`. Brief 04 adds dependency-cruiser, drops `check-structure`'s `--warn-only`, and turns `no-process-env` into an error.
- If brief 04 moves `apps/api/src/modules/` to `features/`, the reformat's hash still holds: the `git mv` keeps blame through the ignore file.
- The 303 test `!` in `packages/typeset/test` stay warnings (Q47). The 129 in `packages/typeset/src` are fixed in step 6, in their own commits, not deferred.
- The deferred `noUncheckedIndexedAccess` (Q50) will turn some deleted `!` into needed narrowing; its later brief owns that.

## Outcome (2026-11-11)

Adopted the house-style harness at 1.1.0, vendored in `vendor/house-style/`, with the Claude Code layer. Atrium's own flag and Docker constraints are in D60.

**Commits** (local, on main, in order): vendor 1.1.0 (`ae27dc9`); TypeScript 6.0.3 and the tool pins (`bde3730`); Prettier config, ignore and scripts (`fba1f1d`); the reformat (`2890a98`, the only commit that changes layout); blame-ignore (`3c2d472`); tsconfig flags, NodeNext for the API and the six parameter properties (`1ec80d6`); ESLint and the typed-rule fixes (`7ca083a`); the gate with knip and dependency-cruiser (`582e4e6`); the `!` removals per workspace and per typeset folder (`a908860`, `24d9227`, `ddec5d5`, `04a865d`, `b32ffc5`, `e2aba3b`, `3bcd0dd`, `f0bcd2f`) with the rule turned to an error (`7199f9a`, `0f7ae9c`); CLAUDE.md, corpus/CLAUDE.md and the rules files; `.npmrc` `save-exact`.

**Gate.** `npm run check` exits 0 (1 m 44 s, 794 tests: 647 typeset, 147 API). `check:fast` with one file changed: 33 s (the typecheck is most of it: `pretypecheck` builds the two packages, then five `tsc` runs). That is over the brief's 15 s target and the 30 s it accepts; the cause is that the gate typechecks every workspace, not only the touched ones. `npx prettier --check .` and `npm run house-style:sync -- --check` exit 0. `npm run lint` alone is about 38 s cold.

**Reformat.** 193 files, 2,180 lines added and 2,896 removed (the brief measured 185 files over TypeScript, JavaScript and CSS; the rest are JSON, HTML and the like). Bundle compare (esbuild minify per file, CSS through the `css` loader, JSON parsed; 335 files): five differences, all JSX text split by Prettier with `{" "}`, which renders the same: `apps/docs/src/components/Diagram.tsx`, `apps/web/src/jukebox/PlaylistPanel.tsx`, `apps/web/src/latex/PublishDialog.tsx`, `apps/web/src/profiles/ManageProfiles.tsx`, `apps/web/src/reader/chrome/ConvertControl.tsx`. Four JSONC tsconfigs with comments are unparseable as JSON and were not compared.

**Pins.** All twelve exact. npm took TypeScript 6.0.3 in the four workspaces with no peer conflict; `apps/docs` keeps 5.9.3 (Docusaurus, outside the harness), reported by the sync as pin drift. `.npmrc` gained `save-exact=true`.

**Rule counts, before the fixes and after (errors unless noted).**

| Rule | Before | After |
|---|---|---|
| `no-floating-promises` | 9 (814 `node:test` calls allowed) | 0 |
| `no-misused-promises` | 20 | 0 |
| `switch-exhaustiveness-check` | 1 (test) | 0 |
| `no-non-null-assertion` | 170 source, 315 test | 0 source (147 deleted as no-ops, 23 narrowed), 315 test warnings |
| `no-console` | 11 in the API source beyond the seed CLI, 12 in tests | 0 (files listed in `console`, three services recorded in `scripts/conventions.json`) |
| `n/no-process-env` | 6 | 6 warnings, in `index.ts`, `calibre.service.ts`, `seed-user.ts` |
| enum, `any`, ts-comments, TODO, default exports | 0 | 0 |
| `react-hooks/refs`, `set-state-in-effect`, `immutability`, `preserve-manual-memoization` | 27, 17, 1, 1 | the same 46, as warnings |
| `react-hooks/rules-of-hooks` | 2 (`useMap` was a local helper) | 0, renamed `applyMap` |
| `react-hooks/exhaustive-deps` | 1 missing dep, 1 stale disable | 1 disable with its reason, 1 removed |
| `no-useless-assignment`, `no-useless-escape` | 5, 1 | 0 |
| `no-unnecessary-type-assertion` | 608 | off (ruling 6) |

**Checkers** (`check:conventions` also runs knip and depcruise). `check-base-ui --warn-only`: 9 warnings, 8 of them errors when strict (rule 3: 7, rule 5: 1, rule 9: 1), as in the earlier run. `check-structure --warn-only`: 137 warnings, 94 of them errors when strict (rule 1: 1, rule 3: 6, rule 6: 87), plus rule 11: 43 (a file over 400 lines, a warning anyway). knip: exit 0 with 131 unused exports and 100 unused types as warnings; its errors were two unused dependencies (`react-swipeable`, `@types/adm-zip`, both removed; adm-zip 0.6.1 ships its own types), the unlisted `pdftotext` binary and `@playwright/test`, which the owner's local test hub uses (both ignored in `knip.config.js` with the reason). dependency-cruiser: 26 `no-circular` errors, 22 in `packages/typeset/src` and 4 in the LaTeX editor; the rule alone is a warning (`.dependency-cruiser.cjs`).

**Deliberate violations** (each exits 1 under `eslint` and together under `npm run lint`): an `enum`, a `!` in `apps/api/src`, a `console.log` in a service, a `// TODO`, an `export default`. Reverted.

**Hooks**, run by hand with Claude Code's event JSON: the formatter hook formatted a messy `apps/api/src/common` file; the Stop hook, after a save noted by `note-saved-file.mjs`, exited 2 with `TS2322` from a type error, and 0 once the file was removed.

**Docker.** `docker build` skipped (local Docker is unusable). The builder stage's three `npm run build -w` runs pass in the checkout, and `npm ci --dry-run` accepts the lockfile.

**Deviations and calls.**
- The 170 `!`: the brief deletes the ones the compiler types as non-null; ruling 6 says not to autofix `no-unnecessary-type-assertion`. I used that rule as a locator in a script, deleting only a `!` that both it and `no-non-null-assertion` reported, and left the rule off in the config. When `noUncheckedIndexedAccess` comes on, the deleted `!` on indexed reads turn into compile errors the later brief fixes (its start: 107 web, 17 API source, 47 typeset tests).
- `present()` (`apps/api/src/common/present.ts`) is new: a named error instead of `!` for values a guard or a write guarantees.
- The four React compiler rules stay warnings (46 findings; a fix changes behaviour). **Question for the owner:** fix them one at a time with a test around each, or keep them as warnings?
- Typed lint uses the four tsconfigs under `typed.project`, not `projectService`: the tests are not in the build tsconfigs. The `projectService` timing was not measured.
- `check:fast` runs the whole typecheck, not the touched workspaces (33 s).
- Root `package.json` gained `"type": "module"` so the root configs load without a warning; every workspace has its own manifest.
- `apps/docs` MDX files and the generated `static/reference/` and `static/diagrams/` stay out of Prettier too (the brief listed the first two folders only).

**For house-style.** (1) `eslint.config.js` has no way to give the `tests` option a glob that skips JSON-named files; `**/*.test.*` matches `tsconfig.test.json`, which ESLint then parses as JavaScript. Atrium uses the extension form. (2) `no-console` has no test exemption: tests that replace `console.error` to read what a service logged need the `console` option, which the README says is for app files. (3) The README says a sync with `save-exact` missing adds it to `.npmrc`, but the sync only reports; Atrium added it by hand. (4) knip reports `dependency-cruiser` unused until the script runs it, so the preset and `check:conventions` should land in one commit.

**Checks skipped:** docker build (see above); the live-session hook check waits for the plugin update on this machine; the base-ui behaviour comparison was never part of this brief.

**Owner steps.** `git config blame.ignoreRevsFile .git-blame-ignore-revs`; deploy with `node cli.ts atrium deploy` from the vps-deploy checkout.
