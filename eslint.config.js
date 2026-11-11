import { houseStyle, restrictedSyntax } from "./vendor/house-style/eslint.config.js";

/**
 * The house config from the vendored house-style copy, given Atrium's folders. Thin on purpose: the
 * compiler is the first gate, and the house adds only what it cannot see. The rules and the reason
 * for each are in the copy.
 */
export default [
  ...houseStyle({
    root: import.meta.dirname,
    web: "apps/web/src",
    server: ["apps/api/src", "packages/shared/src", "packages/typeset/src"],
    // Tests run on node:test, so the vitest rules are off. Test helpers sit beside the tests.
    vitest: false,
    tests: ["**/*.test.{ts,tsx,js,jsx,mjs,cjs}", "**/test/**"],
    // Allowed to print: the seed command talks to the person running it; the entry, the config check and the
    // migrations print before a logger exists or outside the server; the three services have no logger in
    // reach (module-level state, recorded in scripts/conventions.json); tests hook console to read what a
    // service printed.
    console: [
      "apps/api/src/scripts/seed-user.ts",
      "apps/api/src/index.ts",
      "apps/api/src/common/config.ts",
      "apps/api/src/database/migrations/20260830000000-baseline.ts",
      "apps/api/src/database/migrations/20260925000000-prune-cutover-orphans.ts",
      "apps/api/src/modules/latex/latex-compile.service.ts",
      "apps/api/src/modules/library/convert.service.ts",
      "apps/api/src/modules/library/extract.service.ts",
      "**/test/**",
      "**/*.test.{ts,tsx}",
    ],
    // Tests sit in tsconfigs that projectService does not find (they are not in the build configs).
    typed: {
      project: [
        "apps/web/tsconfig.json",
        "apps/api/tsconfig.test.json",
        "packages/shared/tsconfig.json",
        "packages/typeset/tsconfig.test.json",
      ],
    },
    // The docs site is a Docusaurus workspace with its own build and checks; the public folder is static.
    ignores: ["apps/docs/**", "apps/web/public/**"],
  }),
  {
    name: "atrium/restricted-syntax",
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax,
        {
          selector: "CallExpression[callee.property.name='only'][callee.object.name=/^(describe|it|test)$/]",
          message: "Remove `.only`: it silently skips every other test.",
        },
      ],
    },
  },
  {
    // Off for now (2026-11-11): tsconfig.base.json does not set noUncheckedIndexedAccess, and without it this
    // rule calls every `!` on an indexed read unnecessary, and its autofix strips them. When the flag comes
    // on, this block goes.
    name: "atrium/no-unnecessary-type-assertion-off",
    rules: { "@typescript-eslint/no-unnecessary-type-assertion": "off" },
  },
  {
    // Warnings for now (2026-11-11): these files still read the environment themselves. When the API takes
    // its settings from config.ts, this block goes and the rule is an error again.
    name: "atrium/process-env-warns",
    files: [
      "apps/api/src/index.ts",
      "apps/api/src/modules/library/calibre.service.ts",
      "apps/api/src/scripts/seed-user.ts",
    ],
    rules: { "n/no-process-env": "warn" },
  },
  {
    // Warnings for now (2026-11-11): react-hooks 7.1.1's compiler rules find 27 refs, 17 set-state-in-effect,
    // 1 immutability and 1 preserve-manual-memoization in the web app, and fixing them changes behaviour.
    // They go back to errors once each is fixed with a test around it.
    name: "atrium/react-compiler-rules-warn",
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
];
