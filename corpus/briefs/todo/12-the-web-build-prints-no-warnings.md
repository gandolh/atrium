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
