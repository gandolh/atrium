# Task 71 — The corpus and CLAUDE.md describe the auth that exists

**Filed 2026-09-25** by the improvements sweep. The front door every agent reads
first still describes the deleted auth system.

## Context

[CLAUDE.md](../../../CLAUDE.md) sends every agent to the corpus first, and ranks
the wiki as the synthesis to trust. Code still wins: "actual code > any wiki
claim". Since the Ward move (D53, 2026-09-06), the pages an executor reads to
orient describe the deleted system as current:

- **[CLAUDE.md](../../../CLAUDE.md)**, in the project one-liner (around lines
  81-85), says the backend owns "auth (operator-seeded accounts, opaque sessions,
  scrypt — D30)", and "accounts come from `apps/api/scripts/seed.ts`".
- **[architecture.md](../../wiki/architecture.md)**:
  - `:69-73`: the D30 auth flow (`POST /auth/login`, `Bearer`/`?token=`).
  - `:97`: the database holds "users, … sessions".
  - `:140-143`: the `users` and `sessions` tables.
  - `:65`: `?token=` media `src`.
  - `:186-193`: the "Auth (D30, `auth.ts` + `password.ts`)" stack entry.
  - `:195`: "`POST /convert` — unchanged, still stateless", which has been stale
    since D34 retired it.
- **[api-layering.md](../../wiki/api-layering.md)** `:19-22`: the module tree
  lists `auth/` and `common/password.ts`, and omits `ward/`, the module that
  actually implements the guard.
- **[glossary.md](../../wiki/glossary.md)**, the naming authority:
  - **Session** (`:147`) says it is "not a JWT and not a cookie (D30)". Since D53
    it is both. By the glossary's own rule, "a term used against its definition
    is a finding, not a typo".
  - **Account** (`:102`) and **Seeded account** (`:142`) describe the deleted
    mechanism.
- **[decisions.md](../../wiki/decisions.md)**:
  - D17 ("Local dev only — `npm run dev`, no Docker/deploy", `:37`) is contradicted
    by `infrastructure/` and the VPS deploy (2026-09-06). It needs a
    revised-marker, with the date and a pointer, not silent editing.
  - The frontmatter summary still says "D1–D47".
- **[status.md](../../wiki/status.md)** stops at 2026-08-30. It has no entry for
  the Ward move or the docs site, and no rows for briefs 53–72.

## Scope

**In:** the pages above, `index.md`'s generated catalog (re-run `lint.sh
--index`), and a [log](../../log.md) entry.

**Out:**
- rewriting history (`status-history*.md`, done briefs, old log entries);
- D23, which brief 72 owns;
- D29's parenthetical, which brief 69 owns;
- D14, which brief 65 owns.

## Files you OWN

- `CLAUDE.md` (the project one-liner only)
- `corpus/wiki/architecture.md`, `corpus/wiki/api-layering.md`,
  `corpus/wiki/glossary.md`, `corpus/wiki/status.md`
- `corpus/wiki/decisions.md`: D17's row and the frontmatter summary only
- `corpus/index.md` (regenerated only), `corpus/log.md` (append only)

## Files you must NOT touch

- Any code.
- `corpus/briefs/done/**` and `superseded/**`, which are immutable.

## What to do

1. **Rewrite each stale passage from the code**, not from memory:
   [`modules/ward/`](../../../apps/api/src/modules/ward/ward.guard.ts) and
   `20260906000000-ward-cutover.ts` are the sources. Cover:
   - the 401/403/503 outcomes;
   - the `ward_session` cookie;
   - `profiles.subject`;
   - `profile_selections (subject, sid)`;
   - the lazy Default provision.

   Delete `?token=` and the `/auth/*` routes.
2. **Glossary.**
   - Redefine **Session** as Ward's. **Account** becomes "a Ward subject holding
     an `atrium` grant".
   - Retire **Seeded account** with a pointer to D53. Where a term is retired,
     say so, per the page's format.
3. **D17.** Mark it revised on 2026-09-06: the API ships as a container to the
   VPS. Point at `infrastructure/`, and write the reason in one line.
4. **Status.** Add a dated "Latest" entry for 2026-09-06 (Ward, docs site) and one
   for this sweep. Add rows for briefs 53–72 as **todo**. Move superseded text to
   [status-history.md](../../wiki/status-history.md) if the page passes about 200
   body lines.
5. **Finish.** Run `bash corpus/lint.sh --index`, then `bash corpus/lint.sh`.

## Acceptance

- `grep -n "seed.ts\|/auth/login\|?token=\|password.ts\|users.*sessions"
  CLAUDE.md corpus/wiki/architecture.md corpus/wiki/api-layering.md
  corpus/wiki/glossary.md` returns only lines that explicitly describe the
  **removal**.
- Every claim on the edited pages about auth, tables or modules can be checked
  against a named file.
- `bash corpus/lint.sh` passes, including the page-size limit.

## Outcome (2026-10-03)

Done. Each passage was rewritten against the code: `modules/ward/ward.guard.ts`, `20260906000000-ward-cutover.ts`, `profiles/profile-selection.model.ts` and `database/bootstrap.ts`'s `ensureDefaultProfile`.

- **CLAUDE.md one-liner:**
  - per-person profiles inside Ward accounts, and per-profile notebooks;
  - the backend's real responsibilities, conversion (D34) and the LaTeX editor included;
  - "Identity is Ward's (D53)": no login, users or sessions of its own, a guard requiring an `atrium` grant (401/403/503), and profiles keyed on the subject.
- **architecture.md:**
  - the D30 diagram is replaced by the Ward guard flow: cookie, local EdDSA verify, introspection cached 30 s, the 401/403/503 outcomes, lazy Default provisioning, `profile_selections`, allowlist `GET /health` + `OPTIONS`;
  - media `src` rides the cookie, not `?token=`;
  - the storage line lists today's tables;
  - `users`/`sessions` are gone; `profiles` is keyed on `subject`, and `profile_selections (subject, sid)` is added;
  - the backend-stack auth bullet and the stale `POST /convert` bullet are replaced.
- **api-layering.md:** the module tree has `ward/` (client, guard, types) and the profile-selection model, and no `auth/` or `password.ts`.
- **glossary.md:**
  - **Account** is a Ward subject holding an `atrium` grant;
  - **Session** is Ward's cookie JWT, whose `sid` keys the active profile;
  - **Seeded account** is retired (2026-09-06, D53) with a pointer;
  - the Library entry says per-profile.
- **decisions.md:**
  - D17 is struck through and marked **REVISED 2026-09-06**, pointing at `infrastructure/` and commit `6dc88fe`. The reason was taken from that commit, not invented: the app runs in production, and the container moved Calibre off the shared VPS.
  - The summary reads D1–D54.
- **status.md:**
  - new entries for this sweep, 2026-09-27 and 2026-09-06 (Ward, the container, the docs site);
  - rows for 63, 71 and 72–77, in order.
  - The 2026-08-29/30 narrative moved to the top of `status-history.md`. That page's 2026-08-26/27 entries moved to a new `status-history-v2.md`, keeping every page under 200 lines. Archived text is unchanged apart from its date label.
- **Index** regenerated (`lint.sh --index`, 19 pages), and `bash corpus/lint.sh` passes.

The acceptance grep returns only lines that describe the removal. Not touched, as scoped: D14 (65), D23 (72), D29 (69), history pages' content, and done briefs.

Found, not fixed, because this brief may not touch code: `ward.guard.ts`'s header still says `app.ts` "carries a log serialiser that redacts `?token=`" (it was removed), and its profile comment says the selection FK is `ON DELETE SET NULL` (it is `CASCADE`). Both are stale comments for the next change in that file.
