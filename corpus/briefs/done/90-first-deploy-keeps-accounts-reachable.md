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

## Outcome (2026-10-27)

**Done**, code in `d1dca29`.

- **The boot log.** [`initDatabase()`](../../../apps/api/src/database/bootstrap.ts)
  now answers `{ accounts, migratedAccounts }`: the subjects `linkWardSubjects`
  created users for this boot, each with its username. `index.ts` passes them to
  `logMigratedAccounts`, which writes one `warn` per account, with `subject` and
  `username` as fields:
  `Ward subject 0a1b2c3d-… is now user-0a1b2c3d with no password: sign in with Ward, then set a password in Settings`.
  With Ward off (no `WARD_OIDC_ISSUER`) the line instead says the account has no
  way in, and names both ways to give it one. Only the boot that creates an
  account logs it; later boots migrate nothing and log nothing. The two test
  callers of `initDatabase()` (the harness and `errors.test.ts`) take
  `accounts` from the new shape.
- **`seed:user --set-password`.** [`seed-user.ts`](../../../apps/api/src/scripts/seed-user.ts)
  takes one flag. With it, the username must exist (else exit 1, "No account is
  named …", nothing created); the library's `setPassword` sets the password and
  ends every session the account holds; the role and everything the account owns
  stay as they are, and `SEED_ROLE` is not read. Any other argument is refused,
  so a typo never creates an account. Without the flag the script behaves as
  before, and its "already exists" line now names the flag.
- **No `--rename`** (the brief made it optional). The vendored library 0.3.1 has
  no username change on `Accounts` or its store, and writing its `users` table
  from atrium would bypass its username policy and folding, which D58 leaves to
  the library. The docs say a username cannot be changed yet.
- **The steps.** [`getting-started.md`](../../../docs/getting-started.md) has
  "Upgrading to local accounts": what the migration makes and logs, why seeding a
  new account for the same person is wrong, then the first deploy in order: keep
  `WARD_OIDC_*` set, read the boot log, each person signs in with Ward and sets a
  password, `--set-password` for whoever cannot, and only then seed new accounts
  (the bot's `jukebox` one). The seed paragraph in step 2 points at it.
  [`status.md`](../../wiki/status.md)'s owed list says the same in one line.

**Checked:**
- [`accounts-upgrade.test.ts`](../../../apps/api/test/accounts-upgrade.test.ts):
  a profile on a Ward subject with no user, then `initDatabase()` answers that
  subject as `user-0a1b2c3d`, the log line is exact with Ward on and names
  `--set-password` with Ward off, and the next boot answers none.
  `--set-password` runs the real script (`tsx src/scripts/seed-user.ts`) against
  the test's scratch database: the password is refused before (401), accepted
  after (200, the same user id, still `member`, still its one profile); an
  unknown username exits 1 and creates nothing; without the flag an existing
  account's password is unchanged.
- the built API booted twice on a scratch library with `NODE_ENV=production`:
  after two pre-D58 profiles were inserted, the second boot (Ward off) logged both
  `Ward subject … is now user-0a1b2c3d …` and `… user-99aa77bb …` lines before
  `API ready`, and a third boot logged neither;
- `npm run seed:user -w @ebook-reader/api -- --set-password` passes the flag
  through npm (an unknown username exits 1 with the message);
- `npm run typecheck` is clean and the API suite passes (120 of 120).

Not checked live: the Ward-on path of a real first deploy (signing in with Ward,
then setting a password in Settings). The deploy is the owner's.
