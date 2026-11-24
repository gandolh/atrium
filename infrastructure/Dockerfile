# syntax=docker/dockerfile:1.20.0
# Atrium — the ebook reader's API.
#
# The one image in the estate on DEBIAN rather than Alpine, and the reason is
# Calibre: the API shells out to `ebook-convert` for EPUB→PDF, and Calibre is a
# large Python/Qt application that is far better behaved on glibc than on musl.
# The image is correspondingly heavy — that is the honest cost of a runtime
# dependency this app genuinely has.
#
# Containerizing moved that cost to where it belongs. Calibre used to be an apt
# package installed on the HOST by atrium's pre-deploy, which every other
# project on the box then had to live alongside; now it is a line here, in the
# repo that needs it.
#
# Build context is the REPO ROOT (workspaces "apps/*" and "packages/*").
#
# Runs as the image's unprivileged `node` user (uid 1000), not root. Calibre
# writes PDF through Qt WebEngine, and WebEngine refuses to start as root
# unless its sandbox is switched off; a non-root user keeps the sandbox on for
# books anyone uploaded. The five bind-mounted storage roots must therefore be
# writable by uid 1000: see the chown step in wiki/conversion.md (on the VPS's
# rootless daemon it is applied from inside a container).

FROM node:24.22.1-bookworm-slim AS deps
# better-sqlite3 and sharp are native. Both ship prebuilds for linux-x64, so
# this is the fallback path rather than the normal one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# Every workspace manifest: npm ci validates the lockfile against all of them.
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
# Scoped to the three workspaces the builder stage compiles. A bare `npm ci`
# also installs apps/web and apps/docs (Vite, React, Docusaurus), about 600 MB
# of build cache nothing here uses.
RUN npm ci -w @ebook-reader/api -w @ebook-reader/shared -w @ebook-reader/typeset --include-workspace-root

FROM deps AS builder
COPY packages ./packages
COPY apps ./apps
# Workspace packages BEFORE the app that imports them, and both of them: the
# API imports @ebook-reader/shared AND @ebook-reader/typeset, and tsc needs the
# emitted .d.ts of each. Building only `shared` fails with four errors that read
# like unrelated type problems ("'aborted' does not exist in type WorkerSignal")
# rather than "you forgot to build typeset", which is what makes this worth
# spelling out instead of leaning on `--workspaces`: that runs in declaration
# order, not dependency order.
RUN npm run build -w @ebook-reader/shared \
 && npm run build -w @ebook-reader/typeset \
 && npm run build -w @ebook-reader/api

FROM node:24.22.1-bookworm-slim AS proddeps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
# Only the three workspaces the API runs. A bare `npm ci --omit=dev` installs the
# production dependencies of every workspace, apps/docs and apps/web included.
RUN npm ci --omit=dev \
      --workspace @ebook-reader/api \
      --workspace @ebook-reader/shared \
      --workspace @ebook-reader/typeset
# Keep every linux prebuild; delete only what this image can never be. (A
# whitelist here deletes everything — see Ward's Dockerfile for the incident.)
RUN cd node_modules \
 && find . -name '*.o' -delete \
 && find . -type d -name obj.target -prune -exec rm -rf {} + \
 && rm -rf better-sqlite3/deps better-sqlite3/src \
 && find . -type d -name prebuilds -exec sh -c \
      'rm -f "$1"/darwin-*.node "$1"/win32-*.node "$1"/android-*.node' _ {} \;

FROM node:24.22.1-bookworm-slim AS prod
LABEL org.opencontainers.image.title="Atrium API"
# `ebook-convert`, the whole reason this image is Debian. --no-install-recommends
# keeps out the desktop pieces Calibre suggests but the CLI never uses.
RUN apt-get update && apt-get install -y --no-install-recommends \
      calibre wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=proddeps /app/node_modules ./node_modules
# The scoped install also leaves a node_modules inside the API workspace (a
# second fastify-plugin version); the root tree alone would build clean and
# fail at require time. Re-list this when `find /app -name node_modules -type d`
# in the proddeps stage shows another one.
COPY --from=proddeps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/typeset/dist ./packages/typeset/dist
# The typesetter loads its fonts from here at run time (the package ships
# `dist` AND `assets`). Without them every LaTeX compile, and so every
# publish, fails inside the container.
COPY packages/typeset/assets ./packages/typeset/assets
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY apps/api/vendor ./apps/api/vendor
COPY package.json ./
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
# MALLOC_ARENA_MAX: glibc gives each thread that allocates its own malloc arena
# and keeps it, so a Node process on Debian grows with bursts of thread work
# (sharp, better-sqlite3, libuv). Two arenas cost almost no speed here.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    MALLOC_ARENA_MAX=2
# The app files stay root-owned and world-readable; the API never writes to
# them. What it does write is the five storage roots below (thumbnails sit under
# images/), /tmp, and Calibre's config and cache under node's HOME. Creating the
# roots here, before VOLUME, gives a fresh volume or an unmounted run the right
# owner; a bind mount takes its owner from the host folder instead.
RUN mkdir -p /app/apps/api/data /app/apps/api/library /app/apps/api/images/thumbnails \
      /app/apps/api/latex /app/apps/api/versions \
 && chown -R node:node /app/apps/api/data /app/apps/api/library /app/apps/api/images \
      /app/apps/api/latex /app/apps/api/versions
# All five storage roots (D39), named here rather than inherited from where
# config.ts happens to sit in the source tree: a file move once re-pointed every
# default root. The paths are the ones the first three mounts already
# used, so no book moved.
ENV LIBRARY_DATA_DIR=/app/apps/api/data \
    LIBRARY_FILES_DIR=/app/apps/api/library \
    THUMBNAILS_DIR=/app/apps/api/images/thumbnails \
    LATEX_PROJECTS_DIR=/app/apps/api/latex \
    DOCUMENT_VERSIONS_DIR=/app/apps/api/versions
# The library (database, originals, covers) and the LaTeX side (drafts and
# every published version). All five are bind mounts on the VPS. The last two
# used to live in the writable layer, so every recreate lost the drafts and
# versions the bind-mounted database still pointed at.
VOLUME /app/apps/api/data /app/apps/api/library /app/apps/api/images /app/apps/api/latex /app/apps/api/versions
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
USER node
CMD ["node", "apps/api/dist/server.js"]
