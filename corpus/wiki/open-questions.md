---
summary: The genuinely unresolved threads only — each deleted the moment it's answered (history lives in status.md + log.md).
updated: 2026-08-27
---

# Open Questions

Only genuinely unresolved threads. Delete each the moment it's answered.

## Calibre on this machine cannot convert anything with an outline (2026-08-25)

This host's Calibre has an `lxml` / `html5-parser` ABI mismatch, so
`ebook-convert` fails on any book carrying an outline. Brief 34 shipped and its
job machinery is verified, but **two quality checks are still unrun**: the
two-column PDF→EPUB readability case and the scanned-PDF quality gate, both of
which need a working local install to judge by eye.

An environment problem, not a code one — but it is the reason brief 34's
conversion quality is asserted from Calibre's own documentation rather than from
our own output. Related: the API must spawn Calibre with `PYTHONNOUSERSITE=1` on
hosts where a pip `lxml` shadows the distro one (it does now).

---

## Recently closed

**All three long-running threads were grilled with the owner on 2026-08-27 and
are now decisions, not questions** — see **D39** and **D40** in
[decisions.md](decisions.md), specified as
[brief 41](../briefs/done/41-storage-paths.md) and
[brief 42](../briefs/done/42-video-covers.md):

- ~~**One concept, two names: `progress` vs `fraction`.**~~ Closed 2026-08-27 →
  renamed in the offline store at IndexedDB v5 (D39). The corpus had this
  recorded as "the DB is already at v2"; it was in fact at **v4**, and its
  v3→v4 upgrade had already rewritten every progress record successfully — which
  is what made the rename a known shape rather than a new risk.
- ~~**Library DB stores absolute file paths → dead rows after a checkout
  move.**~~ Closed 2026-08-27 → paths are derived from `id` + `format`, and a
  cover from `converted_from ?? id` (D39). Open since 2026-07-07.
- ~~**Library file paths are not sandboxable for testing.**~~ Closed
  2026-08-27 → all three storage roots become env overrides, so a scratch
  database and scratch files finally move together (D39). This is the thread
  that **cost a real book** on 2026-08-25. Brief 41 shipped, so the roots are
  redirectable now — but the practice stands regardless, because a control only
  helps when it is used: redirect **every** root at a scratch base together, and
  to test a destructive path upload a throwaway fixture and act on that, never on
  a row that was already there.

## Incident: the API was booted against the real library (2026-08-29)

**No data was lost, and the cause is worth more than the outcome.**

Verifying briefs 40 and 43 in a browser needs the app running, so all five
storage roots were redirected at a scratch base — the control D39 created — and
written to a `env.sh` in the session scratchpad. The session was then
interrupted by a quota limit. **On resuming, the scratchpad had been wiped**, so
`. env.sh` failed, the `export`s never ran, and the dev servers started with
their *default* roots: the real database, the real files, the real thumbnails.

That boot applied briefs 34 and 41's pending migrations to the real library.
Those migrations were already designed to run on the owner's next boot and had
been tested end to end against a copy (see
[brief 41](../briefs/done/41-storage-paths.md)), and they converged exactly as
predicted: **5 books, 9 files, 7 thumbnails, 3 users, 4 profiles, 9 progress
rows and 2 notes all intact**, `converted_from` added and `file_path` dropped.
So the damage was nil and the migration was arguably due — but it was
*unintentional*, which is the whole point.

**What actually failed was the control's failure mode, not the control.**
Sourcing the redirect from a file makes it *silently* optional: if the file
vanishes, the command still succeeds and the servers still start, just pointed
somewhere else. A redirect that can quietly not apply is not much better than no
redirect, and this is the same hazard class that destroyed a book on 2026-08-25.

**The practice this replaces the old one with:** set the roots **inline in the
command that starts the server**, never sourced from a file that can disappear,
and **assert every one of them resolves inside the scratch base before anything
starts** — refusing to start otherwise. Verification is cheap; a silent default
is not.

Both original verification gaps closed on 2026-07-02 by the full Playwright run
plus a live Calibre conversion (recorded in the since-retired
`test-plans/RESULTS.md`; see [../log.md](../log.md) 2026-07-02): the backend EPUB→PDF
round-trip was verified end to end, and both readers were rendered, exercised and
screenshot-audited against real files — which is where the EPUB blank-render
defect on real-world books was found.
