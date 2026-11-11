// The house dependency-cruiser preset, from the vendored house-style copy: no cycles, no unresolvable
// imports, a feature used through its index only, no Fastify in lib/.
module.exports = {
  extends: "./vendor/house-style/.dependency-cruiser.cjs",
  forbidden: [
    // A warning for now (2026-11-11): 26 import cycles, 22 in packages/typeset/src (compile.ts, doc/, font/,
    // layout/ and macro/budget.ts import each other) and 4 among the LaTeX editor's web components. When those
    // cycles are broken, this entry goes and the rule is an error again.
    { name: "no-circular", severity: "warn" },
  ],
};
