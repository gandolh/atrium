# Task 90: First deploy of the accounts rework: keep every household member's way in

## Context

- `apps/api/src/database/ward-subjects.ts:64-72` creates each migrated account as
  `user-<8 chars of the Ward subject>` with no password.
- `apps/api/src/database/bootstrap.ts:161` discards the list `linkWardSubjects` returns, which its
  own doc (`ward-subjects.ts:42`) says is "for the boot log".
- `apps/api/src/scripts/seed-user.ts:74-79` leaves an existing username untouched.
- The owner's Ward subject stays linked to the migrated account, so linking it to a new account
  fails (WardSubjectTakenError).

`wiki/status.md` lists "a seeded owner account" as owed for the deploy. Following it creates a
brand-new, empty account, while every notebook, LaTeX project and reading position belongs to the
migrated one, and the data looks lost. If the deploy also leaves the optional `WARD_OIDC_*`
variables unset, the migrated accounts have no way in at all. The only recovery today is: sign in
with Ward first, then set a password in Settings. Only D58 and a code comment say so.

Improvement sweep of 2026-10-20 (auth lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/src/database/bootstrap.ts` (log the migrated accounts)
- `apps/api/src/scripts/seed-user.ts` (a mode that sets a password on an existing account)
- `docs/getting-started.md` (an "Upgrading to local accounts" section)
- `corpus/wiki/status.md` (the owed steps)
- tests

## Files you must NOT touch

- `apps/api/vendor/ward/*`

## What to do

1. At boot, log each migrated account ("Ward subject … is now user-xxxxxxxx with no password: sign in with Ward, then set a password").
2. `seed:user --set-password` for an existing username (and optionally `--rename`).
3. Write the first-deploy steps in the docs and status.md: keep `WARD_OIDC_*` set for the first deploy, sign in with Ward, set a password, then seed any new accounts.

## Acceptance

- A test: boot logs the migrated subjects.
- A test: `seed:user --set-password` updates an existing user, who can then sign in with it.
