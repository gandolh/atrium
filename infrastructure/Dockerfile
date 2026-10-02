# syntax=docker/dockerfile:1-labs
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
# Runs as root, which under the VPS's ROOTLESS daemon is the unprivileged
# account owning it — required because the library is bind-mounted.

FROM node:24-bookworm-slim AS deps
# better-sqlite3 and sharp are native. Both ship prebuilds for linux-x64, so
# this is the fallback path rather than the normal one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# Every workspace manifest: npm ci validates the lockfile against all of them.
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
RUN npm ci

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

FROM node:24-bookworm-slim AS proddeps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
RUN npm ci --omit=dev
# Keep every linux prebuild; delete only what this image can never be. (A
# whitelist here deletes everything — see Ward's Dockerfile for the incident.)
RUN cd node_modules \
 && find . -name '*.o' -delete \
 && find . -type d -name obj.target -prune -exec rm -rf {} + \
 && rm -rf better-sqlite3/deps better-sqlite3/src \
 && find . -type d -name prebuilds -exec sh -c \
      'rm -f "$1"/darwin-*.node "$1"/win32-*.node "$1"/android-*.node' _ {} \;

FROM node:24-bookworm-slim AS prod
LABEL org.opencontainers.image.title="Atrium API"
# `ebook-convert`, the whole reason this image is Debian. --no-install-recommends
# keeps out the desktop pieces Calibre suggests but the CLI never uses.
RUN apt-get update && apt-get install -y --no-install-recommends \
      calibre wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/typeset/dist ./packages/typeset/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY package.json ./
COPY --parents apps/*/package.json ./
COPY --parents packages/*/package.json ./
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788
# All five storage roots (D39), named here rather than inherited from where
# config.ts happens to sit in the source tree: a file move once re-pointed every
# default root (brief 53). The paths are the ones the first three mounts already
# used, so no book moved.
ENV LIBRARY_DATA_DIR=/app/apps/api/data \
    LIBRARY_FILES_DIR=/app/apps/api/library \
    THUMBNAILS_DIR=/app/apps/api/images/thumbnails \
    LATEX_PROJECTS_DIR=/app/apps/api/latex \
    DOCUMENT_VERSIONS_DIR=/app/apps/api/versions
# The library (database, originals, covers) and the LaTeX side (drafts and
# every published version). All five are bind mounts on the VPS. The last two
# used to live in the writable layer, so every recreate lost the drafts and
# versions the bind-mounted database still pointed at (brief 55).
VOLUME /app/apps/api/data /app/apps/api/library /app/apps/api/images /app/apps/api/latex /app/apps/api/versions
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "apps/api/dist/index.js"]
