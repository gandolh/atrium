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
- The deploy is the owner's step: `node cli.ts atrium server` from vps-deploy (corrected from `deploy`, see the outcome).

## Outcome (2026-11-24)

Built. `proddeps` runs `npm ci --omit=dev --workspace @ebook-reader/api --workspace @ebook-reader/shared --workspace @ebook-reader/typeset` (the image's npm 11.19.1 honours `--workspace` on `ci`; the prebuild trimming stays). The scoped install leaves one extra folder outside the root tree, `apps/api/node_modules` (a second `fastify-plugin`), and `prod` now copies it. Both images were built and measured on one machine on one day (the `before` image from the tree one commit earlier).

**Sizes, before to after**

| | before | after |
|---|---|---|
| image | 1.69 GB | 1.25 GB |
| `COPY /app/node_modules` layer | 690 MB | 252 MB |
| `du -sm /app/node_modules` | 834 MB | 275 MB |
| `@docusaurus`, `webpack`, `@rspack`, `react-dom`, `@codemirror` | present | none |

Largest folders after: `pdf-to-img` 71, `@mathjax` 50, `typescript` 24, `pdf-lib` 24, `mathjax` 20, `@img` 19, `zod` 9, `fontkit` 6, `fastify` 6. Before, the top of the list was `pdf-to-img` 71, `@napi-rs` 61, `@rspack` 52, `@mathjax` 50, `pdfjs-dist` 37, `typescript` 24, `@docusaurus` 23, `@base-ui` 23.

**`docker history`, layers that matter (same machine)**

| Layer | before | after |
|---|---|---|
| `COPY /app/apps/api/node_modules` | none | 47 kB |
| `COPY /app/node_modules` | 690 MB | 252 MB |
| `apt-get install calibre wget ca-certificates` | 767 MB | 767 MB |
| our files (dist, assets, vendor, manifests) | about 5 MB | about 5 MB |
| node:24-bookworm-slim base | unchanged | unchanged |

Full readings: both `docker history` outputs were saved from the builds; the table lists every layer over 1 MB.

**Walk (both images, same fixtures, scratch folders at the five storage roots)**

Identical on both: `/health` 200; login 200; EPUB, PDF and MP3 uploads; PDF cover 200 `image/jpeg` (rendered through pdf-to-img and its canvas); EPUB and MP3 covers 404 on both because the samples carry no cover art (`hasCover:false`, expected); one PDF thumbnail on disk; pdf to epub converts (status `poor`, same file layout, text files byte-sized the same); LaTeX create, save, publish and PDF download (typeset, fontkit, mathjax) 200 with a 14590-byte PDF on both; no error lines in the logs.

- `@napi-rs`: the root copy (61 MB) was the web app's, not the API's. `pdf-to-img` keeps its own nested `@napi-rs` (36 MB) and `pdfjs-dist` (35 MB), which is why they are not in the root top 15 now. The PDF cover, thumbnail and pdf to epub paths work on the new image, so no native module the API loads was dropped.
- `typescript` (24 MB) stays in the tree, but it is not a runtime dependency: in all three workspaces it is a `devDependency`, and no installed package requires it. The lockfile marks the root copy as non-dev because `apps/docs` reaches it (`cosmiconfig`, an optional peer of `@docusaurus`), and the scoped `npm ci` keeps nodes the lockfile does not flag as dev. Removing it needs a `package.json` or lockfile change, out of scope here.
- Converted-EPUB sizes differ from run to run on both images (46 to 174 kB): only `cover_image.jpg` changes, the rest of the file is the same. A size is no basis for comparing the images.

**Found, not caused by this brief (same on both images):** EPUB to PDF fails in Calibre with `Running as root without --no-sandbox is not supported` (Qt WebEngine as root in the container). The old image fails the same way, so the walk matches, but the convert button for EPUB to PDF does not work from this image as built here. Worth a follow-up (brief 08's Calibre question is the natural home); not checked on the box.

**Deploy phase corrected:** the brief's last Acceptance line said `node cli.ts atrium deploy`. That ships only the static web client; a Dockerfile change needs the container rebuilt, so the owner step is `node cli.ts atrium server` from vps-deploy.

**Checks:** `npm run check` exit 0 (typecheck, lint, format:check, check:conventions, test).
