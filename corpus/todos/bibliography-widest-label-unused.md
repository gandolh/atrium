---
title: BibliographyBlock.widestLabel is parsed and never used to size the label column
created: 2026-08-29
status: open
tags: [typeset, layout, bibliography, minor]
---

# `BibliographyBlock.widestLabel` is parsed and never used

Found during **brief 39**'s review. A pre-existing layout limitation of the
bibliography as shipped, not a regression — filed rather than fixed because
nothing about it is load-bearing yet.

`\begin{thebibliography}{99}`'s argument is the **widest label** the list will
carry, and it is what LaTeX sizes the reference list's label column from. The
engine parses it into `BibliographyBlock.widestLabel` and then nothing reads it:
`listSpacing` uses a **fixed per-depth margin** instead.

**What it costs today:** nothing visible at one or two digits, because the fixed
margin happens to be about right for `[1]`–`[99]`. A bibliography that crosses
into three-digit numbers, or any later style with wider labels, will set its
numbers into the text rather than beside it.

**The fix** is to measure `widestLabel` with the shaper and use it as the list's
label width, which is the same two-pass shape
[`layout/table.ts`](../../packages/typeset/src/layout/table.ts) already uses for
column measurement.
