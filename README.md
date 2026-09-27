# Atrium

A personal media gallery — a per-user library of books (PDF/EPUB), music (MP3),
and video (MP4/WebM) you can open, read, listen to, and watch anywhere, plus a
Notes tab for drawing and writing. Local-first, installable (PWA), with a quiet,
typographic design.

## Running it locally

```bash
npm install
cp .env.example .env
npm run dev          # web on :5173, API on :3001
```

Open http://localhost:5173/atrium/. The web dev server also answers for the API
at `/atrium-api` and for Ward at `/ward`, the way the deployed estate does, so
signing in goes through Ward's page and comes back to the app.

Atrium has no accounts of its own, so start a local Ward first: the container
in [`../wzd_auth/infrastructure/local`](../wzd_auth/infrastructure/local). Its
`seed.mjs` registers atrium, grants your account access and writes
`WARD_APP_KEY` into `.env`. To run against scratch data, set the five storage
roots at the end of `.env.example`.
