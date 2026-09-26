# Task 55 — The container persists all five storage roots, and names them itself

**Filed 2026-09-25** by the improvements sweep. Written LaTeX drafts and every
published version disappear on each container recreate.

## Context

D39 (extended by brief 38) gives the API **five** storage roots, and
[architecture.md](../../wiki/architecture.md) is emphatic that they move
together. The container persists three of them:

- [`Dockerfile:86`](../../../infrastructure/Dockerfile):
  `VOLUME /app/apps/api/data /app/apps/api/library /app/apps/api/images`
- [`docker-compose.yml:23-25`](../../../infrastructure/docker-compose.yml)
  bind-mounts the same three.

`LATEX_PROJECTS_DIR` (`apps/api/latex/`, the drafts) and `DOCUMENT_VERSIONS_DIR`
(`apps/api/versions/`, every published version's PDF and source zip) are neither
volumes nor mounts. They live in the container's writable layer. The rows that
point at them, `latex_projects` and `document_versions`, live in the
**bind-mounted** database. So every image rebuild or recreate (every deploy)
leaves the database describing drafts and versions whose bytes are gone:

- **Opening a draft:** an empty or missing tree.
- **Opening an older version:** `GET /library/:id/file?version=` finds no file.
- **Resuming from a version's zip:** nothing to resume.

Three smaller problems in the same files:

- [`.dockerignore`](../../../.dockerignore) excludes `apps/api/{data,library,images}`
  but **not** `apps/api/latex` or `apps/api/versions`. The builder stage's
  `COPY apps ./apps` (`Dockerfile:35`) therefore copies a developer's local LaTeX
  drafts and published PDFs into the build context and a builder layer. It also
  omits `testing_files/` (25 MB of personal test books that `.gitignore` already
  keeps out of the repo).
- `docker-compose.yml:3` says the `.env` "carries APP_PASSWORD, which gates every
  route". D53 deleted that mechanism.
- The image sets no storage-root env at all, so where it writes depends entirely
  on source-relative resolution in `config.ts`. That resolution is currently
  wrong ([brief 53](53-storage-roots-resolve-from-api-package.md)). A container
  should name its mount points explicitly rather than inherit them from the depth
  of a source file.

## Scope

**In:** the Dockerfile, the compose file and `.dockerignore`.

**Out:** `apps/api/**`, where brief 53 fixes resolution; the vps-deploy repo
(below).

## Files you OWN

- `infrastructure/Dockerfile`
- `infrastructure/docker-compose.yml`
- `.dockerignore`

## Files you must NOT touch

- `apps/api/**`, owned by brief 53.
- `../vps-deploy/**` is a **separate repository**. List the changes it needs in
  your outcome note and hand them to its owner; do not edit it from here.

## What to do

1. **Declare all five roots** as volumes, and set them explicitly in the image:

   ```
   ENV LIBRARY_DATA_DIR=/app/apps/api/data \
       LIBRARY_FILES_DIR=/app/apps/api/library \
       THUMBNAILS_DIR=/app/apps/api/images/thumbnails \
       LATEX_PROJECTS_DIR=/app/apps/api/latex \
       DOCUMENT_VERSIONS_DIR=/app/apps/api/versions
   ```

   Keep the existing in-container paths, so the three live mounts do not move.
2. **Bind-mount the two new roots in compose**, alongside the existing three, with
   the same `${ATRIUM_…_DIR:-../apps/api/…}` pattern (e.g. `ATRIUM_LATEX_DIR`,
   `ATRIUM_VERSIONS_DIR`).
3. **Add** `apps/api/latex`, `apps/api/versions` and `testing_files` to
   `.dockerignore`.
4. **Fix the compose header comment:** the `.env` carries Ward's three variables
   and the tuning knobs, not `APP_PASSWORD`.
5. **Write the vps-deploy follow-up into the outcome.** `stacks/atrium.ts` must:
   - pass the two new host dirs;
   - add `/apps/api/latex` and `/apps/api/versions` to `persistentState.excludes`,
     or its rsync `--delete` will wipe them;
   - drop the dead `APP_PASSWORD` secret and `CONVERT_TIMEOUT_MS`.

## Acceptance

- `docker build` from the repo root succeeds, and the build context no longer
  contains `apps/api/latex`, `apps/api/versions` or `testing_files`. Check with a
  `--progress=plain` build, or by listing the context.
- Inside the running container, the API's startup log (brief 53 adds the roots to
  it) shows all five roots under the mounted paths.
- The persistence survives a recreate, checked with **scratch** host directories
  for all five mounts:
  - create a LaTeX project and publish one version;
  - `docker compose up --force-recreate`;
  - the draft and the version's PDF are still served.
- No path under the real library is used for this check.
