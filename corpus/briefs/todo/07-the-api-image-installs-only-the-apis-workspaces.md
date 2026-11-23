# Brief 07: The API image installs only the API's workspaces

## Context

On 2026-11-24 the box's disk was 90% full after the 2026-11-23 rollout, and
Docker held 26 of its 38 GB. vps-deploy keeps each service's previous image for
a rollback, so every megabyte in an app image is paid about twice, and the box
gets no extra storage (vps-deploy's decisions, 2026-11-06).

`atrium-api:1.0` is the largest image on the box. Its layers, from
`docker history` on the box (2026-11-24):

| Layer | Size |
|---|---|
| `COPY /app/node_modules` from `proddeps` | 874 MB |
| `apt-get install calibre wget ca-certificates` | 804 MB |
| node:24-bookworm-slim | about 250 MB |
| our own files (dist, assets, vendor, manifests) | about 6 MB |

Most of that node_modules is never loaded. `proddeps` runs
`npm ci --omit=dev` at the repo root, and npm then installs the production
dependencies of every workspace, `apps/docs` and `apps/web` included. A
throwaway container of today's image (2026-11-24) holds `@docusaurus`,
`webpack`, `@rspack`, `@babel`, `@swc`, `@algolia`, `@base-ui` and
`typescript` next to what the API uses (`pdf-to-img`, `@napi-rs`, `@mathjax`,
`pdfjs-dist`, `pdf-lib`, `@img`). The API runs three workspaces:
`@ebook-reader/api`, `@ebook-reader/shared` and `@ebook-reader/typeset`.

Calibre is brief 08's question, not this one.

## Decisions

- The production install covers the three workspaces the API runs. The `deps`
  and `builder` stages stay as they are: the build needs the full install.
- Every `node_modules` folder the scoped install leaves is copied into `prod`,
  not only the root one. Newspapper hit this: `fflate` landed in
  `core/node_modules`, and an image that copied only the root tree built clean
  and failed at require time on one code path.

## Files you OWN

- `infrastructure/Dockerfile`
- `.dockerignore`, if the change needs it
- The wiki page that describes the image, for the new numbers

## Files you must NOT touch

- Any `package.json` or `package-lock.json`: no dependency changes here.
- `apps/web`, `apps/docs`, `apps/api/src`, `packages/*/src`.
- The `calibre` line in the `prod` stage (brief 08).

## What to do

1. Record today's numbers on one machine: build the image, save
   `docker history`, and list the 15 largest folders of its `/app/node_modules`
   (`du -sm * @*/* | sort -n | tail -15`).
2. In `proddeps`, install only the API's workspaces:
   `npm ci --omit=dev --workspace @ebook-reader/api --workspace @ebook-reader/shared --workspace @ebook-reader/typeset`.
   Check that the image's npm honours `--workspace` on `ci`. If it doesn't,
   find the equivalent and say which in the outcome. Keep the prebuild
   trimming that follows.
3. List the `node_modules` folders the scoped install leaves outside the root
   tree (`find /app -name node_modules -type d -not -path '/app/node_modules/*'`)
   and copy each one into `prod`.
4. Build again on the same machine and take the same numbers. Confirm the image
   has no `@docusaurus`, `webpack`, `@rspack`, `react-dom` or `@codemirror`
   folder. Keep `pdfjs-dist` if `pdf-to-img` pulls it in.
5. Run the new image with scratch folders bound at the five storage roots and
   walk the paths that load native or heavy modules: `/health`; upload an EPUB
   and a PDF (covers and thumbnails go through sharp, PDF pages through
   pdf-to-img); one conversion each way; one LaTeX project published
   (typeset, fontkit, mathjax); one audio file, if the library takes audio
   (music-metadata). Use sample files, never the owner's books.

If your session can't build Docker images, make the Dockerfile change, run the
repo's checks, and hand back with steps 1, 4 and 5 for the controller.

## Acceptance

- The image's node_modules holds only what the three workspaces pull in: none
  of the folders named in step 4.
- The walk in step 5 gives the same results on the new image as on today's.
- `npm run check` passes.
- The outcome note has both `docker history` readings, taken on one machine,
  and the node_modules size before and after.
- The deploy is the owner's step: `node cli.ts atrium deploy` from vps-deploy.
