# Task 69 — Retire what removed features left behind

**Filed 2026-09-25** by the improvements sweep. A broken `npm run seed`, a
required environment variable that does nothing, and dead auth code D53 says was
deleted.

## Context

Two retirements left debris.

**D53 (the Ward move) deleted `password.ts`, `scripts/seed.ts` and the auth
module.** Some pieces remain:

- [`apps/api/src/common/password.ts`](../../../apps/api/src/common/password.ts)
  still exists. Its only importer is the next item.
- [`apps/api/scripts/seed.example.ts`](../../../apps/api/scripts/seed.example.ts)
  imports `../src/modules/auth/auth.model.js` (line 7), a module that no longer
  exists, so anyone following its header instructions gets a crash.
- [`apps/api/package.json`](../../../apps/api/package.json) keeps
  `"seed": "tsx scripts/seed.ts"`, pointing at a file that is gone.
- [`.gitignore:52-53`](../../../.gitignore) still ignores
  `apps/api/scripts/seed.ts` "(holds real credentials)".
- [`config.ts:35`](../../../apps/api/src/common/config.ts): the comment still
  explains non-empty validation with "`APP_PASSWORD=` counts as unset".

**D34 retired the synchronous `POST /convert` route**, and its timeout survived
it. `CONVERT_TIMEOUT_MS` is still **required**: a deploy without it fails at boot
(`config.ts:43`). Yet its only use is a field in the "API ready" log line
(`index.ts:2,59`). `config.ts:116-118` itself calls it "the old 60s cap on the
*synchronous* export route". `.env.example:48` lists it with no explanation,
unlike every neighbour.

Harmless extra variables are ignored, so removing a required one is
backward-compatible. vps-deploy can stop sending it at leisure; brief 55's
outcome lists that.

## Scope

**In:** deleting the dead files, script and ignore entry; removing
`CONVERT_TIMEOUT_MS` from the contract; stale comments in the files named here;
the D29 parenthetical in `decisions.md` that lists `CONVERT_TIMEOUT_MS` as
required.

**Out:**
- `infrastructure/docker-compose.yml`'s `APP_PASSWORD` comment (brief 55 owns
  that file);
- `CLAUDE.md` and the wiki's auth descriptions (brief 71);
- `apiFetch`'s unused `skipAuthRedirect`, which its comment keeps
  **deliberately**;
- the vps-deploy repository.

## Files you OWN

- `apps/api/src/common/password.ts` (delete)
- `apps/api/scripts/seed.example.ts` (delete, and the now-empty `scripts/`
  directory)
- `apps/api/package.json` (the `seed` script)
- `.gitignore` (the seed entry and its comment)
- `apps/api/src/common/config.ts` (`CONVERT_TIMEOUT_MS`, the stale comments)
- `apps/api/src/index.ts` (the import and the log field)
- `.env.example` (the variable)
- `corpus/wiki/decisions.md`: only D29's parenthetical list of required variables

## Files you must NOT touch

- `infrastructure/**` (brief 55), `CLAUDE.md` and other wiki pages (brief 71),
  `apps/api/src/common/config.ts`'s path logic (brief 53). If 53 is in flight,
  land it first; both edit `config.ts`.

## What to do

1. Delete the two files, the directory, the script and the ignore entry.
2. Remove `CONVERT_TIMEOUT_MS` from the schema, the export, the import and the
   log line, and from `.env.example`. Keep `CONVERT_JOB_TIMEOUT_MS` and its
   comment, and trim that comment's contrast with the removed variable.
3. Update D29's parenthetical and fix the stale comments. Add a one-line
   [log](../../log.md) entry.

## Acceptance

- `grep -rn "CONVERT_TIMEOUT_MS\|seed.ts\|seed.example\|common/password" apps
  packages .env.example .gitignore` returns nothing (outside `dist/`).
- The API boots with a `.env` that omits `CONVERT_TIMEOUT_MS`, and still boots
  with one that includes it. Use scratch storage roots, set inline and asserted.
- Typecheck and build are clean, and `bash corpus/lint.sh` passes.
