# Brief 12: The web build prints no warnings

**Depends on:** nothing.
**Builder:** Sonnet.
**Before you start:** run `brief-board guide` (the repo's `CLAUDE.md` says so).

Filed 2026-11-25. The owner asked for the build warnings to be fixed in the most active repos (Atrium had 16 commits
outside the corpus in the two days before). `npm run build` exits 0, but the web app's Vite 6.4.5 build prints three
warnings.

## Context

From `npm run build` on 2026-11-25:

1. **Two Rollup `INVALID_ANNOTATION` warnings from zod 4.6.7**, at `zod/v4/core/util.js:400` and
   `zod/v4/core/regexes.js:74`. Zod's own comments sit where Rollup can't read a `@__PURE__` annotation, so Rollup
   drops the comment. 4.6.7 is the newest zod (checked 2026-11-25). The estate's Vite 8 apps use zod 4 and build
   clean, because Vite 8's bundler doesn't report it.
2. **"Some chunks are larger than 500 kB"**: the entry chunk `index-*.js` is 1,080 kB (338 kB gzip). The next two
   are 476 kB and 414 kB. `pdf.worker.min-*.mjs` (1,046 kB) is a copied asset, not a chunk, and doesn't warn.

## Decisions

All settled. None of them is open.

- **The entry chunk gets split, not hidden.** Load routes and heavy features (the reader's typesetting, the source
  editor, PDF handling, whatever the bundle shows is big and not on the first screen) with dynamic `import()` until
  no chunk of Atrium's own is over 500 kB. `chunkSizeWarningLimit` stays at its default.
- **The zod warning is filtered at its source only:** an `onwarn` handler in `apps/web/vite.config.ts` that drops
  code `INVALID_ANNOTATION` when the id is under `node_modules/zod/`, with a comment saying why. Every other warning
  passes through.
- Moving Atrium to Vite 8, which would also clear the zod warning, is out of scope: a major upgrade is its own brief.

## Files you OWN

- `apps/web/vite.config.ts`, `apps/web/src/` where an import becomes lazy (route and feature entry points only)
- `corpus/wiki/status.md`, `corpus/log.md`, and the wiki page on the web app's build if one exists

## Files you must NOT touch

- `apps/api/`, `packages/`, the docs site, other repos.

## Steps

1. Run `npx vite-bundle-visualizer` in `apps/web` (nothing added to the repo) to see what fills the entry chunk; note
   the top contributors in the outcome.
2. Make the big, not-first-screen parts lazy, each behind the loading state the app already uses.
3. Add the zod filter.
4. Rebuild until `npm run build` prints no warning.

## Acceptance

- [ ] `npm run build` exits 0 and prints no warning; the outcome lists the entry chunk's size before and after.
- [ ] `npm run check` exits 0.
- [ ] On the preview build, each route that now loads lazily opens with no failed chunk request and no console error.
- [ ] `bash corpus/lint.sh` passes.

## Owner steps

- `node cli.ts atrium deploy` from vps-deploy (the web build only; the API doesn't change).

## Owner decisions

- Settled 2026-11-25 (owner): "run build and fix all the warnings for the most active projects". Which repos count
  (more than 10 commits outside the corpus in two days) and how each warning is fixed are the controller's calls.

## Outcome

Done 2026-11-26. `npm run build` prints no warning. The entry chunk went from 1,080 kB (338 kB gzip) to 291 kB (90 kB
gzip); the largest chunk of Atrium's own is now the PDF reader's at 476 kB. `chunkSizeWarningLimit` is untouched.

- **What filled the entry chunk** (source sizes from a sourcemap pass; `vite-bundle-visualizer` could not be run in the
  build container, so the sourcemaps stood in): `@base-ui/react` 639k, `react-dom` 545k, `zod` 370k, `motion-dom` 345k,
  Atrium's `lib` 206k, `@tanstack/router-core` 144k, the LaTeX screens 125k, `framer-motion` 122k, `tailwind-merge`
  106k, the notes screens 105k, the library screens 103k. The readers, PDF, epub.js and CodeMirror were already lazy.
- **Routes are lazy.** `apps/web/src/router.tsx` loads `/notes`, `/latex`, `/jukebox`, `/read`, `/discover`,
  `/profiles` and `/settings` through TanStack's `lazyRouteComponent`, which also preloads on link intent. The library
  home stays in the entry. That alone left the entry at 908 kB, because the rest was libraries.
- **Four libraries get their own chunks** through `manualChunks` in `vite.config.ts`: `react` (194 kB), `base-ui`
  (242 kB), `motion` (129 kB), `zod` (95 kB). Whole packages only. The first screen still loads all of them, so its
  total is about the same; what changed is that no file is over the limit and a deploy that only touches app code
  leaves four chunks cached.
- **The zod warning** is dropped by an `onwarn` handler for `INVALID_ANNOTATION` under `node_modules/zod/`; any
  other warning prints.
- **Runtime check** on `vite preview` with the real API (throwaway data directory and account): every lazy route
  opened, a PDF and an epub rendered in their readers, a new LaTeX project opened in the CodeMirror editor. No chunk
  request failed or returned an error status. The console showed only the 401 before sign-in, 502s from the Jukebox
  and Discover pages (no Discord bot or Gutenberg reachable in the container), cover 404s and epub.js's `unload`
  permissions-policy notice.
- **Gate:** typecheck, lint, format and conventions pass. `npm run test` fails in the API's LaTeX publish and cover
  tests ("typesetting worker crashed: Cannot find module apps/api/src/config.js"), a worker path problem in this
  container that has nothing to do with the web app.
- Board not updated: brief-board was not available in this session.

