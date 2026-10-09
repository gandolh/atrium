# Getting started

Everything needed to run Atrium on your own machine, with your own library or a throwaway one.

## Prerequisites

- Node 24 or later (`.nvmrc` pins 24.14.1) and npm.
- A local Ward, the estate's sign-in service. Atrium has no accounts, passwords or login page of its own, and the API refuses to start without Ward's three settings. Ward runs in Docker from the sibling repo, `wzd_auth/infrastructure/local`, and answers on http://localhost:8792.
- Calibre, optional. Convert shells out to its `ebook-convert`. Without it the API logs a warning at startup and each conversion fails with that reason; everything else works.

## 1. Install

```bash
npm install
```

The workspaces are `packages/shared`, `packages/typeset` and `apps/*`. Their npm names keep the old scope, `@ebook-reader/*`.

## 2. Start Ward and seed it

Follow the README in `wzd_auth/infrastructure/local`. In short, from that folder:

```bash
docker compose up -d --build
node seed.mjs
```

`seed.mjs` registers atrium, gives your Ward account access to it, and writes `WARD_PUBLIC_ORIGIN`, `WARD_API_BASE_PATH` and a fresh `WARD_APP_KEY` into this repo's `.env`. It is safe to re-run.

## 3. Configure

There is one `.env`, at the repo root, read by both the web app and the API.

```bash
cp .env.example .env
```

Then run the seed (step 2) so the Ward values are real. Every variable below is required unless marked optional; the API stops at startup with a list of what is missing.

| Variable | Purpose | Value locally |
|---|---|---|
| `VITE_API_URL` | Where the browser calls the API | `http://localhost:5173/atrium-api` (the web dev server proxies it) |
| `BASE_PATH` | Sub-path the web app is served under | `/atrium/` |
| `PORT`, `HOST` | Where the API listens | `3001`, `0.0.0.0` |
| `WARD_PUBLIC_ORIGIN` | Ward's origin, also the expected token issuer | `http://localhost:8792` |
| `WARD_API_BASE_PATH` | Ward's API prefix | `/ward-api` |
| `WARD_APP_KEY` | Atrium's Ward service key. A secret: server-side only, never logged | written by `seed.mjs` |
| `MAX_UPLOAD_MB` | Largest file one upload may be | `50` |
| `CONVERT_JOB_TIMEOUT_MS` | Last-resort ceiling on one Convert job | `86400000` (24 hours) |
| `GUTENDEX_BASE_URL` | Optional. Gutenberg catalog the Discover page queries | public instance when unset |
| `LATEX_TIMEOUT_MS`, `LATEX_MAX_OUTPUT_MB`, `LATEX_MAX_PROJECT_MB` | Optional LaTeX limits | defaults in `.env.example` |
| `LIBRARY_DATA_DIR`, `LIBRARY_FILES_DIR`, `THUMBNAILS_DIR`, `LATEX_PROJECTS_DIR`, `DOCUMENT_VERSIONS_DIR` | Optional storage roots, see below | folders under `apps/api/` when unset |

`.env.example` explains each one in more detail.

## 4. Run

```bash
npm run dev
```

This builds `packages/shared` and `packages/typeset`, then runs three processes together: the web app on Vite (port 5173), the API under `tsx watch` (port `PORT`), and a `tsc --watch` on the typesetting engine. Open http://localhost:5173/atrium/.

The web dev server serves everything on one origin, the way Caddy does in the deploy: `/atrium-api` goes to the API (prefix stripped), and `/ward` and `/ward-api` go to Ward. So signing in goes through Ward's page and comes back to the app, and the API never needs CORS. `GET /atrium-api/health` answers without signing in.

The API's `API ready` log line lists the five storage roots it is using. Check it whenever you point Atrium at other data.

## Run against a scratch library

By default the library lives under `apps/api/` (`data/`, `library/`, `images/`, `latex/`, `versions/`, all gitignored). To try things without touching it, point all five storage roots somewhere else on the command line:

```bash
S=/tmp/atrium-scratch
mkdir -p "$S"/data "$S"/library "$S"/thumbnails "$S"/latex "$S"/versions
LIBRARY_DATA_DIR=$S/data LIBRARY_FILES_DIR=$S/library THUMBNAILS_DIR=$S/thumbnails \
LATEX_PROJECTS_DIR=$S/latex DOCUMENT_VERSIONS_DIR=$S/versions npm run dev
```

Redirect all five together. Moving only the database leaves the other roots on the real files, which is how a test run deleted a real book on 2026-08-25. Values passed on the command line win over `.env`.

## Test, typecheck, build

```bash
npm test             # the typesetting engine's suite, then the API's
npm run typecheck
npm run build
```

The API tests run on a harness that cannot reach the real library ([corpus/wiki/api-layering.md](../corpus/wiki/api-layering.md) says how).

## The docs site

The site at https://gandolh.ro/atrium/docs/ is the workspace in `apps/docs` (Starlight). It renders the `corpus/` wiki, adds a route table and the database schema, and generates a TypeScript reference with TypeDoc. Its scripts are in `apps/docs/package.json`.

## Common problems

- **The page never gets past loading, or says sign-in is unavailable.** The API cannot reach Ward, or Ward refused its app key; either way it answers 503. Check that http://localhost:8792 answers and that `WARD_PUBLIC_ORIGIN` points at it. If it does, re-run `seed.mjs` so `WARD_APP_KEY` is one Ward knows.
- **You land on Ward's sign-in page in the middle of a session.** The Ward session ran out. Sign in again; it returns you to Atrium.
- **Convert fails on every book.** `ebook-convert` is not on `PATH`; install Calibre.
