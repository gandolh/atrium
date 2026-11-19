/**
 * The house ESLint config, as a function of the repo's layout.
 *
 * A repo's own `eslint.config.js` imports it from the vendored copy and calls it:
 *
 *   import { houseStyle } from "./vendor/house-style/eslint.config.js";
 *   export default houseStyle({ root: import.meta.dirname, web: "web/src", server: "server/src" });
 *
 * Thin on purpose: the compiler is the first gate, and this adds only what a type
 * checker cannot see. Every rule carries the reason it is here.
 */
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import importX from "eslint-plugin-import-x";
import n from "eslint-plugin-n";
import reactHooks from "eslint-plugin-react-hooks";
import { dirname, resolve } from "node:path";
import tseslint from "typescript-eslint";

const CODE = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const TS = "**/*.{ts,tsx,mts,cts}";
const JS = "**/*.{js,jsx,mjs,cjs}";
const SOURCE_EXTENSIONS = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const CONFIG_FILES = [`**/*.config.${SOURCE_EXTENSIONS}`];
/** The vitest block's files when the repo passes no `tests`: files named as tests. */
const DEFAULT_TESTS = [`**/*.test.${SOURCE_EXTENSIONS}`, `**/*.spec.${SOURCE_EXTENSIONS}`];
/**
 * What the test relaxations reach: everything bin/conventions.mjs's `isTestFile` counts as a
 * test or a test helper. That is the test names, jest's `*-spec.*` (NestJS's `app.e2e-spec.ts`),
 * and every file in a test folder. A test of the two agreeing keeps them in step.
 */
const TEST_FOLDERS = ["test", "tests", "__tests__", "testing", "e2e"];
const TEST_LIKE = [...DEFAULT_TESTS, `**/*-spec.${SOURCE_EXTENSIONS}`, ...TEST_FOLDERS.map((dir) => `**/${dir}/**`)];
const DEFAULT_ENV = ["**/config.ts"];
const DEFAULT_ASSERT_FUNCTIONS = ["expect", "expectTypeOf"];
const DEFAULT_IGNORES = ["**/vendor/**", "**/dist/**", "**/coverage/**"];

/**
 * The `no-restricted-syntax` entries the house sets. ESLint replaces a rule's options
 * instead of merging them, so a repo that adds its own selectors spreads these first.
 */
export const restrictedSyntax = [
  {
    selector: "TSEnumDeclaration",
    message: "Write a union of string literals, or an `as const` object, instead of an enum.",
  },
];

const KNOWN_OPTIONS = new Set([
  "root",
  "web",
  "server",
  "scripts",
  "tests",
  "playwright",
  "defaultExports",
  "console",
  "env",
  "assertFunctionNames",
  "tailwind",
  "vitest",
  "typed",
  "untyped",
  "ignores",
]);

/**
 * Builds the flat config array for one repo.
 *
 * Folders (`web`, `server`, `scripts`) are paths from the repo root; `tests`, `playwright`,
 * `defaultExports`, `console`, `env`, `untyped` and `ignores` are globs from the repo root.
 *
 * @param {object} [options]
 * @param {string} [options.root] The repo root, for typed linting and the Tailwind entry (default: the working directory).
 * @param {string | string[]} [options.web] The React source folders: they get the hooks rules, and the Tailwind rules when `tailwind` is set.
 * @param {string | string[]} [options.server] The Node source folders. No rule is scoped to them in 1.0.0; the key names the root for later presets.
 * @param {string[]} [options.scripts] Folders of scripts run by hand, where `console` is the interface and `process.env` is read directly (default `["scripts"]`).
 * @param {string[]} [options.tests] The vitest files (default `**\/*.test.*` and `**\/*.spec.*`). The test relaxations reach these, and every file `isTestFile` counts as a test: `*-spec.*` names and the files in `test`, `tests`, `__tests__`, `testing` and `e2e` folders.
 * @param {string[]} [options.playwright] Globs of Playwright specs (default none): they get the test relaxations, and the vitest rules leave them alone.
 * @param {string[]} [options.defaultExports] Globs where a framework or a runtime contract needs a default export, beyond config files.
 * @param {string[]} [options.console] Globs of app files allowed to print: a CLI entry, or a module that logs before the logger exists. Their `process.env` reads are still errors.
 * @param {string[]} [options.env] Globs of the files that read `process.env`, where `n/no-process-env` is off (default `["**\/config.ts"]`). A repo whose reader is `config/env.ts` passes its path instead.
 * @param {string[]} [options.assertFunctionNames] The names `vitest/expect-expect` counts as assertions (default `["expect", "expectTypeOf"]`); a repo adds its own helpers.
 * @param {{ css: string, order?: boolean, ignore?: string[] }} [options.tailwind] The Tailwind CSS entry, whether the class order is enforced yet, and regex patterns of classes `no-unknown-classes` lets through (a hook-only class, an icon font's).
 * @param {boolean} [options.vitest] Whether tests run on vitest (default true); a `node:test` repo passes false.
 * @param {{ project?: true | string | string[], allowDefaultProject?: string[] }} [options.typed] Typed-lint parser settings: `projectService` unless `project` is given.
 * @param {string[]} [options.untyped] TypeScript globs that no tsconfig covers, linted without type information.
 * @param {string[]} [options.ignores] Globs ESLint skips, added to vendor, dist and coverage.
 * @returns {import("eslint").Linter.Config[]}
 */
export function houseStyle(options = {}) {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(key)) throw new Error(`houseStyle: unknown option "${key}"`);
  }
  const root = resolve(options.root ?? process.cwd());
  const web = list(options.web);
  const scripts = options.scripts ?? ["scripts"];
  const tests = options.tests ?? DEFAULT_TESTS;
  const playwright = options.playwright ?? [];
  const env = options.env ?? DEFAULT_ENV;
  const assertFunctionNames = options.assertFunctionNames ?? DEFAULT_ASSERT_FUNCTIONS;
  const typed = options.typed ?? {};
  const webFiles = web.map((dir) => `${trim(dir)}/**/*.{ts,tsx,js,jsx}`);

  /** @type {import("eslint").Linter.Config[]} */
  const config = [
    { name: "house-style/ignores", ignores: [...DEFAULT_IGNORES, ...(options.ignores ?? [])] },
    {
      // A repo that imports typescript-eslint for a block of its own adds its config's folder as a second
      // candidate root beside this copy's, and the parser then refuses to guess one for the files linted
      // without types. One root for every file ends the guess.
      name: "house-style/tsconfig-root",
      languageOptions: { parserOptions: { tsconfigRootDir: root } },
    },

    // The two recommended sets catch real mistakes the compiler lets through, and cost nothing to agree on.
    js.configs.recommended,
    ...tseslint.configs.recommended,

    {
      name: "house-style/base",
      files: [CODE],
      plugins: { "import-x": importX, n },
      rules: {
        // A leading underscore is how the house says a name is unused on purpose.
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
            destructuredArrayIgnorePattern: "^_",
          },
        ],
        // The house writes unions, because an enum is runtime code that Node's type stripping cannot run.
        "no-restricted-syntax": ["error", ...restrictedSyntax],
        // An `any` switches the compiler off for everything it touches, so the house writes `unknown` and narrows.
        "@typescript-eslint/no-explicit-any": "error",
        // A `!` is a crash the compiler was told not to see; source code narrows instead.
        "@typescript-eslint/no-non-null-assertion": "error",
        // A suppression must fail once the error it hides is gone, and must say why it exists.
        "@typescript-eslint/ban-ts-comment": [
          "error",
          {
            "ts-expect-error": "allow-with-description",
            "ts-ignore": true,
            "ts-nocheck": true,
            "ts-check": false,
            minimumDescriptionLength: 3,
          },
        ],
        // Todos live in corpus/todos/, where they are tracked, not in comments where they are forgotten.
        "no-warning-comments": ["error", { terms: ["todo", "fixme"], location: "start" }],
        // Output goes through the app's logger; console belongs to scripts and CLIs only.
        "no-console": "error",
        // Named exports keep one name per thing across imports, and grep finds them.
        "import-x/no-default-export": "error",
        // App code reads the environment only through config.ts, so every setting is parsed and validated in one place.
        "n/no-process-env": "error",
      },
    },
    {
      name: "house-style/process-env",
      files: [...env, ...CONFIG_FILES],
      rules: {
        // The env reader (config.ts by default) is the app's one reader of the environment, and a tool config is not app code.
        "n/no-process-env": "off",
      },
    },

    {
      name: "house-style/typed",
      files: [TS],
      languageOptions: {
        parserOptions: {
          ...(typed.project === undefined
            ? { projectService: { allowDefaultProject: typed.allowDefaultProject ?? [] } }
            : { project: typed.project }),
          tsconfigRootDir: root,
        },
      },
      rules: {
        // An unawaited promise lets a handler return before its write lands; `void` marks the deliberate ones.
        "@typescript-eslint/no-floating-promises": [
          "error",
          {
            allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["describe", "it", "test"] }],
          },
        ],
        // An async callback where a void one is expected drops its rejection on the floor.
        "@typescript-eslint/no-misused-promises": "error",
        // Awaiting a value that is not a promise usually means the call was not the one intended.
        "@typescript-eslint/await-thenable": "error",
        // A switch over a union handles every member, so a new member is a compile-time task, not a silent miss.
        "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
        // An assertion the compiler already agrees with is noise that hides the ones that matter.
        "@typescript-eslint/no-unnecessary-type-assertion": "error",
        // Type-only imports are erased by every tool alike, which `verbatimModuleSyntax` relies on.
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { disallowTypeAnnotations: false, fixStyle: "inline-type-imports" },
        ],
        // With `verbatimModuleSyntax`, `import { type X } from "./a.js"` still emits `import {} from "./a.js"`, so an import of only types is written `import type`.
        "@typescript-eslint/no-import-type-side-effects": "error",
      },
    },
    {
      // JavaScript files, tool configs and the repo's uncovered globs sit outside every tsconfig.
      ...tseslint.configs.disableTypeChecked,
      name: "house-style/untyped",
      files: [JS, ...CONFIG_FILES, ...(options.untyped ?? [])],
    },
    {
      // The house's JavaScript files are Node scripts and configs, so they see Node's globals
      // the way TypeScript files do through @types/node.
      name: "house-style/node-globals",
      files: [JS],
      languageOptions: { globals: n.configs["flat/recommended-module"].languageOptions.globals },
    },
    {
      // A .cjs file is CommonJS: `module` and `require` are globals there, and the .dependency-cruiser.cjs
      // the house prescribes would fail no-undef without them.
      name: "house-style/commonjs-globals",
      files: ["**/*.cjs"],
      languageOptions: n.configs["flat/recommended-script"].languageOptions,
    },
  ];

  if (webFiles.length > 0) {
    config.push({
      name: "house-style/react",
      files: webFiles,
      plugins: { "react-hooks": reactHooks },
      // The hooks rules, compiler rules included, catch render bugs no type can express.
      rules: reactHooks.configs.recommended.rules,
    });
  }

  if (webFiles.length > 0 && options.tailwind) {
    const css = resolve(root, options.tailwind.css);
    config.push({
      name: "house-style/tailwind",
      files: webFiles,
      plugins: { "better-tailwindcss": betterTailwindcss },
      settings: { "better-tailwindcss": { entryPoint: css, cwd: dirname(css) } },
      rules: {
        // A class Tailwind does not generate styles nothing, and is usually a typo. A repo names the
        // classes that are real but not Tailwind's (a hook-only class, an icon font's) in `tailwind.ignore`.
        "better-tailwindcss/no-unknown-classes": options.tailwind.ignore
          ? ["error", { ignore: options.tailwind.ignore }]
          : "error",
        // A deprecated class still works today and breaks on the next major version.
        "better-tailwindcss/no-deprecated-classes": "error",
        // One class order makes diffs of class strings readable; on once a repo has migrated.
        ...(options.tailwind.order ? { "better-tailwindcss/enforce-consistent-class-order": "error" } : {}),
      },
    });
  }

  if (options.vitest ?? true) {
    config.push({
      // Exactly the `tests` globs: helpers in a test folder aren't tests, and a Playwright spec isn't a vitest file.
      name: "house-style/vitest",
      files: tests,
      ...(playwright.length > 0 ? { ignores: playwright } : {}),
      plugins: { vitest },
      rules: {
        // The vitest set catches a committed `.only`, a test with no assertion, and an expect that cannot fail.
        ...vitest.configs.recommended.rules,
        // A helper that wraps `expect` counts as an assertion once the repo names it.
        "vitest/expect-expect": ["error", { assertFunctionNames }],
        // `expect(value, "message")` is how the house labels an assertion.
        "vitest/valid-expect": ["error", { maxArgs: 2 }],
        // The house asserts on a thrown error inside its `catch`, which this rule flags every time.
        "vitest/no-conditional-expect": "off",
        // A hook that checks the state it set up is part of the test, not a stray assertion.
        "vitest/no-standalone-expect": [
          "error",
          { additionalTestBlockFunctions: ["beforeAll", "beforeEach", "afterAll", "afterEach"] },
        ],
      },
    });
  }

  config.push(
    {
      name: "house-style/tests",
      files: [...TEST_LIKE, ...tests, ...playwright],
      rules: {
        // In a test a `!` fails loudly at the line that broke, so it is a warning there, not an error.
        "@typescript-eslint/no-non-null-assertion": "warn",
        // A test sets the environment up for the code it tests.
        "n/no-process-env": "off",
        // A test stubs the console and asserts on what the code printed.
        "no-console": "off",
      },
    },
    {
      name: "house-style/console",
      files: [...scripts.map((dir) => `${trim(dir)}/**`), ...(options.console ?? [])],
      rules: {
        // A script or a CLI talks to the person running it through the console.
        "no-console": "off",
      },
    },
    {
      // Only the script folders, not the `console` globs: a file allowed to print (a server entry that
      // logs before its logger exists, a seed CLI inside the app) still reads its settings through config.ts.
      name: "house-style/scripts",
      files: scripts.map((dir) => `${trim(dir)}/**`),
      rules: {
        // A script run by hand is a program of its own, not app code, so it reads its environment directly.
        "n/no-process-env": "off",
      },
    },
    {
      name: "house-style/default-exports",
      files: [...CONFIG_FILES, "**/*.d.ts", ...(options.defaultExports ?? [])],
      rules: {
        // Tool configs, ambient `declare module` files, route modules and runtime contracts are read through `default` by their framework.
        "import-x/no-default-export": "off",
      },
    },
  );

  // A block whose files would be empty (`scripts: []` and no `console`) is left out: ESLint refuses it.
  return config.filter((block) => !Array.isArray(block.files) || block.files.length > 0);
}

function list(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function trim(dir) {
  return dir.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * This file is also the nearest ESLint config to everything in the vendored copy, and
 * ESLint 10 loads the nearest config for each file it is given. The copy is generated,
 * so that config lints nothing.
 */
export default [{ name: "house-style/vendored-copy", ignores: ["**"] }];
