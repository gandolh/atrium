# Changelog

house-style's versions, newest first. Each section is the upgrade note for a
repo moving to that version: what changed, and what to fix before syncing it.
Tags are `house-style-v<version>`.

## 1.1.0 (2026-11-11)

Folds in what the eight repos that adopted 1.0.0 on 2026-11-11 reported
(wicket, the todo app in mini-projects, 3D-sandbox, imbatranim-apps, Lantern,
SocialEvents, Satchel, Newspapper). A repo on 1.0.0 syncs `house-style-v1.1.0`,
runs `npx eslint --fix .`, then `npm run check`; the list below says what each
change does to it.

- **The sync's target** (`bin/sync.mjs`): the copy goes to the folder of the
  nearest `package.json` at or above the working directory, without going
  above the git toplevel. A repo with its `package.json` at the root is
  unchanged. An app in a subfolder of a multi-project repo now takes the copy
  in its own folder when the sync runs there, so mini-projects can drop its
  `scripts/house-style-sync.mjs` wrapper and its `GIT_CEILING_DIRECTORIES`
  setting. From a workspace folder that has its own `package.json`, the copy
  now goes to that workspace, not the repo root: run the sync from the root.
  The sync also refuses to run anywhere inside the library checkout.
- **`env` option** (`houseStyle()`): globs where `n/no-process-env` is off,
  default `["**/config.ts"]`, so nothing changes by default. A repo whose env
  reader is `config/env.ts` passes `env: ["server/src/config/env.ts"]` and
  deletes its own block for it. Tests, scripts and `*.config.*` stay exempt.
- **`assertFunctionNames` option**: the names `vitest/expect-expect` counts as
  assertions, default `["expect", "expectTypeOf"]`. A repo with helpers
  (`expectError`, `expectUnauthorized`, `expectPoint`) passes them and deletes
  its own `expect-expect` block.
- **`@typescript-eslint/no-import-type-side-effects`: error**, beside
  `consistent-type-imports`. With `verbatimModuleSyntax`, `import { type X }
  from "./a.js"` still emits `import {} from "./a.js"`. A repo that wrote
  all-inline type imports sees findings; `npx eslint --fix` turns them into
  `import type { X }`.
- **`defaultExports`**: `**/*.d.ts` joins the built-in config-file exemption,
  so an ambient `declare module` with `export default` needs no entry. A repo
  with that entry can drop it.
- **dependency-cruiser**: `not-to-unresolvable` allows `^virtual:` module ids
  (Vite virtual modules). A repo with an override for them can drop it.
- **knip**: no change to the preset. knip drops a preset's top-level `entry`
  once a repo sets `workspaces`, so the preset can't carry
  `scripts/*.{js,mjs,ts}`; the README's sample lists it for the repo to add.
- **`check-structure` rule 11** (the file-size warning) skips test files, as
  rules 1, 3 and 6 do. A repo's long test files stop being warnings.
- **`check-base-ui` rule 5**: when the one stylesheet sits somewhere other
  than `styles/index.css`, the message names the `"stylesheet"` key in
  `conventions.json` as the way to declare it.
- **The Stop hook** (the plugin, 0.41.0): finds `check:fast` from the folders
  of the files the session saved, runs each distinct one once, and falls back
  to the working directory only when no saved file leads to one. An app folder
  in a multi-project repo no longer needs a scripts-only root `package.json`
  for the hook.
- **Documentation**: the README, the adoption reference and the skill say what
  the repos found. Two projects in one copy (pins in the folder that holds
  `vendor/house-style/`, knip `ignoreBinaries`); `check-fast` with
  `git diff --name-only --relative HEAD`; `projectService` and Vite solution
  tsconfigs; Playwright specs and the `tests` default; knip config names and
  `ignoreDependencies`; `format` until `format:check` passes; anchored
  `.prettierignore` entries; when a repo keeps its own tsconfig base; turning
  `no-unnecessary-type-assertion` off until `noUncheckedIndexedAccess` lands;
  the vitest and `react-hooks` notes; merging a `forbidden` entry by name;
  `console` against `scripts` against `env`; `no-restricted-syntax` selectors
  for `autoFocus` and a `<button>` without `type`, because `jsx-a11y` 6.10.2
  doesn't support ESLint 10; and `tsc` after a knip cleanup.

To move a repo from 1.0.0:

1. `npm run house-style:sync -- house-style-v1.1.0` (from the app's folder in a
   multi-project repo), and commit the copy.
2. `npx eslint --fix .`, then review the `import type` rewrites it made.
3. Replace the repo's own `n/no-process-env` block for its env reader with
   `env: [...]`, and its own `expect-expect` block with `assertFunctionNames`.
   Remove any `*.d.ts` entry in `defaultExports` and any `virtual:` override.
4. `npm run check`.

## 1.0.0 (2026-11-11)

The first version. A repo adopting it takes the reformat commit, the configs
and the pins below in one go (the `house-style` skill has the steps).

- **ESLint** (`houseStyle(options)`): `@eslint/js` and `typescript-eslint`
  recommended; `_`-prefixed unused names; the six typed rules through
  `projectService` (`no-floating-promises` with `node:test`'s `describe`, `it`
  and `test` as known-safe calls, `no-misused-promises`, `await-thenable`,
  `switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions`,
  `no-unnecessary-type-assertion`, `consistent-type-imports`); `react-hooks`
  recommended on `web`; `better-tailwindcss/no-unknown-classes` and
  `no-deprecated-classes` on `web` with `tailwind`, and
  `enforce-consistent-class-order` with `tailwind.order`; `n/no-process-env`
  outside `config.ts`, tests, tool configs (`*.config.*`) and scripts (not the
  `console` globs: a CLI may print, but reads its settings through `config.ts`);
  `@vitest/eslint-plugin` recommended on tests, with `valid-expect`'s
  `maxArgs: 2` and without `no-conditional-expect` (the house asserts inside a
  `catch`); and the house shapes as errors: no `enum`, no
  `any`, no `!` (a warning in tests), `@ts-expect-error` with a description
  only, no `TODO` or `FIXME` comment, no `console` outside scripts and CLIs, and
  no default export outside configs and the `defaultExports` globs.
- **Prettier**: width 120, `trailingComma: "all"`, Prettier's defaults
  otherwise.
- **TypeScript**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `isolatedModules`, `noUnusedLocals`, `noFallthroughCasesInSwitch`, `NodeNext`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `target` ES2023 and
  `skipLibCheck`.
- **knip** and **dependency-cruiser** presets.
- **The sync**, `bin/sync.mjs`.
- **The convention checkers**, run by `check:conventions`:
  `bin/check-base-ui.mjs` (the `base-ui` skill's rules 1, 2, 3, 5, 6 and 11 as
  errors, 9 and 10 as warnings; `--version` sets the Base UI pin, 1.9.0 by
  default) and `bin/check-structure.mjs` (the `code-structure` skill's rules 1,
  2, 3 and 6 as errors, 11 as a warning; 5 and 7 are the dependency-cruiser
  preset's). Both take `--warn-only`, print `file:line rule-N severity: message`,
  exit 1 on an error left and 2 when they can't check.
- **The `base-ui` skill's numbers** (2026-11-11, brief 02): the skill has 17
  rules, so a `conventions.json` exception may name base-ui rules 1 to 17
  (14 to 17, like 4, 7, 8, 12 and 13, are review's, recorded rather than
  checked). Rule 9 no longer warns when a trigger's first child is a part of
  its own component, such as `<Select.Value>` in `<Select.Trigger>`: that is
  the component's anatomy, not a wrapped control.
- **`conventions.json`**, read by both checkers from the repo root, `scripts/`
  or `tools/`: the `web`, `server` and `shared` roots, the `ui` folders, the
  one `stylesheet`, and `exceptions`, each with its check, rule, path and a
  required reason. `conventions.schema.json` describes it for editors.
- **Pins**: ESLint 10.9.1, `@eslint/js` 10.0.1, `typescript-eslint` 8.72.2,
  TypeScript 6.0.3, `eslint-plugin-react-hooks` 7.1.1,
  `eslint-plugin-better-tailwindcss` 4.10.0, `eslint-plugin-n` 18.5.0,
  `@vitest/eslint-plugin` 1.6.28, `eslint-plugin-import-x` 4.18.1, Prettier
  3.9.10, knip 6.44.2, dependency-cruiser 18.7.2.
- **Node**: `^22.13.0 || ^24.0.0 || >=26.0.0`, where every pinned tool runs.
- **Folded in after the proof run on Wicket (2026-11-11)**:
  - `.cjs` files get CommonJS globals (`module`, `require`) through a
    `house-style/commonjs-globals` block, so the `.dependency-cruiser.cjs` the
    house prescribes passes `no-undef`. A repo's own block for this is
    redundant.
  - The README and the adoption reference say where scripts go: a folder of
    scripts run by hand goes in the `scripts` option; a CLI inside the app goes
    in `console`, and its environment reads move into `config.ts`.
  - The knip sample: in a repo with npm workspaces the repo's entries go under
    `workspaces: { ".": { entry } }`, and a package folder that isn't a
    workspace goes in `ignore`.
  - The tsconfig example carries the Docker caveat: a Dockerfile stage that
    copies only the repo's `tsconfig.base.json` can't extend the vendored file.
  - `check:fast` is `npm run typecheck && node scripts/check-fast.mjs`, because
    `tsc -b` misses web type errors when the web project sits outside its graph.
  - The reformat's acceptance is the bundle compare (CSS through esbuild's `css`
    loader, JSON compared parsed, every difference listed), not `git diff -w`;
    the expected difference is JSX text split with `{" "}`.
  - A temporary exception's comment says what removes it, never a brief number.
  - `no-circular` and a feature's context type: a route importing a type from
    `app.ts` is a cycle, so the harness lowers `no-circular` to `warn` by name
    until the server brief gives each feature its own options type.
- **Known:** `npm audit` reports moderate advisories for `minimatch` inside
  ESLint and typescript-eslint. Both are development tools only, and npm's one
  offered fix is a downgrade to ESLint 9, so they stay until ESLint 10's own
  dependencies move.
