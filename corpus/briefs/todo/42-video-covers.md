# Task 42 — Real covers for video, decoded in the browser

**Promoted from [todos/video-covers.md](../../todos/video-covers.md)** (captured
2026-08-24), grilled with the owner 2026-08-27. Records **D40**.

**Requires [brief 41](41-storage-paths.md)**, which changes how a cover path is
derived and makes `hasCover` a disk check. Build on top of that, not around it.

## Context

Video is the only kind with no real cover. Books get page-1 or OPF art, audio
gets its embedded ID3 art as a square — video always falls to the typographic
tile.

**Brief 23's decision was narrower than it reads.** It looks like *no video
covers, ever*; what the owner actually declined was the **ffmpeg binary
dependency**, and server-side frame extraction was the only route on the table
at the time. That distinction is why this brief does not reopen a settled
decision — it takes a different route to the same feature.

**The route: decode where a decoder already exists.** mp4 and webm are accepted
formats *precisely because the browser plays them* (D12's "formats = what the
playback path supports", extended by brief 23). So the browser is already a
video decoder: object URL → `<video>` → seek → `drawImage` to a canvas →
`toBlob("image/jpeg")` → upload. **No server binary, so the declined-ffmpeg
decision stands rather than being revisited.**

Everything downstream of the frame is already kind-agnostic: `toJpegThumbnail`
([extract.ts](../../../apps/api/src/extract.ts)) takes arbitrary geometry,
storage and serving are generic (`GET /library/:id/cover`, the `hasCover` wire
flag, the SW `cover-thumbnails` runtime cache). **Only the frame is missing** —
plus two gates that would keep it invisible even if it existed.

## Decisions taken (D40, grilled 2026-08-27)

1. **Capture in both places: at upload, and as a backfill on first playback.**
   The backfill is what covers the **existing** video library with no re-upload,
   and it is also the **iOS mitigation** — if an iPhone upload cannot paint a
   frame, the cover simply appears the first time anyone plays that video, on
   any device. An upload-only design leaves both holes permanently.

2. **Last-write-wins at the route; the client guards on `hasCover`.** The route
   is a dumb generic setter, so a future "pick a different frame" affordance
   needs no replace flag. Rejected: only-if-absent with a 409 — it would block a
   legitimate replace to defend against a client bug.

3. **The trust boundary is a non-question, and this is recorded so it is not
   re-asked.** `books` has no `user_id`
   ([db.ts:209-218](../../../apps/api/src/db.ts#L209-L218)) — the library is
   install-wide, and only `reading_progress` and `notes` are scoped (D35: the
   account is the security boundary, the profile is not). Setting a cover is
   therefore strictly **less** privileged than the delete route that is already
   unscoped. No ownership check is added because there is no ownership to check.

4. **The coverless-tile readability polish does not ride along** — it is
   [brief 43](43-coverless-tiles.md). Judge it after real covers exist, when you
   can see how many coverless videos actually survive.

## Scope

**In:**

- **`POST /library/:id/cover`** — accepts an image part, re-encodes it through
  the existing sharp path (**never store client bytes as-is**; the re-encode is
  also what strips anything odd), writes the thumbnail at the path brief 41's
  derivation expects. Last-write-wins. Rejects a non-video-sized or non-image
  payload with a clear error, and is bounded by the existing upload limit.
- **Capture at upload** in
  [UploadZone.tsx](../../../apps/web/src/library/UploadZone.tsx): sample ~3
  candidate timestamps (10% / 25% / 50%) and keep the **highest
  luminance-variance** frame — a single fixed seek lands on a black fade-in or a
  title card often enough to matter. Fire **after** the upload POST resolves, so
  the card appears immediately and upgrades a moment later; the capture must
  never delay the card.
- **Backfill on playback** in the video player: on first play, when `hasCover`
  is false, capture from the already-decoding element and POST. Guard on
  `hasCover` so it fires once, not every play.
- **Lift the two gates that hide it:**
  - [extract.ts](../../../apps/api/src/extract.ts)'s embedded-picture branch is
    gated behind `format === "mp3"`, so a tagged mp4's `covr` atom is parsed and
    thrown away. `music-metadata` already maps it to `common.picture` — this is
    a ~2-line free win, server-side, independent of everything else.
  - [CoverCard.tsx:243](../../../apps/web/src/library/CoverCard.tsx#L243)
    hard-codes `showImage = kind !== "video" && …`, so a stored video cover
    would not render. Remove the `kind` exclusion and update the doc comments
    above it that still say *video always uses the typographic fallback*.
- **Geometry:** store native 16:9 (640×360) and centre it inside video's
  existing 4:3 box, exactly as audio's square art is centred inside a 2:3 box
  today. The card comment already states artwork keeps its native shape inside
  the box, so briefs 28/29's mixed-row height maths is unaffected.
- **Best-effort, like every other extractor.** Anything that will not decode
  produces no frame and falls through to today's tile. A capture failure is
  never an upload failure.

**Out:** server-side decoding of any kind; ffmpeg (declined, and this brief
exists to avoid it); WebM attachment art (not exposed by the library);
choosing a frame by hand; the coverless-tile polish (brief 43); changing cover
geometry for books or audio.

## Files you OWN

- `apps/api/src/library-routes.ts` — the new `POST /library/:id/cover`
- `apps/api/src/extract.ts` — lifting the `mp3` gate on embedded art
- `apps/web/src/library/UploadZone.tsx` — upload-time capture
- `apps/web/src/library/CoverCard.tsx` — the `kind !== "video"` gate and its
  now-wrong comments
- `apps/web/src/player/` — the playback backfill
- `apps/web/src/lib/` — a shared capture helper (both call sites use it)

## Files you must NOT touch

- `apps/api/src/config.ts`, `apps/api/src/db.ts` schema — brief 41 owns the
  storage layer. If a cover cannot be written where you expect, that is a brief
  41 defect; **stop and say so** rather than adding a second path convention.
- `packages/typeset/**`, `apps/web/src/latex/**` — unrelated.

## What to do

1. **The `mp3` gate first.** Two lines, server-side, no client work, and it
   gives every tagged mp4 a real cover immediately. It also proves the whole
   downstream path (storage → serving → `hasCover` → card) works for a video
   before any browser capture exists.
2. **The card gate**, so a stored video cover actually renders. After steps 1–2
   a tagged mp4 has a working cover end to end.
3. **The route**, with the sharp re-encode.
4. **The shared capture helper**, then wire it at upload.
5. **The playback backfill.**

Then: extend [decisions.md](../../wiki/decisions.md) with **D40**, mark the
todo promoted, update [status.md](../../wiki/status.md) and [log.md](../../log.md).

## Acceptance

- Uploading an mp4 produces a real cover from a representative frame — not a
  black fade-in — and the card shows it.
- Playing an existing coverless video gives it a cover, which survives a reload.
- A tagged mp4 gets its embedded art server-side with no browser capture at all.
- A video that will not decode uploads fine and falls back to the tile. **No
  capture failure ever fails an upload.**
- The card appears at its normal speed; the capture does not delay it.
- Books and audio covers are visually unchanged.
- **iOS Safari:** confirm on a real device whether upload-time capture works
  (`muted` + `playsInline`, possibly a `play()`/pause before the frame paints).
  If it does not, that is an accepted outcome — say so in the outcome block, and
  the backfill covers it on first play.
- `npm run typecheck`, `npm run build` and `npm test` clean.
