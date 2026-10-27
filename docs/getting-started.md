# Getting started

Everything needed to run Atrium on your own machine, with your own library or a throwaway one.

## Prerequisites

- Node 24 or later (`.nvmrc` pins 24.22.1) and npm.
- Optional: a local Ward, the estate's sign-in service, for the "Sign in with Ward" button. Atrium has its own accounts and runs without it. Ward runs in Docker from the sibling repo, `wzd_auth/infrastructure/local`, and answers on http://localhost:8792.
- Calibre, optional. Convert shells out to its `ebook-convert`. Without it the API logs a warning at startup and each conversion fails with that reason; everything else works.

## 1. Install

```bash
npm install
```

The workspaces are `packages/shared`, `packages/typeset` and `apps/*`. Their npm names keep the old scope, `@ebook-reader/*`.

## 2. Create an account, and optionally start Ward

Atrium signs people in with a local username and password. There is no Register page; make an account with the seed script, which reads `SEED_USERNAME` and `SEED_PASSWORD` from the environment or prompts for them:

```bash
SEED_USERNAME=you SEED_PASSWORD=... SEED_ROLE=member npm run seed:user -w @ebook-reader/api
```

For "Sign in with Ward" as well, follow the README in `wzd_auth/infrastructure/local`. In short, from that folder:

```bash
docker compose up -d --build
node seed.mjs
```

`seed.mjs` registers atrium as an OpenID Connect client and writes `WARD_OIDC_ISSUER`, `WARD_OIDC_CLIENT_ID`, `WARD_OIDC_CLIENT_KEY`, `WARD_OIDC_REDIRECT_URI` and `WARD_OIDC_POST_LOGOUT_REDIRECT_URI` into this repo's `.env`. It is safe to re-run. Skip this step and leave `WARD_OIDC_ISSUER` unset, and the login page has no Ward button.

## 3. Configure

There is one `.env`, at the repo root, read by both the web app and the API.

```bash
cp .env.example .env
```

To use "Sign in with Ward", run the Ward seed (step 2) so the `WARD_OIDC_*` values are real. Every variable below is required unless marked optional; the API stops at startup with a list of what is missing.

| Variable | Purpose | Value locally |
|---|---|---|
| `VITE_API_URL` | Where the browser calls the API | `http://localhost:5173/atrium-api` (the web dev server proxies it) |
| `BASE_PATH` | Sub-path the web app is served under | `/atrium/` |
| `PORT`, `HOST` | Where the API listens | `3001`, `0.0.0.0` |
| `PUBLIC_ORIGIN` | Atrium's origin as the browser sees it, no path | `http://localhost:5173` |
| `WARD_OIDC_ISSUER` | Optional. Ward's issuer, ending in `/oidc`. Unset, atrium runs on local accounts only | `http://localhost:8792/ward-api/oidc` |
| `WARD_OIDC_CLIENT_ID` | Atrium's client id at Ward, required with the issuer | `atrium` |
| `WARD_OIDC_CLIENT_KEY` | Atrium's private key at Ward. A secret: server-side only, never logged | written by `seed.mjs` |
| `WARD_OIDC_REDIRECT_URI` | The callback as the browser reaches it, registered at Ward | `http://localhost:5173/atrium-api/auth/ward/callback` |
| `WARD_OIDC_POST_LOGOUT_REDIRECT_URI` | Optional. Where Ward returns after "Sign out of Ward too" | `http://localhost:5173/atrium/` |
| `AUTH_TRUSTED_PROXIES` | Proxies whose `X-Forwarded-For` the sign-in lockout believes, comma-separated. Required behind a container proxy: unset, every client shares one lockout counter, and the API warns at boot when `NODE_ENV=production` | `172.16.0.0/12` (Docker's default bridges; harmless locally, where the proxy is loopback) |
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

The web dev server serves everything on one origin, the way Caddy does in the deploy: `/atrium-api` goes to the API (prefix stripped), so the API never needs CORS. There is no `/ward` proxy: "Sign in with Ward" sends the browser to Ward's own origin (http://localhost:8792) and back to the callback under `/atrium-api`. `GET /atrium-api/health` answers without signing in.

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

The site at `/atrium/docs/` is the workspace in `apps/docs` (Docusaurus). It renders the `corpus/` wiki, adds a route table and the database schema, and generates a TypeScript reference with TypeDoc. Its scripts are in `apps/docs/package.json`.

## Common problems

- **The API will not start and names a `WARD_OIDC_*` variable.** With `WARD_OIDC_ISSUER` set, the client id, key and redirect URI are required too. Re-run Ward's `seed.mjs`, or unset the issuer to run on local accounts only.
- **"Sign in with Ward" fails or returns an error.** Check that http://localhost:8792 answers and that `WARD_OIDC_ISSUER` points at it. The redirect URI in `.env` must match the one registered at Ward exactly; re-run `seed.mjs` if it does not. Password sign-in works while Ward is down.
- **Sign-in POSTs are refused.** `PUBLIC_ORIGIN` must be the origin in the browser's address bar, here `http://localhost:5173`.
- **Convert fails on every book.** `ebook-convert` is not on `PATH`; install Calibre.
- **Everyone gets 429 on password sign-in, in a container.** The lockout is counting the proxy, not the clients, so one person's wrong passwords lock everybody out. Set `AUTH_TRUSTED_PROXIES` to the proxy's network (`docker network inspect` shows its subnet). A log line "X-Forwarded-For ignored for the login lockout" names the peer that is missing.
