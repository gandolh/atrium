# Task 91: `jukebox.md`: describe the bot's local account, not the Ward one

## Context

`corpus/wiki/jukebox.md:15-18` says "The bot signs in as its own Ward account whose only atrium
role is `jukebox`" and names `modules/ward/ward.guard.ts`. Since D58 the guard is
`apps/api/src/modules/auth/auth.guard.ts`, and the bot needs a seeded local `jukebox` account that
signs in with `POST /atrium-api/auth/login` (just-a-bot commit 296aa33). The page says to read it
before touching the Jukebox, so whoever deploys the accounts rework follows stale steps.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `corpus/wiki/jukebox.md`
- `corpus/wiki/glossary-jukebox.md` (if it repeats the claim)

## What to do

1. Rewrite the sign-in paragraph: a local account with the `jukebox` role, made with `npm run seed:user`; link D55 as amended by D58.
2. Bump `updated:` and add a log.md line.

## Acceptance

- Nothing in the page mentions `ward.guard.ts` or a Ward account for the bot.
- `bash corpus/lint.sh` passes.
