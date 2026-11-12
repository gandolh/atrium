// The house dependency-cruiser preset, from the vendored house-style copy: no cycles, no unresolvable
// imports, a feature used through its index only, no Fastify in lib/.
module.exports = {
  extends: "./vendor/house-style/.dependency-cruiser.cjs",
  forbidden: [
    // An error everywhere but the two places that still have cycles: the API, the shared package and the rest of
    // the web app have none.
    {
      name: "no-circular",
      severity: "error",
      comment: "A cycle makes load order matter and leaves no layer that can be read on its own.",
      from: { pathNot: ["^packages/typeset/src/", "^apps/web/src/latex/"] },
      to: { circular: true },
    },
    // A warning for now (2026-11-12): 26 import cycles, 22 in packages/typeset/src (compile.ts, doc/, font/,
    // layout/ and macro/budget.ts import each other) and 4 among the LaTeX editor's web components. When those
    // cycles are broken, this entry goes and the rule above covers them.
    {
      name: "no-circular-typeset-and-latex-editor",
      severity: "warn",
      comment: "The cycles that predate the rule, until they are broken.",
      from: { path: ["^packages/typeset/src/", "^apps/web/src/latex/"] },
      to: { circular: true },
    },
  ],
};
