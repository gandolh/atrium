# Task 43 — Readable tiles for coverless media

**Split out of [brief 42](42-video-covers.md)** by the owner (2026-08-27) so
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
