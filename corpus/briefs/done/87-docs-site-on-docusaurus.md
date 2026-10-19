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

## Outcome (2026-10-19)

**Done.** `apps/docs` builds with Docusaurus 3.10.2 (exact pins, D21; React
19.2.7 and TypeScript 5.9.3 to match the other workspaces). Same base
(`DOCS_BASE ?? '/atrium/docs/'`), same `dist/`, both themes with the toggle.
Not deployed: vps-deploy brief 11 has to switch the `atrium` docs stack's
check to `assets/` first.

**Step 5, the owner's answer (2026-10-19):** publish all four pages, so
`DENY` is empty. Placed in the sidebar:
- `jukebox` ("The Jukebox") and `glossary-jukebox` ("Jukebox vocabulary") in
  *The product*, after the PWA layer: the Jukebox is a product surface, and its
  vocabulary sits with it the way "Authoring vocabulary" sits with LaTeX;
- `jellyfin-comparison` ("Jellyfin compared") in *Decisions and state*, after
  Open questions, which it feeds;
- `status-history-v2` in *Status*, between "Archive — through brief 44" and
  "Archive — v1", where its dates (2026-08-26 to 08-27) put it.

**What changed on the way:**
- `index.mdx` got `slug: /` and `hide_table_of_contents`; its one Markdown
  link to TypeDoc became `pathname:///reference/`. The other page links were
  already routes.
- The corpus banner's title is plain text now (`Rendered from
  corpus/wiki/x.md · updated …`). In CommonMark mode Docusaurus drops an
  admonition title that holds inline code into the body and prints "NOTE"
  (checked on a test page; a plain title works, and MDX pages are unaffected).
  The skill's guide says inline code in titles carries over; that holds for
  `.mdx` only, and the imbatranimOS site shows "NOTE" for the same reason.
- `url` is `https://example.org`, as in imbatranimOS, rather than the
  production origin the Astro config carried: it feeds only the sitemap and og
  tags, and the host is the deploy's business.
- `sharp` left the docs package; `apps/api` declares it (0.35.4) and still
  loads it. `npm install` reports 62 known vulnerabilities across the
  workspace; not looked into.

**Acceptance:**
- `npm run docs -w @ebook-reader/docs-site` exits 0 with
  `onBrokenLinks: 'throw'`; the sync printed no warnings. The 12 TypeDoc
  warnings are the same set the Starlight build printed.
- Route parity: the new list is `/tmp/atrium-routes-before.txt` (23 routes)
  plus `./search/index.html` and `./wiki/glossary-jukebox/`,
  `./wiki/jellyfin-comparison/`, `./wiki/jukebox/` and
  `./wiki/status-history-v2/`. Nothing missing.
- `grep -c '/atrium/docs/assets/' dist/index.html` is 1, and
  `grep -rl '_astro' dist` finds nothing.
- The decisions page links Ward's overview at
  `github.com/gandolh/ward-auth/blob/main/corpus/wiki/overview.md`.
- `npm run typecheck` passes, for the docs package and the whole workspace.
- Browser, with `dist/` and the saved Starlight `dist/` each served at
  `/atrium/docs/` by `python3 -m http.server`:
  - the landing page, `/data/`, `/wiki/overview/` and `/reference/` (TypeDoc,
    476 links) load;
  - both archify diagrams render in their frames;
  - the toggle switches light and dark. Page background, text, link and navbar
    colours are identical to the Starlight site in both modes (light `#f7f5f2`
    / `#1a1917` / `#2f5486` / `#fffefd`, dark `#141310` / `#ece7de` /
    `#8fb3dd` / `#1c1a17`), and prose and headings are in Newsreader;
  - two deliberate differences: notes use the accent's low tint where
    Starlight used its own default blue, and the current sidebar page is
    accent text on paper rather than a filled accent bar (design.md: accent
    never fills);
  - Newsreader and Archivo load (`document.fonts.check` true for both, all ten
    `woff2` URLs answer 200); the only 404 is `/favicon.ico` at the server
    root, which the Starlight site also lacked (it pointed at a
    `favicon.svg` that was never built);
  - search for "jukebox" returns the Jukebox pages and log entries;
  - no horizontal scroll at 390 px.
- `bash corpus/lint.sh` passes.
