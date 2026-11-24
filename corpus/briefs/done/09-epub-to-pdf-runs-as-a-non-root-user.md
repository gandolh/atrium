# Brief 09: EPUB to PDF works: the API runs as a non-root user

**Depends on:** brief 07 (the scoped install). Runs before or after brief 08; if 08 lands
first, test against its Calibre.

## Context

Found on 2026-11-24 by brief 07's walk, on both the old and the new image: EPUB→PDF fails.
Calibre's `ebook-convert` writes PDF through Qt WebEngine, and WebEngine refuses to start as
root: "Running as root without --no-sandbox is not supported". PDF→EPUB works, because it
doesn't use WebEngine. The `atrium-api` image has no `USER` line, so the API and every
`ebook-convert` child run as root. The live box runs the same image, so the button very
likely fails there too.

## Decisions

- **The API runs as the image's unprivileged `node` user (uid 1000), not root.** Calibre's
  WebEngine then keeps its sandbox. This is also the convention for app containers.
- **Rejected: `QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox`** (or `QTWEBENGINE_DISABLE_SANDBOX`).
  It would make EPUB→PDF work with a one-line change, but it renders user-uploaded books in
  Chromium as root with the sandbox off. Use it only if the non-root user can't work, as a
  recorded deviation that says why.

## Files you OWN

- `infrastructure/Dockerfile`
- The wiki pages that describe the image and the conversion (`wiki/overview.md` "Runs",
  `wiki/conversion.md`)

## Files you must NOT touch

- `apps/api/src` (unless a path the API writes turns out to be outside the five storage roots;
  then stop and report), `apps/web`, `apps/docs`, any `package.json` or lockfile, the
  `calibre` apt line (brief 08).

## What to do

1. Reproduce on today's image: build it, run it with scratch folders at the five storage roots
   (`data`, `library`, `images`, `latex`, `versions` under `/app/apps/api`), upload a sample
   EPUB and convert it to PDF. Save the failing job's error. Brief 07's walk scripts are a
   starting point: `convert-walk.sh` polls the right field.
2. In the `prod` stage, make the app files readable and the five storage roots writable by
   `node`, and switch to `USER node` before the `CMD`. Check what else the API writes at run
   time (a temp dir, Calibre's config under `$HOME`) and give `node` a writable `HOME` if
   Calibre needs one.
3. Build again and rerun brief 07's whole walk plus EPUB→PDF: health, sign-in, uploads, the
   PDF cover and thumbnail, both conversions, a LaTeX publish. Compare with step 1.
4. Bind mounts: on the box the five roots are host folders that root created. Read
   vps-deploy's atrium stack (read only) and write the exact owner step: the folders, and the
   `chown -R 1000:1000` to run before the deploy. If the stack itself should set ownership,
   name the vps-deploy change as a follow-up; don't edit vps-deploy.
5. Remove your containers and test images when done.

## Acceptance

- [ ] On the new image, EPUB→PDF finishes and the PDF downloads, and the API process runs as
      uid 1000 (`docker exec … id`).
- [ ] The rest of brief 07's walk gives the same results as on today's image.
- [ ] `npm run check` passes.
- [ ] The outcome names the owner's `chown` step and the deploy, `node cli.ts atrium server`
      from vps-deploy, in that order.

## Owner steps

1. Before the deploy, on the live site, try one EPUB→PDF conversion and note whether it fails.
   That tells whether the live box has the bug.
2. The `chown` from step 4, then `node cli.ts atrium server`.
3. Try EPUB→PDF again on the live site.

## Outcome (2026-11-24)

The image ends in `USER node` (uid 1000); the five storage roots are created owned by `node` before `VOLUME`. EPUB to PDF now works in a local container: the job finishes and the PDF downloads (28686 bytes, `%PDF-`), `docker exec ... id` gives uid 1000, and no flag or capability was needed, so the sandbox stays on. The same image built from the unchanged Dockerfile reproduced the bug first (uid 0, "Running as root without --no-sandbox is not supported").

The rest of brief 07's walk gives the same results: health, sign-in, uploads, PDF cover and thumbnail, PDF to EPUB (graded poor as before), LaTeX publish and PDF (14590 bytes), the library list. Beyond the storage roots the API writes `/tmp` and Calibre's config under `/home/node`; both are writable for node, so no `apps/api/src` change was needed. Test images removed.

Owner steps, in order: (1) try one EPUB to PDF on the live site and note whether it fails; (2) hand the five folders to uid 1000 from inside a container on the box's rootless daemon (the command is in [conversion.md](../../wiki/conversion.md); a host `chown` would not map correctly under rootless Docker), with `/srv/atrium-api/apps/api` as the base the stack uses; (3) `node cli.ts atrium server` from vps-deploy; (4) try EPUB to PDF again. Follow-up: vps-deploy's atrium stack could apply that ownership itself.
