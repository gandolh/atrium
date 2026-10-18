# Task 87: Move the docs site from Starlight to Docusaurus

## Context

On 2026-10-18 the owner decided to move every project's docs site from Astro
Starlight to Docusaurus. `apps/docs` (`@ebook-reader/docs-site`, served at
`/atrium/docs/`) is one of them.

The recipe is written and verified. The `corpus-docs-site` skill
(personal-skills v0.31.0, source in
`~/projects/my-personal-skills/skills/corpus-docs-site/`) now scaffolds
Docusaurus 3.10, and `references/migrating-from-starlight.md` beside it holds
the file, config and content maps plus ten gotchas, each hit during a real
port. **Read that guide first.** The files this brief tells you to copy are in
the same folder. If the installed plugin is older than v0.31.0, read them from
the source path.

What the site has today (2026-10-18):
- base `/atrium/docs/` in `astro.config.mjs` (`DOCS_BASE ??`), 23 sidebar links;
- **both themes**: a designed light palette and a warm dark one in
  `src/styles/theme.css` (274 lines, 45 `--sl-*` tokens, Newsreader + Archivo
  via `@fontsource`), with Starlight's toggle left in;
- three authored pages, `index.mdx`, `api.mdx` and `data.mdx`, using
  `Diagram.astro` (two archify diagrams, sources in `diagrams/`), a raw
  `<dl>`, 20 `:::note` and one `:::danger`;
- `scripts/sync-corpus.mjs` with a hand-kept list of 19 pages (repo root three
  levels up), and `scripts/build-diagrams.mjs`;
- TypeDoc (`typedoc.json`, entry under `packages/shared`, out
  `public/reference`).

**Built through Docusaurus on 2026-10-18.** All 23 corpus pages (wiki + status +
log) built through the new sync in `markdown.format: 'detect'` mode, with no
broken links or anchors, once one cross-repo link was handled.
`corpus/wiki/decisions.md` (line 73) links `../../../wzd_auth/corpus/wiki/overview.md`.
Docusaurus fails the build on that link. Starlight's sync had turned it into
a GitHub URL under this repo's `corpus/`, which 404s. In MDX mode the corpus does
not compile at all; that is why the guide insists on `detect`.

## Scope

The docs site only: its package, its build wiring, and the places that say
which framework builds it. Same URLs, same `dist/`, same base, same two themes.
No new pages, no content rewrite.

## Files you OWN

- `apps/docs/` (all of it, including its `.gitignore` and the committed
  `public/diagrams/` artifacts, which move to `static/diagrams/`)
- `package-lock.json`
- `README.md` (line 60, "The Starlight docs site") and `docs/getting-started.md`
  (line 103, "(Starlight)")

## Files you must NOT touch

- `corpus/wiki/*.md` link text. Fix the renderer, not the source.
- `apps/web`, `apps/api`, `packages/*`. TypeDoc reads `packages/shared`; it
  does not change it.
- vps-deploy. Its brief 11 switches the `atrium` docs stack's check from
  `_astro/` to `assets/`.

## What to do

1. **Baseline.** `npm run docs -w @ebook-reader/docs-site`, then save the route
   list: `(cd apps/docs/dist && find . -name index.html | sort) > /tmp/atrium-routes-before.txt`.
2. **Config.** Write `docusaurus.config.ts` from the skill's reference. Set
   baseUrl `process.env.DOCS_BASE ?? '/atrium/docs/'`, `trailingSlash: true`,
   `routeBasePath: '/'` and `markdown.format: 'detect'`, plus local search and
   the GitHub navbar item. **colorMode = both**: `{ defaultMode: 'light',
   disableSwitch: false, respectPrefersColorScheme: true }`. Port the 23-link
   sidebar to `sidebars.ts` group by group, with `doc` ids for synced and
   authored pages. A link to the TypeDoc output becomes
   `{ type: 'link', href: 'pathname:///reference/' }`.
3. **package.json** per the guide: no `"type": "module"`, keep the
   `browserslist`, and add `start`/`docs` (`… && docusaurus build --out-dir dist`)
   and `typecheck`. Keep `typedoc` and the two `@fontsource` deps at their
   exact versions. Drop `astro`, `@astrojs/starlight` and `sharp`.
   `apps/api` imports `sharp` and declares it itself, so check that with a grep
   and leave it alone.
4. **Content.** Move the three `.mdx` pages to `docs/`. `index.mdx` keeps the
   sidebar, so give it `slug: /`. Replace `tableOfContents` keys with
   `hide_table_of_contents` / `toc_max_heading_level`. Port `Diagram.astro`
   to the skill's `Diagram.tsx` and import it as `@site/src/components/Diagram`.
   `git mv public/diagrams static/diagrams` and point `build-diagrams.mjs` at
   `static/diagrams/`.
5. **Sync.** Use the skill's `sync-corpus.mjs` with `GITHUB_REPO` set to this
   repo's GitHub URL and
   `OTHER_REPOS = { wzd_auth: 'https://github.com/gandolh/ward-auth' }`.
   Discovery publishes four pages that the old 19-page list left out:
   `glossary-jukebox`, `jellyfin-comparison`, `jukebox` and
   `status-history-v2`. Ask the owner which were kept back on purpose and put
   those slugs in the script's `DENY` set. Publish the rest, and add them to
   the sidebar where they belong.
6. **TypeDoc.** `"out": "static/reference"`. Links to it use `pathname://`.
7. **Theme.** Port `theme.css` to `src/css/custom.css`. Use one block for
   light, `:root, :root[data-theme='light']`, and one for
   `:root[data-theme='dark']`, each setting `--ifm-*` from the existing design
   tokens. Use the selector map in the skill's `references/custom.css` header.
   Keep the `@fontsource` imports at the top.
8. **Wiring.** In `apps/docs/.gitignore`, `.astro/` becomes `.docusaurus/`,
   `src/content/docs/wiki/` becomes `docs/wiki/`, and `public/reference/`
   becomes `static/reference/`. The archify note moves to `static/diagrams/`.
   Then fix the two README/getting-started mentions.

## Acceptance

- `npm run docs -w @ebook-reader/docs-site` exits 0 with
  `onBrokenLinks: 'throw'`.
- Route parity: the new route list equals `/tmp/atrium-routes-before.txt` plus
  `./search/index.html` and a `./wiki/<slug>/` route for each of the four pages
  above that is not in `DENY`. Nothing is missing.
- `grep -c '/atrium/docs/assets/' apps/docs/dist/index.html` is non-zero, and
  `grep -rl '_astro' apps/docs/dist` finds nothing.
- The decisions page links Ward's overview at `github.com/gandolh/ward-auth`.
- `npm run typecheck -w @ebook-reader/docs-site` passes.
- Browser check, with `dist/` served at `/atrium/docs/` by a plain static
  server (not `docusaurus serve`):
  - the landing page, `/data/`, one synced wiki page and the TypeDoc reference
    load;
  - both diagrams render;
  - the toggle switches light and dark, and both palettes match the old site;
  - Newsreader and Archivo load with no 404s;
  - search returns results.
  Screenshot light and dark.
- `bash corpus/lint.sh` passes.

## Out of scope

Deploying. The owner deploys after vps-deploy brief 11 flips the `atrium` docs
stack.
