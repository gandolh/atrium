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

## Outcome (2026-10-27)

**Done**, corpus only, so one commit.

- [`jukebox.md`](../../wiki/jukebox.md), "Who may call what": the bot has a local
  account with the `jukebox` role, made with `npm run seed:user` and
  `SEED_ROLE=jukebox`, and signs in with `POST /atrium-api/auth/login`; links D55
  as amended by D58 and the guard at `modules/auth/auth.guard.ts`. Also corrected
  while there: the allowlist includes the account's own `/auth/*` routes (the
  guard's `jukeboxMayReach`), and the role is one string, so the old line
  "`jukebox` beside any other role is full access" is gone. Two additions, each
  checked in the code: a session lasts at most 30 days and 14 idle (the vendored
  library's `SESSION_ABSOLUTE_SECONDS` and `SESSION_IDLE_SECONDS`), so the bot
  must be able to sign in again; and the bot's sign-ins share the lockout, so
  brief 89's `AUTH_TRUSTED_PROXIES` matters to it.
- [`glossary-jukebox.md`](../../wiki/glossary-jukebox.md) repeated the claim:
  "Bot account" is now the local account the bot signs in to with a password.
- Both pages' `updated:` is 2026-10-27.

**Checked:** `grep -i ward corpus/wiki/jukebox.md` finds nothing, so neither
`ward.guard.ts` nor a Ward account for the bot is named; `bash corpus/lint.sh`
passes. How just-a-bot signs in (its commit `296aa33`) was taken from the brief,
not read: that repo was out of bounds for this run.
