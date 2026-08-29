---
title: Four orphan thumbnails on disk with no matching books row
created: 2026-08-29
status: open
tags: [backend, storage, cleanup, drift]
---

# Four orphan thumbnails with no matching `books` row

Found on 2026-08-29 while counting coverless items for
[brief 43](../briefs/todo/43-coverless-tiles.md). `apps/api/images/thumbnails/`
holds **7** files; only **3** of them belong to a row in `books`. The other four
are left over from rows deleted in earlier checkouts.

Harmless — nothing reads them, and D39 made `hasCover` a disk `stat` keyed on the
row's id, so an orphan can never be served as some other book's cover. It is
wasted disk and a small piece of confusion for anyone counting covers, which is
exactly how it was found.

**Worth doing with a sweep, not a special case:** a startup or on-demand reaper
that lists the thumbnail dir, subtracts every `coverPathFor(coverOwnerId(row))`,
and deletes the remainder. Note that D39 deliberately deleted
`reconcileMissingCovers` — the *opposite* direction (a row pointing at a missing
file) is now unrepresentable. This is the direction that survives, and it needs
its own small thing rather than a revival of that one.

**Do not run it against the real library without redirecting every storage root
at a scratch base first** — see [wiki/open-questions.md](../wiki/open-questions.md).
