# Task 47 — the bibliography must size its label column from `widestLabel`

**Promoted 2026-08-29** from the `bibliography-widest-label-unused` capture,
filed during brief 39's review. Pre-existing — a layout limitation of the
bibliography as shipped, not a regression, and deliberately not fixed then.

## Context

`\begin{thebibliography}{99}`'s argument is the **widest label** the list will
carry, and it is what LaTeX sizes the reference list's label column from. The
engine parses it —
[`doc/build.ts:1901-1938`](../../../packages/typeset/src/doc/build.ts) sets
`BibliographyBlock.widestLabel`
([`doc/model.ts:593`](../../../packages/typeset/src/doc/model.ts)) — and then
**nothing reads it**. `layoutBibliography`
([`layout/vlist.ts:1659`](../../../packages/typeset/src/layout/vlist.ts)) sets the
list through `listSpacing`
([`layout/design.ts:259`](../../../packages/typeset/src/layout/design.ts)), whose
`labelWidth` is `leftMargin - labelSep` off a **fixed per-depth table**
(`LIST_LEFT_MARGIN_EM`) — the content never enters the calculation.

**What it costs today: nothing visible.** The fixed margin happens to be about
right for `[1]`–`[99]`, which is why this shipped unnoticed. A bibliography that
crosses into three digits, or any later style with wider labels, will set its
numbers **into the text** rather than beside it.

This is the same failure shape as brief 39's `tabular` defect: legal input, no
diagnostic, wrong picture. Nothing is unimplemented, so the loud-failure
contract has nothing to report.

## Scope

**In:** measure `widestLabel` with the shaper and use it as the reference list's
label width, falling back to today's fixed geometry when it is `null`.

**Out:** `itemize` / `enumerate` / `description` label geometry — they have no
`widestLabel` to measure and their fixed margins are correct LaTeX. Do not
generalise this into `listSpacing` for every list; the bibliography is the only
block that carries a declared widest label.

**Out:** anything about how `doc/bib.ts` produces entries, citation numbering, or
the `\cite` reference pass.

## Files you OWN

- `packages/typeset/src/layout/vlist.ts` — `layoutBibliography` and, if a new
  field is cleaner than a local, the `ListSpacing` it derives
- `packages/typeset/src/layout/design.ts` — only if `listSpacing` needs an
  optional measured-width override; prefer computing it at the call site
- a test beside the existing bibliography tests

## Files you must NOT touch

- `packages/typeset/src/doc/build.ts` and `doc/model.ts` — `widestLabel` is
  already parsed correctly and typed correctly. This brief *consumes* it.
- `apps/api/**`, `apps/web/**`.

## What to do

**The two-pass shape already exists.** `layout/table.ts` measures column widths
by setting cell content as one unbroken horizontal list and calling
`measure(hlist, "h")` from `layout/glue.ts` — see `measureColumns`
([`layout/table.ts:140`](../../../packages/typeset/src/layout/table.ts)). Do the
same for one string: shape `widestLabel` wrapped in the list's own label
formatting (`[99]`, brackets included — the brackets are part of the label's
width), measure it, and use `measured + labelSep` as the list's `leftMargin`.

**Spend budget for the measurement.** `ctx.budget` is charged per cell in the
table pass for exactly this reason; one label is cheap but must not be free, or
a pathological `{...}` argument measures unbounded.

**`widestLabel` is `null`able and that arm is load-bearing** — `build.ts:1902`
sets `null` when the argument is empty. Keep today's fixed geometry for that
case rather than measuring an empty string to zero, which would jam the numbers
against the text.

## Acceptance

- A `thebibliography{999}` document sets three-digit labels **beside** the entry
  text, not into it — asserted on **coordinates**, not on the absence of
  diagnostics. Brief 39's lesson: a test that only checks a case "stays quiet"
  passes while rendering wrongly.
- A `thebibliography{9}` document is visibly tighter than a `{999}` one, and the
  difference is the measured label width.
- **All five brief-37/39 goldens stay byte-identical.** This is the load-bearing
  check — the existing goldens use one- and two-digit labels, and if the measured
  width for `[9]` disagrees with today's fixed margin the goldens will move.
  If they do move, stop and report it rather than re-baselining: a shift there
  means this changed prose that was already correct.
- `widestLabel: null` renders exactly as it does today.
- Typecheck clean; the full `packages/typeset` suite green.
