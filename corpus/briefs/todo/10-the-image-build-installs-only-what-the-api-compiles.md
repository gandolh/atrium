# Brief 10: The image's build stage installs only what the API compiles, on a pinned base

**Depends on:** briefs 07 and 09, both on main (same Dockerfile). **Runs after:** 09.
**Builder:** Sonnet.
**Before you start:** run `brief-board guide` (the repo's `CLAUDE.md` says so).

Filed 2026-11-24 from the estate's infra review. Every app image is built on the box by vps-deploy's `server`
phase, and on 2026-11-23 the box's build cache (9.3 GB) took its disk to 90%. The cache was pruned to zero on
2026-11-24, so the next rollout builds every image cold. The same tidy is filed in ten repos; sports-app's
Dockerfile already scopes its build install.

## Context

Five things in `infrastructure/Dockerfile`, all build-side or base-side:

- **The `deps` stage installs every workspace** (`RUN npm ci`, line 35) to build three: `builder` runs
  `npm run build` for `@ebook-reader/shared`, `@ebook-reader/typeset` and `@ebook-reader/api` (lines 47-49).
  The docs site and the web app's trees (Docusaurus, Vite, React, CodeMirror) are installed and never used.
  Measured on the laptop on 2026-11-24: the full install is 1044 MB of `node_modules`; the closure of the three
  workspaces plus the root's dev dependencies is about 435 MB, so about 609 MB less per cold build, the largest
  saving of the eleven repos. The final image doesn't change.
- **The base floats.** All three `FROM node:24-bookworm-slim` lines (24, 51, 74) follow whatever the tag is on
  the day of the build. imbatranimOS pins `node:24.22.1-alpine` and this repo's `.nvmrc` says `24.22.1`.
  vps-deploy's weekly housekeeping removes a base tag no image uses after two weeks; the next deploy pulls the
  tag's current image, every cache entry keyed on the old one is dead, and each app lands on a different Node
  patch depending on when it was last built.
- **The first line is `# syntax=docker/dockerfile:1-labs`**, a frontend image resolved from Docker Hub on every
  build. It is there only for `COPY --parents` (lines 33-34, 57-58, 97-98). A floating tag can change under a
  build or fail it when Hub is unreachable.
- **The toolchain line is spelled differently from the other Debian images.** `deps` and `proddeps` (lines
  27-29, 52-54) install the same packages as gazette, newspapper and ro-housing, but BuildKit keys a cache layer
  on the exact command text, so the box keeps two copies of an (estimated) 200 MB layer. The others write:

  ```dockerfile
  RUN apt-get update \
   && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
   && rm -rf /var/lib/apt/lists/*
  ```

- **No `MALLOC_ARENA_MAX`.** glibc gives each allocating thread its own arena and keeps it, so a Node process on
  Debian grows with bursts of thread work (sharp, better-sqlite3, libuv). Shelfmark set `MALLOC_ARENA_MAX=2` on
  2026-11-23 and measured it: 13 searches grew the process by 46 MB with the default, 31 MB with 2. `atrium-api`
  used 100 MiB on the box on 2026-11-24; the estimate for this setting is 10-25 MiB.

## Decisions

- `deps` runs `npm ci -w @ebook-reader/api -w @ebook-reader/shared -w @ebook-reader/typeset --include-workspace-root`.
  Every manifest is still copied: `npm ci` checks the lockfile against all of them.
- Every stage's base is `node:24.22.1-bookworm-slim`. The estate moves to a new patch in one sweep, not per repo.
- The syntax line is pinned to an exact frontend version, not dropped: dropping it makes the build depend on the
  box daemon's built-in frontend, whose version nobody here can read.
- Both toolchain lines take the other Debian images' text, character for character.
- `MALLOC_ARENA_MAX=2` joins the `prod` stage's first `ENV` block, with a comment giving the reason.

## Files you OWN

- `infrastructure/Dockerfile`
- `corpus/wiki/overview.md`'s image numbers, if they change
- The closeout: the outcome note, `corpus/log.md`, `corpus/wiki/status.md`

## Files you must NOT touch

- Any `package.json` or `package-lock.json`, `.nvmrc`.
- The Calibre line and the `USER node` setup (briefs 08 and 09 settled them).
- vps-deploy: read only.

## What to do

1. **Check the scoped install without Docker.** Export the tree to a scratch folder outside the repo
   (`git archive HEAD | tar -x -C <scratch>`). There, run the full `npm ci` and `du -sm node_modules`; delete
   `node_modules`, run the scoped command from Decisions, `du -sm` again, then the three builds in the order of
   lines 47-49. They must pass. If one fails on a missing package, find which workspace or root package brings it,
   add it to the command, and say so in the outcome.
2. **Find the syntax pin.** Read the Dockerfile frontend's release notes for the first stable version that has
   `COPY --parents` without labs. Pin `# syntax=docker/dockerfile:<that exact version>`; if no stable version has
   it, pin the labs channel to an exact version (`1.<n>-labs`). Say which in the outcome.
3. Make the five edits. The `deps` comment says why the install is scoped.
4. On the laptop, build today's image and the new one (`docker compose -f infrastructure/docker-compose.yml build
   atrium-api`), and save `docker history` of each and the `deps` stage's size (`docker build --target deps`).
5. Run brief 07's walk on the new image with a scratch data folder: upload, cover, thumbnail, convert both ways,
   a LaTeX compile. Results must match today's image.

If your session can't build Docker images, do steps 1 to 3, run the checks, and hand back with steps 4 and 5 for
the controller.

## Acceptance

- [ ] Step 1's two `du` readings and the build result are in the outcome.
- [ ] The image builds on the laptop; `docker history` before and after, from one machine, in the outcome. The
      `deps` stage is smaller; the final image is within a few MB of today's.
- [ ] The walk in step 5 matches today's image; `/health` answers.
- [ ] `npm run check` exits 0; `bash corpus/lint.sh` passes.
- [ ] End move `ready_for_deploy`.

## Owner steps

- `node cli.ts atrium server` from vps-deploy. Brief 09's chown step comes first if it hasn't run yet
  ([conversion.md](../../wiki/conversion.md)).
