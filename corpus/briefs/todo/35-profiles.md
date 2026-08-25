# Task 35 — Profiles: several readers behind one account

## Context

Owner request (2026-08-24): Netflix-style profiles — *"the same user, but it
might have different profiles."* One login, several people behind it, each with
their own Continue row, resume positions, and reading settings.

**Owner's framing (2026-08-24, confirmed):** *"an account is like a household,
while profiles are for different persons from the household. They can change
freely the profile."* That sentence settles the two questions this feature
usually turns on. An **account is a household** — so the shared library is
correct and stays shared, and a profile is never a wall between housemates.
Switching is **free** — no password, no PIN, no gate — which makes a profile an
identity boundary and explicitly not a security boundary (see below).

### Why this isn't just "more users"

The obvious objection first, because a build should not discover it halfway.
D30 already gives us multiple accounts over a **shared library** with per-user
progress (D31) — structurally most of what profiles do. The difference is
entirely in the friction, and the friction is the feature:

| | Users (D30) | Profiles (this brief) |
|---|---|---|
| Switching | log out, type a password | one tap, no credential |
| Creating one | operator runs `scripts/seed.ts` over SSH | a button in the app |
| Is it a security boundary? | **yes** — scrypt + opaque session | **no** — see below |

A household sharing a tablet cannot use accounts for this: retyping a password
to switch from one person's book to another's is exactly the friction the owner's
"change freely" rules out. So: **an account is the household and the security
boundary; a profile is a person in it and the identity boundary.** Both layers
keep doing what they are good at.

**Profiles are explicitly NOT access control.** Free switching means anyone
holding a live session token can become any profile on that account and read its
state — that is the design, not a gap in it. It must be written down, because the
tempting later mistake is to treat a profile as a permission. Housemates who need
real separation from each other are a second **household** (a second user
account), not a profile.

### What's actually per-user today (verified 2026-08-24)

The blast radius is small and well-contained — exactly **two tables**:

- `reading_progress (user_id, book_id)` PK → `progress`, `locator` — D31.
- `notes (user_id, …)` — brief 26, plus the `(user_id, updated_at DESC)` index.

They are reached through ~10 prepared statements in
[db.ts](../../../apps/api/src/db.ts) and **four** route sites:
[library-routes.ts:190](../../../apps/api/src/library-routes.ts#L190) (list merge),
[:294](../../../apps/api/src/library-routes.ts#L294) (progress PATCH), and the
`uid()` helper at [notes-routes.ts:61](../../../apps/api/src/notes-routes.ts#L61).
Everything else — the books table, files, covers, catalog, players — is shared and
stays untouched. The library remains shared **across profiles as well as users**,
consistent with D30.

Client-side, three things carry identity implicitly and will silently serve the
wrong profile's data if missed:

1. **Query keys have no identity in them** — `["library", sort]`
   ([use-library.ts:44](../../../apps/web/src/lib/use-library.ts#L44)) and
   `NOTES_KEY`. A switch must clear the cache, not just refetch.
2. **The offline pending-progress queue**
   ([use-progress-sync.ts](../../../apps/web/src/lib/use-progress-sync.ts) +
   `offline-store.ts`) holds unsynced records that flush on reconnect. A record
   queued as one profile and flushed after a switch would be written to the
   wrong profile. Records must carry the profile that made them.
3. **Preferences are global localStorage keys** (and font settings aren't
   persisted at all)
   (`ebook-reader:theme`, `:page-mode`, `:toc-sidebar-open` in
   [reader-store.ts](../../../apps/web/src/store/reader-store.ts)) — shared by
   everyone on the device today.

### Decisions taken in this brief

Grilled with the owner on 2026-08-24. Decisions 2, 3, 4, 5, 6 and 8 are
**owner-confirmed**; 1 and 7 are the builder's calls, put to the owner and
unopposed.

1. **The session carries the active profile.** `sessions.active_profile_id`,
   switched by `POST /profiles/:id/activate`. Rejected: a `X-Profile-Id` header
   on every request (media `<img>`/`<audio>` tags can't send headers — the
   codebase already hit this and fell back to `?token=`, so a header-based
   scheme would need a query-param twin and two ways to be wrong); and minting a
   new token per profile (churns the stored token and logs other tabs out).
   Session-carried costs **zero changes to how any request authenticates** — the
   guard resolves the profile alongside the user. Consequence to accept: one
   device = one active profile, so two tabs cannot be two profiles. That is
   Netflix's semantic too.
2. **Progress and resume move from user scope to profile scope — owner-confirmed.**
   This is the point of the feature — the D33 Continue hero is per-profile or
   nothing. Migration: every existing user gets an auto-created **"Default"**
   profile and their rows move to it, so nobody loses a position.
3. **Notes move to profile scope too — owner-confirmed**, with a guard: deleting a
   profile that owns notes must offer to reassign them to the account's default
   profile rather than destroying authored work. A profile is "who you are in
   the app", so a notebook belonging to one is the consistent model — but notes
   are *authored*, unlike progress, so silent loss is unacceptable.
4. **Preferences move to the profile row in the DB — owner-confirmed**
   (*"remember the app settings per profile. Save it in db"*). All four move as
   **one JSON `preferences` blob** on the profile row, matching the `notes.data`
   JSON precedent: **theme**, **font settings** (size, face, line spacing,
   margins), **page mode**, and **TOC sidebar**. The first draft kept these
   device-local in namespaced localStorage; server-stored is the owner's call and
   is strictly better — preferences now follow a person between devices.

   **This revises D9** ("display state is device state") for preferences
   specifically; reading *position* stays out of it (that is D31's locator).

   Two things this makes load-bearing. **(a)** Font settings are **not persisted
   at all today** — `setFontSettings`
   ([reader-store.ts:235](../../../apps/web/src/store/reader-store.ts#L235))
   writes only to Zustand, with no localStorage key unlike theme/page-mode/TOC.
   So size, face, line spacing and margins reset on every reload right now; this
   brief makes them persist for the first time, it does not merely relocate them.
   **(b)** The theme must be readable **synchronously at boot** or the app paints
   in the wrong theme and snaps when the profile fetch lands — so the active
   profile's blob is mirrored to localStorage as a boot cache and reconciled
   after the fetch. Writes are debounced, or dragging the font-size slider
   PATCHes per pixel.

   **There is only one theme, not two.** The reader's light/sepia/dark drives
   `data-theme` app-wide — LibraryHome, Discover and Notes all follow it — so the
   owner's "theme of the platform" and the reading theme are the same setting.
5. **No PIN lock — owner-confirmed** ("they can change freely the profile").
   Netflix's profile lock is the obvious follow-up and `password.ts` scrypt
   could back it, but free switching is the stated requirement, and a lock on a
   non-security boundary would only imply a protection that isn't there. Do not
   half-build one.
6. **The picker returns after 24h idle — owner-confirmed.** After login, show
   "Who's reading?"; remember the choice on the device so a daily reader is never
   asked again, but **re-show it once the device has been idle past 24 hours**,
   measured device-side (a last-activity timestamp in localStorage — the server
   cannot tell which device a session was last used from). This is the household
   fix: `sessions` has **no expiry column**, so a tablet stays logged in
   indefinitely, and a purely remembered choice would silently attribute
   everyone's reading to whoever last used it. Rejected: always showing the
   picker (a tax on the 90% of loads that are the same person on their own
   phone). Always reachable from the header switcher.
7. **Offline downloads stay device-scoped, not profile-scoped.** A downloaded
   blob is a copy of a shared library file; re-downloading it per profile wastes
   storage. Only the *progress* records inside the offline store get a profile.
8. **Cap profiles at 5 — owner-confirmed**, Netflix's number, chosen to keep
   the picker one row.

## Files you OWN

- `apps/api/src/db.ts` — `profiles` table, `sessions.active_profile_id`,
  the two per-user tables' migration, the profile-scoped statements.
- `apps/api/src/profile-routes.ts` — **new**: profile CRUD + activate.
- `apps/api/src/auth.ts` — resolve the active profile onto the request
  alongside `authUser`; default-profile selection at login.
- `apps/api/src/library-routes.ts` — the two progress sites only.
- `apps/api/src/notes-routes.ts` — the `uid()` helper → profile id.
- `apps/api/src/index.ts` — register the routes.
- `apps/api/scripts/seed.ts` — seed a Default profile with each user.
- `packages/shared/src/` — the profile contract + `profile` on the login response.
- `apps/web/src/lib/auth.ts` — active-profile state + storage.
- `apps/web/src/profiles/` — **new**: picker, switcher, manage screen.
- `apps/web/src/lib/query-client.ts`, `use-library.ts`, `notes/use-notes.ts` —
  cache reset on switch.
- `apps/web/src/lib/offline-store.ts`, `use-progress-sync.ts` — tag pending
  progress with the profile (**this and only this** in those files).
- `apps/web/src/store/reader-store.ts` — read/write preferences through the
  active profile instead of the bare localStorage keys.
- `apps/web/src/lib/preferences.ts` — **new**: the blob's shape, the boot
  cache, and the debounced write.
- `apps/web/src/components/AppHeader.tsx` — the switcher entry point.

## Files you must NOT touch

- `password.ts` — no PIN in v1 (decision 5); auth stays exactly as D30 left it.
- The books table, `extract.ts`, `library-routes.ts` upload/file/cover routes,
  `catalog-routes.ts`, `convert-route.ts`, `calibre.ts` — the library is shared;
  nothing about a file or its metadata is profile-scoped.
- `apps/web/src/reader/**` and `apps/web/src/player/**` internals — they read
  prefs and progress through the store and the API, both of which change
  underneath them without their knowledge.
- The offline **blob** store paths (decision 7) — only progress records change.
- **Coordination:** brief 34 (Convert, unbuilt) is **independent** — its final
  design uses linked `books` rows and does not touch `reading_progress` at all.
  Build 35 first by preference, not by constraint. One consequence worth knowing:
  once profiles land, 34's "reopen in the format you last used" becomes
  per-profile for free, since it reads `reading_progress.updated_at`.

## What to do

1. **Contract** (`packages/shared`): `profileSchema` — `id`, `name` (1–24 chars,
   trimmed, unique per account), `color` (a token from the Reading Room palette,
   standing in for Netflix's avatar), `createdAt`, `isDefault`. Add `profile` and
   `profiles` to the login response so the client can render the picker without
   a second round-trip.

2. **DB** (`db.ts`):
   - `profiles (id TEXT PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE
     CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, is_default INTEGER NOT
     NULL DEFAULT 0, created_at TEXT NOT NULL)` + a unique index on
     `(user_id, name)`.
   - `sessions.active_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL`
     via the idempotent-ALTER pattern. `SET NULL`, not cascade — deleting a
     profile must not log the device out; it falls back to the default.
   - **Migration, the load-bearing step.** `reading_progress` and `notes` are
     keyed on `user_id`, and `reading_progress`'s composite PK means SQLite
     cannot ALTER it — both need the create-copy-drop-rename rebuild inside a
     single transaction with `foreign_keys` handling per SQLite's documented
     procedure. Order: create one `is_default` profile per existing user →
     rebuild each table with `profile_id` in place of `user_id` → copy rows
     joining through the new default profiles → recreate the notes index on
     `(profile_id, updated_at DESC)`. **Idempotent and safe on an empty DB**,
     like every other migration here. Verify row counts before and after; a
     mismatch must abort the transaction, not log and continue.

3. **Auth** (`auth.ts`): the guard resolves the session's active profile and
   attaches it as `request.authProfile` beside `authUser`. A session whose
   `active_profile_id` is null or dangling resolves to the account's default
   profile rather than 401-ing — a missing profile is never an auth failure.
   Login picks the default profile as active; the client may then activate
   another.

4. **Profile routes** (`profile-routes.ts`): `GET /profiles` (the account's
   own only — never another account's), `POST /profiles` (400 past the cap of
   5, 409 on a duplicate name), `PATCH /profiles/:id` (name/color),
   `DELETE /profiles/:id` (**400 on the last remaining profile**; if it owns
   notes, require `?reassign=1` and move them to the default — decision 3),
   `POST /profiles/:id/activate` (updates the session, returns the profile).
   Every route must verify the profile belongs to `request.authUser` — the id is
   client-supplied, so an unchecked id is a cross-account read.

5. **Scope swap** (`library-routes.ts`, `notes-routes.ts`): replace `user.id`
   with the active profile id at the four sites. Nothing else in these files
   changes; the shape of every response is identical.

6. **Picker + switcher** (`apps/web/src/profiles/`): a "Who's reading?" gate
   after login, skipped when the device has a remembered choice **less than 24h
   old** — stamp a last-activity timestamp in localStorage on each load and
   compare (decision 6) — a header
   switcher listing profiles with a Manage entry, and a manage screen for
   create/rename/recolor/delete. Deleting shows what is lost — and, when notes
   are involved, offers the reassign. All of it inside the Reading Room chrome
   (D33): the picker is a quiet typographic grid of name + color, not Netflix's
   avatar wall.

7. **The three silent-wrongness fixes** — do not skip these; each is a data bug,
   not polish:
   - **Cache**: `queryClient.clear()` on switch, and the profile id in
     `libraryKey`/`NOTES_KEY`. A stale Continue row from the previous profile is
     the most visible possible failure of this feature.
   - **Offline queue**: add `profileId` to the pending progress record; on
     flush, PATCH each record **as the profile that recorded it**, and drop
     records whose profile no longer exists. A switch must never re-attribute
     someone's reading.
   - **Preferences**: move the four groups into the profile's `preferences`
     blob (step 8), adopting the device's current localStorage values as the
     default profile's on first run so nobody's theme resets.

8. **Preferences** (`profiles.preferences` + `apps/web/src/lib/preferences.ts`):
   a JSON blob on the profile row holding **theme**, **font settings** (size,
   face, line spacing, margins), **page mode**, and **TOC sidebar**, read at
   login/switch and written back debounced (~500ms) through
   `PATCH /profiles/:id/preferences`. Three requirements that are easy to miss:
   - **Boot cache**: mirror the active profile's blob to localStorage and read it
     **synchronously** at startup. Without it the app paints the default theme
     and snaps to the real one when the profile fetch lands — the most visible
     possible regression from this change.
   - **Unknown keys survive**: parse with a tolerant schema and write back what
     you didn't recognize, so an older client can't silently strip a newer
     client's preference.
   - **Font settings become durable for the first time** — today they live only
     in Zustand and reset on reload. Seed them from `DEFAULT_FONT_SETTINGS` for
     existing profiles rather than writing a blob at migration time.

9. **Corpus** (last): a decision recording **profiles as an identity boundary
   inside an account, explicitly not a security boundary**, amending D30 (which
   says only identity and progress are per-user) and D31 (progress moves from
   user to profile scope). Add **Profile** to `wiki/glossary.md`, distinguished
   from **User**/account — one canonical sense each. Update `wiki/auth.md` (or
   wherever D30 is narrated), `wiki/status.md`, and `log.md`.

10. **Verify live**: migrate a DB **with existing progress and notes** and
   confirm every row lands on the right default profile and nothing is lost;
   create a second profile, read a book to page 40 as A, switch to B, confirm B
   sees a clean Continue row and starts that book at page 1, switch back and
   confirm A resumes at 40; confirm notes follow the profile; go offline, read
   as A, switch to B, reconnect, and confirm A's position syncs to **A**;
   confirm each profile keeps its own theme **and font size**, that they follow the
   profile to a second device, and that a cold load paints the right theme with no
   flash; delete a profile with notes both
   ways (refused without reassign, moved with it); try the last-profile delete
   (400); try activating another account's profile id (404, not 200); confirm
   uploads, covers, search, players, and the EPUB→PDF export are untouched.

## Acceptance

- One account holds up to 5 profiles; switching takes one tap and no password,
  and the header always shows who is active.
- Continue, all resume positions, and notes are per-profile; the library, its
  files, covers, and metadata stay shared.
- An existing database migrates with **zero lost progress or notes**, every user
  landing on an auto-created Default profile.
- Nothing from a previous profile survives a switch anywhere in the UI, and
  offline-queued progress always syncs to the profile that read it.
- Each profile keeps its own theme, font settings, page mode, and sidebar state,
  stored server-side so they follow the person to another device; a cold load
  paints the correct theme with no flash of the wrong one.
- The picker reappears once a device has been idle for 24h, and never before.
- A profile id from another account is never readable; the last profile cannot be
  deleted; deleting a profile with notes cannot silently destroy them.
- The corpus records that a profile is not a security boundary.
- Typecheck + build + tests clean; Reading Room (D33) conformance passes on the
  picker, switcher, and manage screen.
