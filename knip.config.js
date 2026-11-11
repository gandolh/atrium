import preset from "./vendor/house-style/knip.json" with { type: "json" };

// knip has no `extends`, so this spreads the house preset. The docs site is a Docusaurus workspace with its own
// build and checks, so it stays out.
export default {
  ...preset,
  ignore: [...preset.ignore, "apps/docs/**"],
  // pdftotext is a system tool that one typeset test shells out to. @playwright/test serves the owner's local
  // test hub (the playwright/ folder is not committed), so nothing in the repo imports it.
  ignoreBinaries: ["pdftotext"],
  workspaces: {
    ".": { entry: ["scripts/*.mjs"] },
    "apps/web": { ignoreDependencies: ["@playwright/test"] },
  },
};
