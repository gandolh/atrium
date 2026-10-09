---
summary: The genuinely unresolved threads only — each deleted the moment it's answered (history lives in status.md + log.md). Open now: four questions from the Jellyfin study (ffmpeg for video, a watched folder, online metadata, the upload ceiling).
updated: 2026-10-09
---

# Open Questions

Only genuinely unresolved threads. Delete each the moment it's answered.

## From the Jellyfin study (brief 79, 2026-10-09)

Each one waits for the owner. The evidence is in
[jellyfin-comparison.md](jellyfin-comparison.md).

1. **Should ffmpeg come back for video?** Jellyfin shows what it buys: any
   container or codec plays (it remuxes or transcodes), a weak connection gets a
   lower bitrate (420 kbps switched the session to a transcode), and the server
   makes thumbnails and scrub previews. The cost is the binary in the image and
   the CPU while it runs. Declined in brief 23 because the owner did not want
   the dependency, and formats were kept to what the browser plays; D40 then
   found a browser-only route to video covers. Note that an MKV holding H.264
   and AAC played directly in Chrome, so the container alone is not what
   ffmpeg would fix; codecs are.
2. **Should Atrium also take files from a watched folder, next to upload?**
   Jellyfin has only folders: libraries on disk, a scan, an optional real-time
   monitor, and no upload at all. A folder would let a large film or a whole
   music collection in without the browser. Atrium has been upload-only since
   it began, and no decision records why; the reason in practice is that items
   arrive from any device through the browser. D39 derives every stored file's
   path from its id, so a watched folder means copying files in, or revisiting
   D39.
3. **Should metadata come from online sources, or stay file-only?** Jellyfin
   matched both films on TMDb and IMDb, the album on MusicBrainz and the artist
   on AudioDB, with overviews and a biography, and it got nothing for a PDF.
   Atrium reads the file only, which gave the PDF its real title. No decision
   records file-only; online means network calls, a TMDb key, and sending titles
   to third parties. The shortlist's item 6 is the small version: a lookup the
   owner asks for, never automatic.
4. **Should the upload ceiling rise for video?** `MAX_UPLOAD_MB` is 50 (D15's
   cap), and the 64 MB *Big Buck Bunny* was refused with 413. A household's
   films and long recordings are larger. Raising it means chunked, resumable
   uploads and more disk on the VPS.

---

The Calibre question closed on 2026-10-06: local conversions with an outline
work under `PYTHONNOUSERSITE=1` (the pip `lxml` in `~/.local` was the whole
cause, and the API already spawns Calibre that way), and the owner dropped the
two unrun quality checks. Calibre's own warning about PDF input, recorded in
D34, stands in for them.

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
