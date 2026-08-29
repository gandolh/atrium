# Task 43 — Readable tiles for coverless media

**Split out of [brief 42](../done/42-video-covers.md)** by the owner (2026-08-27) so
that brief stays about one thing. **Build after 42**, and only once you can see
how many coverless videos actually survive it — this brief may turn out not to
be worth doing, which is the point of deferring it.

## Context

Even with brief 42's frame capture, coverless media will always exist: a video
that will not decode, one never yet played, a book whose extraction failed.

Today every one of them is the same flat tile. `TINT_CLASS`
([CoverCard.tsx:30-32](../../../apps/web/src/library/CoverCard.tsx#L30-L32))
maps each kind to exactly one tint — `bg-tint-book`, `bg-tint-music`,
`bg-tint-video` — so a grid of coverless videos is a wall of identical
rectangles distinguishable only by their titles.

This matters because of a design rule the project deliberately locked. D33
made **tint carry kind**, replacing format badges, and design.md states the
"tint test": *strip every badge and the grid still reads*. A wall of matching
tiles passes that test for **kind** and fails it for **item** — you can tell
they are videos; you cannot tell them apart.

## The tension to resolve, not assume

The obvious fix is a title-hash-derived hue. **But the tint currently carries
kind**, and varying it per title dilutes exactly the signal D33 chose it for.
So the brief is not "add a hash hue" — it is *make coverless tiles
distinguishable without weakening the kind signal*, and the first job is to
decide whether hue is even the right axis.

Alternatives worth costing before building: varying **lightness or texture**
within a fixed kind hue; a large typographic initial; a generated geometric
mark keyed to the title. Any of them can be bounded tightly enough to stay
recognisably "the video tint" — the constraint is what makes this a design
decision rather than a one-liner.

## Scope

**In:** distinguishability for coverless tiles across all kinds, within the
existing tint system; the chosen variation bounded so kind still reads at a
glance; light and dark themes both checked (D33's warm dark `#141310` exists so
art does not read sour — a generated fill must not either).

**Out:** anything that touches a tile which *has* real art; new tint tokens for
new kinds; changing the card shapes (2:3 / square / 16:9, D32); reopening D33.

## Files you OWN

- `apps/web/src/library/CoverCard.tsx`
- `apps/web/src/styles/` or wherever the tint tokens live — **additively only**
- [design.md](../../wiki/design.md) — the "Kind tints" section, which must be
  updated to describe whatever this brief lands

## Files you must NOT touch

- `apps/api/**` — this is presentation only, with no server change.
- The `--reader-*` theme architecture (D32/D33's no-churn principle).

## What to do

1. **Look at the real library first.** Count the coverless items after brief 42.
   If there are three, close this brief as not worth doing and say so — that is
   a legitimate outcome and better than a change nobody needed.
2. **Cost the axes** above against the tint test before writing code.
3. Implement the chosen one, bounded.
4. Check both themes and a full grid, not a single card.
5. Update [design.md](../../wiki/design.md) and [log.md](../../log.md).

## Acceptance

- A grid of coverless items of the same kind is readable at a glance without
  reading titles.
- Kind still reads from the tint alone — verify the D33 tint test explicitly,
  with badges stripped.
- Light and dark both checked on a real grid.
- Items with real art are pixel-unchanged.
- design.md describes the rule that now applies.
- `npm run typecheck`, `npm run build` and `npm test` clean.

---

## Settled calls (2026-08-29) — read these before building

Grilled with the owner. **These override the body above wherever they disagree.**
Recorded as **D42**.

### 1. Step 1 was run, and the owner overrode its answer

This brief says: *"Count the coverless items after brief 42. If there are three,
close this brief as not worth doing."* Counted, from the real database
(read-only copy) against `apps/api/images/thumbnails/`:

| | count |
|---|---|
| total library rows | **5** |
| **coverless videos** | **0** — the one video has a cover |
| coverless items (both `audio`) | **2** |
| orphan thumbnails (no matching row) | 4 |

That is below this brief's own close-it threshold, and **zero** of them are the
kind it was split out of brief 42 to serve. The recommendation was to close it.

**The owner chose to build it anyway**, for the library they expect rather than
the one they have. So the design target is **a large collection, not five
items** — an axis that only works at today's size is a wrong answer here.

### 2. The axis: title initial **and** bounded lightness, never hue (D42)

- A **large title initial**, set in Newsreader, low-contrast over the tile.
- Ground **lightness quantised to a few steps** from a title hash.
- **Both stay inside the kind's own hue.** The hue never moves.

D33's tint test therefore passes by construction: strip every badge and kind
still reads, because kind is still carried by a hue nothing varies.

**Two axes rather than one, deliberately** — at the scale the owner is building
for, an initial alone repeats often across a big collection, and lightness alone
collapses because adjacent steps are hard to separate in a dense grid. Together
they stay separable where either alone would not.

**Rejected:** a title-hash *hue* (breaks D33 — the whole tension this brief
exists to resolve); lightness alone; a generated geometric mark (most
distinctive, most code, most ways to look cheap across two themes).

### 3. Verification, given there is almost nothing coverless to look at

Two coverless rows is not a grid. **Seed fixtures rather than testing against
live data** — and per D39 redirect **every** storage root at a scratch base
together, which is the capability brief 41 built. Never act on a library row
that was already there: that is the mistake that destroyed a real book on
2026-08-25.

Check a **full grid** of same-kind coverless tiles in **both themes**, and run
D33's tint test explicitly with badges stripped. Items that have real art must
be **pixel-unchanged** — that acceptance criterion is the one most likely to be
broken by accident here.

### 4. Out of scope, filed separately

The 4 **orphan thumbnails** (image files with no matching `books` row) are real
drift found while counting. Not this brief's problem — see
[todos/orphan-thumbnails.md](../../todos/orphan-thumbnails.md).
