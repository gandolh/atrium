---
summary: The genuinely unresolved threads only — each deleted the moment it's answered (history lives in status.md + log.md).
updated: 2026-08-25
---

# Open Questions

Only genuinely unresolved threads. Delete each the moment it's answered.

- **One concept, two names: `progress` vs `fraction`.** Found 2026-08-24 while
  writing [glossary.md](glossary.md). The per-user 0..1 "how far in" is `progress`
  in the wire contract ([library-book.ts](../../packages/shared/src/library-book.ts),
  `PATCH /library/:id/progress`) but `fraction` in the offline IndexedDB record
  ([offline-store.ts](../../apps/web/src/lib/offline-store.ts) — `{fraction,
  locator, updatedAt, syncedAt}`). Same quantity, two names, and the sync path
  translates between them. The glossary names `progress` canonical; the store was
  not changed, because renaming a persisted field means an IndexedDB migration
  (the DB is already at v2) for a purely cosmetic gain. **Open call:** fold the
  rename into the next offline-store migration, or record it as a deliberate
  boundary translation in `decisions.md`.

- **Library DB stores absolute file paths → dead rows after a checkout move.**
  Found 2026-07-07 (brief 08 verification): rows created under the old
  `/home/gandolh/projects/ebook-reader` checkout 500 on `GET /library/:id/file`
  and `/cover` because the DB persists absolute paths that no longer exist
  (`ENOENT` on `D:\home\gandolh\...`). The blobs themselves live fine under
  `apps/api/library/<id>.<ext>` — storing paths *relative to the storage root*
  (or deriving them from `id` + `format`) would make the library portable.
  Also: dead rows linger in the UI with no cleanup path.
  **Partly mitigated 2026-07-20:** a startup reconcile (`reconcileMissingCovers`,
  library-routes.ts) now nulls a row's `cover_path` when the thumbnail file is
  missing, so the cover half no longer 500s / emits `ERR_BLOCKED_BY_ORB` — the
  card falls back to its per-kind tile. The **`file_path` half is still open**
  (`GET /library/:id/file` returns a clean 404 but the row can't self-heal —
  `file_path` is NOT NULL); the portable-paths fix above remains the real cure.

## Library file paths are not sandboxable for testing (2026-08-25)

`LIBRARY_DATA_DIR` redirects the **database** only. `LIBRARY_FILES_DIR` and
`THUMBNAILS_DIR` resolve from the API package's own location and have no
override, so pointing the API at a *copied* database does not sandbox the
files — the copied rows still carry absolute paths into the real
`apps/api/library/` and `apps/api/images/thumbnails/`, both gitignored with no
version history.

This is a live hazard, not a theoretical one: during brief 34's verification an
agent ran the whole-book-delete route against a pre-existing row and
**permanently destroyed a real book** (the Interpretable Context Methodology
PDF). It was recovered only because an orphaned byte-identical duplicate
happened to be on disk from an earlier deletion. `apps/api/src/config.ts` now
carries a warning at the definition, and the practice is: to test a destructive
path, upload a throwaway fixture and act on that, never on a row that was
already there.

The real fix is to make both directories overridable the way `LIBRARY_DATA_DIR`
is, so a scratch DB and scratch files move together. Related: the absolute-path
problem above — deriving paths from `id` + `format` relative to a storage root
would solve both at once.

A manual backup now exists outside the repo, but nothing automates it.


Both former verification gaps closed on 2026-07-02 by the
full Playwright run + live Calibre conversion (see
[../test-plans/RESULTS.md](../test-plans/RESULTS.md)):

- ~~Backend live conversion unverified~~ — real EPUB→PDF round-trip verified
  (200, valid 28MB PDF, ~6s). Note: the API must spawn Calibre with
  `PYTHONNOUSERSITE=1` on hosts where a pip lxml shadows the distro one (it
  does now).
- ~~Readers not pixel-verified~~ — both readers rendered, exercised, and
  screenshot-audited against real files; several real defects found and fixed
  (EPUB blank-render on real-world books being the headline).
