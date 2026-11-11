# Atrium

A personal media gallery: books, music, video and notes, with per-person profiles inside accounts. React and
Vite on the web, Fastify and SQLite behind it, and its own typesetting engine for the LaTeX editor. Read
[corpus/index.md](corpus/index.md) first; the corpus schema is [corpus/CLAUDE.md](corpus/CLAUDE.md).

## Commands

- `npm run dev`: builds `shared` and `typeset`, then the web app, the API and the typeset watcher.
- `npm run check`: typecheck, lint, format check, conventions, tests. Run it before every hand-back.
- `npm run check:fast`: the typecheck, then ESLint on the changed files. The Stop hook runs it.
- One API test: `npm exec -w @ebook-reader/api -- node --import tsx --import ./test/setup.ts --test test/<file>`.
- One typeset test: `npm exec -w @ebook-reader/typeset -- node --test test/<file>`.
- `npm run format`: Prettier writes every file it covers (Markdown stays out).
- `npm run seed:user -w @ebook-reader/api`: a local account.

## Places that mislead

- `pretest` and `pretypecheck` build `shared` and `typeset` first, so a clean checkout needs no manual build.
- `.env` sits at the repo root, not in `apps/api/`.
- The internal scope `@ebook-reader/*` stays on purpose (D32). The product is Atrium.
- The web app is served under `/atrium/`; Vite and the API take the path from the environment.
- Tests run on `node:test`, not vitest. `apps/docs` is a Docusaurus workspace outside every check here.
- `vendor/house-style/`, `apps/api/vendor/` and `apps/web/vendor/` are generated copies. Never edit them;
  `npm run house-style:sync` refreshes the first.

## Hard rules

- **No secrets.** Never write a password, token or key into the corpus or the repo.
- **No CI.** Don't add GitHub Actions, runners or other GitHub-specific automation.
- **No pushes.** Commit locally on `main`. The owner pushes.
- **Corpus changes are committed only when the owner asks**, unless a brief's closeout says to.
- **Design gate:** every `apps/web` change meets the conformance checklist in
  [corpus/wiki/design.md](corpus/wiki/design.md).

## brief-board

Brief progress goes on brief-board. Run `brief-board guide` before you
start or resume a brief, and follow it.
