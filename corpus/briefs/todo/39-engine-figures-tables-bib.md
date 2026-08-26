# Task 39 — Typesetting engine: figures, tables, bibliography

**Third of four.** [37](37-engine-foundation.md) → [38](38-latex-editor.md) →
**39** → [40](40-engine-math.md).

**Requires brief 37.** Read its "What this is, and what it is deliberately not",
"The failure contract" and "Where it runs" sections first — the scope line
(syntax, not semantics), the loud-failure contract and the no-I/O purity all
apply unchanged here and are not restated.

**Requires brief 38 only in practice, not in code.** By the time this is built
the editor exists, so every fixture can also be checked by eye in the real
preview. This brief still touches **no** `apps/` code.

## Context

Brief 37 leaves the engine able to set a written report: prose, sections, lists,
footnotes, cross-references, user macros. What it cannot do is place anything
that **floats** or anything laid out in a **grid** — which is most of what turns
a report into a paper.

This brief adds the three that travel together, because they share machinery:
floats need a page builder that can defer content, tables need a two-pass column
measurement, and citations need the same second pass `\ref` already uses.

**Ordering note.** This is filed before [brief 40](40-engine-math.md) (math) on
the judgement that the owner's stated use — *"sync what's on your phone with
what's on pc… a personal cloud space"* — implies documents with figures and
tables more often than heavy mathematics. **If most of what you write is math,
swap 39 and 40**; they are independent and neither depends on the other.

## Scope

**In:**

- **Floats**: `figure` and `table` environments with `[htbp]` placement,
  `\caption` (numbered, per-class counters), `\label`/`\ref` into the existing
  reference pass, and `\listoffigures` / `\listoftables`.
- **Float placement**: here / top / bottom / own page, in that preference order,
  with a deferral queue so a float that does not fit moves to the next page
  rather than overflowing. **Floats that can never be placed must be a
  diagnostic**, not silently dropped at end of document — this is exactly the
  kind of quiet loss the failure contract exists to prevent.
- **`\includegraphics`**: **PNG and JPEG only**, with `width=`, `height=`,
  `scale=` and `\textwidth`-relative widths. Images come from the in-memory file
  map like every other input. An unsupported format (PDF, EPS, SVG) is a clear
  diagnostic naming the format.
- **Tables**: `tabular` with `l c r` and `p{width}` columns, `|` rules,
  `\hline`, `\cline`, `\multicolumn`, and `&` / `\\` cell structure. Column
  widths measured from content in a first pass, then set.
- **Bibliography**: a `.bib` parser (entry types `article`, `book`,
  `inproceedings`, `misc`, plus `@string` and cross-references), `\cite` /
  `\citep`-style keys, `\bibliography` / `\bibliographystyle`, and **one
  built-in style** — numeric, author-year deferred. An unknown key is a
  diagnostic *and* renders as `[?]` so the problem is visible in the PDF too.

**Out** (diagnostics, as always): `longtable`, `tabularx`, `booktabs`,
`multirow`, `subfigure`/`subcaption`, wrapped text around floats, `\rotatebox`,
EPS/PDF/SVG graphics, BibLaTeX/`biber` syntax, author-year and custom `.bst`
styles, and everything brief 37 listed as permanently out.

## Files you OWN

- `packages/typeset/src/layout/float.ts` — the deferral queue and placement
- `packages/typeset/src/layout/table.ts` — column measurement and grid setting
- `packages/typeset/src/doc/bib.ts` — `.bib` parsing and the numeric style
- `packages/typeset/src/image/` — **new**: PNG/JPEG decode to intrinsic size
  and PDF `XObject` embedding via `pdfkit`
- `packages/typeset/src/macro/` — the new command and environment entries
- `packages/typeset/src/layout/page.ts` — extended to accept deferred floats
- `packages/typeset/test/` — fixtures and goldens for everything above

## Files you must NOT touch

- `apps/api/**`, `apps/web/**` — **no UI, no routes.** Brief 38 already displays
  whatever diagnostics this produces; it needs no change to show new ones.
- `packages/typeset/src/math/` — brief 40.
- `packages/shared/src/latex.ts` — the `Diagnostic` shape is fixed. If a new
  diagnostic needs a field the type lacks, stop and say so rather than widening
  a contract two apps already consume.

## What to do

1. **Images first**, because they are the only new *input* kind and everything
   else can be tested without them. Decode PNG and JPEG to intrinsic dimensions,
   embed as a PDF XObject, honour the sizing keys. A corrupt or truncated image
   is a diagnostic naming the file, never a crash.

2. **Tables next**, because they are self-contained — a `tabular` is a box like
   any other once its columns are measured, and it needs nothing from the page
   builder. Measure in one pass, set in a second. `p{}` columns line-break
   internally using the M1 breaker, which is the reuse that makes this tractable.

3. **The float queue last**, because it is the only change to the **page
   builder** and therefore the only one that can regress brief 37's output. Add
   deferral, then placement preference, then the "never placeable" diagnostic.
   **Re-run every brief 37 golden after this step** — a page builder change that
   silently reflows plain prose is the failure mode to watch for.

4. **Bibliography** is independent of all three and can be built at any point:
   parse `.bib`, resolve `\cite` keys in the existing second pass, emit a
   numbered reference list.

5. **Corpus**: extend `wiki/typeset.md`'s scope table; update
   [status.md](../../wiki/status.md) and [log.md](../../log.md).

## Acceptance

- A paper-shaped document — figures with captions and references, a couple of
  tables, a bibliography with numbered citations — compiles and is **visually
  correct**, checked by eye in brief 38's preview.
- **Every brief 37 golden still passes byte-for-byte on its layout dump.** The
  page builder changed; prove that plain prose did not.
- A float that cannot be placed produces a diagnostic. Nothing is dropped
  silently.
- An unknown citation key produces a diagnostic **and** a visible `[?]`.
- An unsupported image format, and a corrupt image, each produce a clear
  diagnostic naming the file — no crash.
- Every "Out" item above has a fixture proving it produces a diagnostic.
- Golden tests cover every "In" item; `npm test` green; typecheck + build clean.
- The engine still performs no file, network or process access.
- **No UI.** `apps/web` and `apps/api` are unchanged by this brief.
