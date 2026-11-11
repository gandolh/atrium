/**
 * The house dependency-cruiser preset: what knip and the compiler cannot see about
 * imports. A repo's own `.dependency-cruiser.cjs` extends it and names its tsconfig:
 *
 *   module.exports = {
 *     extends: "./vendor/house-style/.dependency-cruiser.cjs",
 *     options: { tsConfig: { fileName: "tsconfig.json" } },
 *   };
 *
 * Unused files and undeclared packages are knip's; this preset leaves them to it.
 */
/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "A cycle makes load order matter and leaves no layer that can be read on its own.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment:
        "An import that cannot be resolved is an edge every other rule here misses. A Vite virtual module (`virtual:` ids) is made by a plugin at build time, Astro's virtual modules (`astro:content`, `astro:assets`) by Astro, and React Router's route types (`./+types/<route>`) by its typegen, so all three are allowed.",
      from: {},
      to: { couldNotResolve: true, pathNot: ["^virtual:", "^astro:", "(^|/)\\+types/"] },
    },
    {
      name: "feature-through-index",
      severity: "error",
      comment: "Another feature is used through its index only, so its insides can change without breaking callers.",
      from: { path: "(^|/)features/([^/]+)/" },
      to: {
        path: "(^|/)features/[^/]+/",
        pathNot: ["(^|/)features/$2/", "(^|/)features/[^/]+/index\\.(ts|tsx|js|mjs)$"],
      },
    },
    {
      name: "lib-without-fastify",
      severity: "error",
      comment: "lib/ holds pure helpers, so it is tested and reused without a server.",
      from: { path: "(^|/)lib/" },
      to: { path: "(^|/)node_modules/(fastify|fastify-plugin|@fastify/[^/]+)/" },
    },
  ],
  options: {
    // Packages are leaves: their own imports are not the repo's structure.
    doNotFollow: { path: "(^|/)node_modules/" },
    // Generated and vendored code is not the repo's structure either.
    exclude: { path: "(^|/)(vendor|dist|coverage)/" },
    // A type-only import still couples two modules, so it counts.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
