# house-style 1.1.0 (vendored)

This directory is a copy of house-style, the shared ESLint, Prettier, TypeScript,
knip and dependency-cruiser configs of the house repos. It is generated: do not
edit these files. To upgrade, run `npm run house-style:sync -- <tag>`, then follow
the upgrade notes. `npm run house-style:sync -- --check` says whether the copy
still matches its commit.

- **Version:** 1.1.0
- **Source:** the `my-personal-skills` repository, folder `house-style/`
- **Commit:** `e9de59a848f88aa9ebb4c09ebf9468770663f06e`
- **Upgrade notes:** `house-style/CHANGELOG.md` in the same repository (copied here as `CHANGELOG.md`)

| File | What it is |
|---|---|
| `.dependency-cruiser.cjs` | The dependency-cruiser preset: cycles, unresolvable imports, feature boundaries |
| `CHANGELOG.md` | The upgrade notes, one section per version |
| `LICENSE` | MIT |
| `bin/check-base-ui.mjs` | The Base UI and Tailwind checker, run by `check:conventions` |
| `bin/check-structure.mjs` | The code-structure checker, run by `check:conventions` |
| `bin/conventions.mjs` | What the two checkers share: reading `conventions.json`, walking the roots, the report |
| `bin/sync.mjs` | This sync (`npm run house-style:sync`) |
| `conventions.schema.json` | The JSON Schema of `conventions.json`, for editors |
| `eslint.config.js` | `houseStyle(options)`, the ESLint flat config as a function of the repo's folders |
| `knip.json` | The knip preset: unused files and dependencies are errors, unused exports warnings |
| `package.json` | house-style's version, its pinned dependencies, and `"type": "module"` for the configs |
| `prettier.config.js` | The Prettier config: width 120, trailing commas, Prettier's defaults otherwise |
| `tsconfig.base.json` | The compiler flags every package's tsconfig extends |

The repo's own configs import or extend these files by relative path.
