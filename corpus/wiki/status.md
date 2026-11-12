---
summary: Dated snapshot (2026-11-02) of Atrium, per area — the media library (books, music, video) and its readers, Notes, the LaTeX editor on its own typesetting engine, profiles, accounts (local plus "Sign in with Ward", in production since 2026-10-13), the Jukebox, the two improvement sweeps (done 2026-10-03 and 2026-10-27), the metadata lookup (2026-10-28); what is deployed, what the owner still owes, and where the older history lives.
updated: 2026-11-11
---

# Status — 2026-11-02

`origin/main` is at `9aadd14`; the local commits after it (`cd7925f` and the
briefs reset) are not pushed. `npm run typecheck` is clean and `npm test`
passes 794 tests (647 in the API, 147 in the typesetting engine). Brief
numbering restarted at 01 on 2026-11-02 (see [`../log.md`](../log.md),
"Briefs reset"); no brief is open.

## By area

- **The media library** (books since 2026-07-02, music and video since
  2026-07-16). Upload PDF, EPUB, MP3, MP4 or WebM; covers are extracted on the
  server (video covers in the browser, D40); per-kind areas at `/books`,
  `/music`, `/videos`; the Gutenberg discover page; PDF ⇄ EPUB conversion
  through Calibre (D34, 2026-08-26); cross-library search on the home
  (2026-08-24). **Look up…** asks MusicBrainz or Open Library on request and
  applies only the ticked fields (D59, 2026-10-28)
  ([conversion.md](conversion.md), [jellyfin-comparison.md](jellyfin-comparison.md)).
- **The readers** (2026-07-02, Reading Room since 2026-08-24). PDF and EPUB
  read in the browser, with per-profile progress and resume, offline reading as
  an installable PWA ([reader.md](reader.md), [pwa.md](pwa.md),
  [design.md](design.md)).
- **Notes** (2026-07-20, extended 2026-08-30). Per-profile paged notebooks with
  ink tools, folders and PDF export; an unsaved-notes stash survives an expired
  session (2026-10-21).
- **LaTeX** (2026-08-27). An editor with projects, drafts and published
  versions, on Atrium's own TypeScript typesetting engine (D38): a declared
  subset of LaTeX, figures, tables, bibliography and math (2026-08-26 to
  2026-08-29), compiled on a worker thread ([latex.md](latex.md),
  [typeset.md](typeset.md), [typeset-scope.md](typeset-scope.md)).
- **Profiles** (2026-08-25). An identity boundary inside an account, not a
  security one (D35).
- **Accounts** (2026-10-13, in production). Atrium's own accounts again (D58):
  a local password, with "Sign in with Ward" as a second way in, on Ward's
  vendored library. Ward's record of the cutover says production atrium serves
  its own `/auth/session` with Ward enabled since 2026-10-13.
- **The Jukebox** (2026-10-08 to 2026-10-09, fixes 2026-10-27). Atrium owns
  every Player and its Queue (D57); the Discord bot is a speaker limited to the
  `jukebox` role (D55) ([jukebox.md](jukebox.md)).
- **The API** (2026-08-30). Modules of controller, service and model over Knex
  and `better-sqlite3` (D47), with a test harness since 2026-10-03
  ([api-layering.md](api-layering.md)).
- **The improvement sweeps.** The 2026-09-25 sweep was worked through by
  2026-10-03, every API fix with a regression test; the 2026-10-20 sweep by
  2026-10-27 (the login lockout behind the proxy, migrated passwordless
  accounts, the Jukebox's delete, idle and failure fixes, the tile menu from the
  keyboard).
- **The house style** (2026-11-11, D60). Prettier at 120, the vendored `house-style` 1.1.0 ESLint
  config with typed rules, knip, dependency-cruiser, and `npm run check` /
  `npm run check:fast` as the gate. Zero lint errors; warnings stay for the
  react-hooks compiler rules (46), three API files that read the environment, and
  26 import cycles. `check-structure` runs `--warn-only` until the server brief
  (04). TypeScript is 6.0.3.
- **Base UI by the conventions, and a System theme** (2026-11-11, D61). Every Base
  UI import sits under `components/ui/` and `check-base-ui` runs strict (0 errors,
  0 warnings). The contents and search panels are drawers; the theme and the
  reading font are guarded toggle groups; the update prompt is a Base UI toast;
  stacking comes from `--z-index-*` tokens; `better-tailwindcss` runs in
  `npm run lint`. System is a fourth theme choice, stored per profile, so the
  shared schema gained `"system"` and the API needs the deploy too.
- **Docs site** (2026-10-19). Docusaurus at `/atrium/docs`, same URLs.

## Next (owner)

- **Deploy** what came after 2026-10-13: the docs site, the unsaved-work
  stashes, the 2026-10-20 sweep and the metadata lookup. Two migrations (the
  Jukebox idle report and the failure budget) run on that deploy.
- **just-a-bot's restated Jukebox shapes** lack `Player.failure` and the 409
  `NOT_IN_VOICE` that `/jukebox` can now get (its `jukebox/types.ts`).
- **The bot's `jukebox` account** in production, then just-a-bot's own deploy
  (its status page has the order).

## History

The run-by-run record, with what each run fixed and how it was verified, is
[status-history.md](status-history.md) (2026-08-29 to 2026-08-30),
[status-history-v2.md](status-history-v2.md) (2026-08-26 to 2026-08-27) and
[status-history-v1.md](status-history-v1.md) (the v1 era); everything since is
in [`../log.md`](../log.md).
