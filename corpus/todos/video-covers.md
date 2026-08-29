---
title: Real covers for video — capture a frame client-side, no ffmpeg
created: 2026-08-24
status: promoted
tags: [library, media, backend, frontend, covers]
---

> Promoted 2026-08-27 → [brief 42](../briefs/done/42-video-covers.md), **shipped
> 2026-08-28** (D40). Capture at upload *and* as a playback backfill; native
> aspect at a 640 bound. Everything iOS is unverified — no device. The
> coverless-tile half is [brief 43](../briefs/todo/43-coverless-tiles.md), still
> held.

# Real covers for video — capture a frame client-side, no ffmpeg

Video is the only kind with no real cover. Books get page-1/OPF art, audio gets
its ID3 embedded art as a square — video always falls to the typographic tile.
Owner asked (2026-08-24) whether we can display a better cover for media files.

## What's actually blocking it

Brief 23's grilled decision was **narrower than "no video covers"**: the owner
declined the **ffmpeg binary dependency**, and frame extraction was the only
route on the table at the time. Everything downstream of the frame is already
kind-agnostic:

- [extract.ts](../../apps/api/src/extract.ts) `toJpegThumbnail(image, w, h)`
  takes arbitrary geometry — the 2:3 book and 1:1 audio helpers are both
  three-line wrappers around it.
- Storage/serving is generic: `images/thumbnails/<id>.jpg` (D25),
  `GET /library/:id/cover`, the `hasCover` wire flag, the SW `cover-thumbnails`
  runtime cache ([vite.config.ts](../../apps/web/vite.config.ts)), and the
  missing-file `cover_path` reconcile in
  [library-routes.ts](../../apps/api/src/library-routes.ts).

Only the frame is missing. Two gates then keep it invisible even if it existed:

- [extract.ts](../../apps/api/src/extract.ts) gates the embedded-picture branch
  behind `format === "mp3"`, so an mp4's art is parsed and discarded.
- [CoverCard.tsx](../../apps/web/src/library/CoverCard.tsx) `CoverArt` hard-codes
  `showImage = kind !== "video" && ...`, so a stored video cover would not render.

## The proposed way in — decode where a decoder already exists

mp4/webm are the accepted formats **precisely because the browser decodes them**
(D12's "formats = what the playback path supports", extended by brief 23). So the
uploading browser is already a video decoder: object URL → `<video>` → seek →
`drawImage` to a canvas → `toBlob("image/jpeg")` → send it up. **No server binary,
so the declined-ffmpeg decision stands rather than being reopened.**

Three pieces:

1. **`POST /library/:id/cover`** — accepts an image part, re-encodes it through
   the existing sharp path (never store client bytes as-is; the re-encode is also
   what strips anything odd), writes `cover_path`. Keeping it off the upload route
   means the card appears immediately and upgrades a moment later.
2. **Capture at upload**, in [UploadZone.tsx](../../apps/web/src/library/UploadZone.tsx).
   Sample ~3 candidate timestamps (10% / 25% / 50%) and keep the highest
   luminance-variance frame — a single fixed seek lands on a black fade-in or a
   title card often enough to matter.
3. **Backfill through the player.** `VideoPlayer` is already decoding; on first
   playback, when `hasCover` is false, capture and POST. Existing library gets
   covers with no re-download and no server-side decode.

**Geometry:** store native 16:9 (640×360) and center it inside video's existing
4:3 box, exactly as audio's square art is centered inside a 2:3 box today. The
comment in `CoverCard` already states that artwork keeps its native shape inside
the box, so brief 28/29's mixed-row height math is unaffected.

**Best-effort, like every other extractor:** anything that won't decode produces
no frame and falls through to today's typographic tile.

## Free win, independent of the above

Lift the `format === "mp3"` gate around the embedded-picture branch.
`music-metadata` maps the mp4 `covr` atom to `common.picture`
(`node_modules/music-metadata/lib/mp4/MP4TagMapper.js`), so any tagged mp4 gets a
real cover server-side with no new code path. Rare for arbitrary videos, ~2 lines.
WebM attachments aren't exposed by the library — nothing to do there.

## Also worth its own consideration

Coverless videos will always exist. Their fallback tile is currently identical to
the book one; a title-hash-derived hue within the video tint would make a grid of
them readable instead of a wall of matching tiles. Separable from the frame work.

## Open questions for the promote-time grill

- **iOS Safari:** needs `muted` + `playsInline`, and sometimes a `play()`/pause
  before a frame paints to canvas. Confirm on a real device, or accept that
  iOS-originated uploads may fall back to the tile until the player backfill runs.
- **Trust boundary:** `POST /library/:id/cover` lets any authenticated user set any
  item's cover. Sharp re-encode handles the bytes; whether it needs an
  only-if-absent rule (or is fine as last-write-wins) is a call.
- **Upload cost:** decode + 3 seeks on a large mp4 costs the uploader a beat.
  Capture after the POST resolves (not before) so it never delays the card.
- **Does this warrant a decisions.md entry?** It qualifies on "surprising without
  context" — brief 23 reads as "no video covers, ever". Probably a short entry
  recording that the *dependency* was the objection, not the feature.
- **Scope:** does the fallback-tile polish ride along, or stay separate?

## Promoted

**Promoted 2026-08-27** to [brief 42](../briefs/done/42-video-covers.md) after a
grill with the owner; the tile-readability idea became
[brief 43](../briefs/todo/43-coverless-tiles.md). Of the five open questions
above, three were settled by decision (capture points, overwrite rule, tile
scope), one was answered by fact (there is no trust boundary — `books` has no
`user_id`), and one is now brief 42 acceptance (iOS Safari, verified on a real
device). See **D40**.

## Acceptance

Not specified — capture-stage.
