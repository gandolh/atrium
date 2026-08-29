# Task 40 — Typesetting engine: math

**Fourth of four.** [37](../done/37-engine-foundation.md) → [38](../done/38-latex-editor.md) →
[39](../done/39-engine-figures-tables-bib.md) → **40**.

**Requires brief 37.** Its scope line (syntax, not semantics), failure contract
and no-I/O purity apply unchanged and are not restated. Independent of
[brief 39](../done/39-engine-figures-tables-bib.md) — **if most of what you write is
mathematics, build this one first.**

## Context

Math is filed last because it is the hardest part of the engine and the most
separable: it touches one new subsystem and adds no new page-level behaviour.
Everything before it produces a usable engine without it.

It is also the part where **writing it ourselves is least justified**. TeX's
math layout is the piece of Knuth's work with the least available substitute and
the most subtle rules — atom classes, four cramped/uncramped styles, italic
correction, and spacing that comes out of the font's own `fontdimen` parameters
rather than the algorithm. Getting it slightly wrong produces output that looks
almost right, which is the worst outcome for a *published* document.

## The approach: MathJax SVG, our own SVG → PDF emitter

Render each math run with **`mathjax-full`** (3.2.2, Apache-2.0) using its
**SVG output**, then convert that SVG to PDF operators ourselves.

**Why this and not our own mlist layout.** MathJax's SVG output is
self-contained vector: explicit glyph outlines as `<path>`, exact advance widths,
and a baseline offset — no font files to resolve, no metrics to reimplement. Its
TeX fonts are Computer Modern-derived, so math sits visually consistent with the
Latin Modern text from brief 37. Writing TeX's own mlist algorithm is the pure
alternative and is **deliberately deferred**: it is months of subtle work for
output a reader cannot distinguish, and it can replace this layer later behind
the same interface without touching anything else.

**Why our own emitter and not an off-the-shelf SVG converter.** `svg-to-pdfkit`
is the obvious candidate and it is MIT, but it was last published in **2022**,
and — decisively — it targets `pdfkit`, which brief 37 ruled out: pdfkit reads
its bundled standard-font data from disk during document construction, which
`src/` cannot do. What we actually need is narrow: `<path>` data, transforms,
and `<use>` resolution against `<defs>`. That is a few hundred lines against
**`pdf-lib`**'s content-stream operators, fully under our own tests, and it sits
beside the glyph emitter brief 37 already wrote for exactly that reason. A
general SVG converter is a much larger surface than the job requires.

*(Corrected 2026-08-26: this brief was written naming `pdfkit` before brief 37's
measurement disqualified it.)*

**The cost to accept:** `mathjax-full` is a large dependency. It runs
**server-side only** (brief 38 compiles in Node), so it costs no browser
payload. If the engine is ever moved into the browser, math is the one part that
needs re-examining — record that in `wiki/typeset.md` so the future reader is not
surprised.

## Scope

**In:**

- **Inline math** `$…$` and `\(…\)`, sitting correctly on the **text baseline** —
  this is the detail that betrays a bad implementation, and it must be right.
- **Display math** `\[…\]`, `equation`, `equation*`, `displaymath` — centred,
  with correct above/below spacing and equation numbering into the existing
  counter and `\label`/`\ref` machinery.
- **Aligned environments**: `align`, `align*`, `gather`, `split`, with `&`
  alignment points and per-line numbering.
- **Structures**: fractions (`\frac`, `\dfrac`, `\tfrac`), radicals, sub- and
  superscripts, sums/products/integrals with limits in both inline and display
  style, `\binom`, over/underbraces, accents.
- **Delimiters that grow**: `\left` / `\right`, `\big` and friends.
- **Matrices**: `matrix`, `pmatrix`, `bmatrix`, `vmatrix`, `array` with column
  specs and alignment.
- **Symbols**: Greek, relations, operators, arrows, `\mathbb` / `\mathcal` /
  `\mathrm` / `\mathbf` / `\mathit`, `\text` inside math.
- **The `amsmath` subset** these imply, and nothing beyond it — the allowlist
  entry brief 37 reserved becomes real here.

**Out** (diagnostics, as always): `\newtheorem` and theorem environments,
`cases` beyond what `array` gives, commutative diagrams, `mathtools` /
`physics` / `siunitx`, `\DeclareMathOperator`, custom math alphabets, TikZ in
math, and everything brief 37 listed as permanently out.

**Line breaking inside math is explicitly out.** TeX barely does it either; a
display equation that overruns the text width produces a **diagnostic**, so the
author can break it themselves, rather than silently running into the margin.

## Files you OWN

- `packages/typeset/src/math/` — **new**: the MathJax bridge, math-run
  extraction, style (inline vs display) selection, baseline placement
- `packages/typeset/src/pdf/svg.ts` — **new**: the SVG-path → PDF operator
  emitter (paths, transforms, `<use>`/`<defs>` resolution)
- `packages/typeset/src/macro/` — math command and environment entries
- `packages/typeset/src/doc/` — equation counters and `\label`/`\ref` for
  numbered equations
- `packages/typeset/test/` — fixtures and goldens
- `packages/typeset/package.json` — the `mathjax-full` dependency

## Files you must NOT touch

- `apps/api/**`, `apps/web/**` — **no UI, no routes.** Brief 38 already displays
  whatever diagnostics this produces.
- `packages/typeset/src/layout/page.ts` — a math run is a **box** to the page
  builder, exactly like a word or a table. If the page builder seems to need
  changing, stop and say so: that would mean the box interface is wrong, which
  is a design problem rather than a math problem.
- `packages/shared/src/latex.ts` — the `Diagnostic` shape is fixed.

## What to do

1. **The SVG emitter first, in isolation.** Before any math, get `<path>` data,
   transforms and `<use>` resolution rendering correctly into a PDF, with its own
   fixtures. It is the piece most likely to be quietly wrong and the easiest to
   test on its own.

2. **Inline math next, and stare at the baseline.** Extract the math run, render
   it, place it. Inline math that sits a point or two off the baseline looks
   *subtly* wrong across a whole paragraph, which is harder to notice and worse
   than an obvious break. Compare against a real LaTeX-produced PDF by eye.

3. **Display math and numbering**, hooking equation counters into the existing
   `\label`/`\ref` second pass — no new reference mechanism.

4. **Aligned environments**, then matrices and growing delimiters, then the
   symbol coverage sweep. Each with fixtures.

5. **The overrun diagnostic**: measure the rendered display width against the
   text width and report when it exceeds it.

6. **Corpus**: extend `wiki/typeset.md` with the math pipeline, the MathJax
   decision and **the browser caveat** above; update
   [status.md](../../wiki/status.md) and [log.md](../../log.md).

## Acceptance

- A mathematics-carrying document — inline math in running prose, numbered
  display equations, an `align` block, a matrix, growing delimiters — compiles
  and is **visually correct**, compared **side by side against a PDF produced by
  real LaTeX**. This is the one brief where eyeballing our own output is not
  enough.
- Inline math sits on the text baseline. Verified on a full page of prose, not a
  single line.
- Equation numbering is continuous and `\ref` to an equation resolves correctly.
- A display equation wider than the text width produces a diagnostic rather than
  running into the margin.
- **Every brief 37 and 39 golden still passes.**
- Every "Out" item has a fixture proving it produces a diagnostic.
- Golden tests cover every "In" item; `npm test` green; typecheck + build clean.
- The engine still performs no file, network or process access — `mathjax-full`
  runs with no filesystem or font-loading side effects, and that is asserted, not
  assumed.
- **No UI.** `apps/web` and `apps/api` are unchanged by this brief.

---

## Corrections and settled calls (2026-08-29) — read these before building

Grilled with the owner and probed against the real package. **These override the
body above wherever they disagree.** Recorded as **D41**.

### 1. The dependency is `mathjax@4.1.3`, not `mathjax-full@3.2.2`

`mathjax-full` never left beta on its 4.x line, so 3.2.2 is a frozen branch.
`mathjax` 4.x is the maintained distribution and exposes the same TeX → SVG
conversion in Node. **Already installed** (`packages/typeset/package.json`).

```js
const { init } = await import("mathjax");
const MathJax = await init({
  loader: { load: ["input/tex", "output/svg"] },
  svg: { fontCache: "none" },
  tex: { packages: { "[-]": ["noundefined"] }, formatError: (jax, err) => { /* capture */ } },
});
const node = MathJax.tex2svg("x^2", { display: false });
const svg = MathJax.startup.adaptor.outerHTML(node);
```

**Pin it exactly** (`"mathjax": "4.1.3"`, no caret) — this repo pins
`perfect-freehand` and `music-metadata` the same way. npm installed it with a
caret; fix that.

**Footprint, measured:** ~70 MB on disk (`mathjax` 20 MB +
`@mathjax/mathjax-newcm-font` 50 MB), not the 34.3 MB this brief costed. Only
**~1 MB actually loads** (`@mathjax/mathjax-newcm-font/svg.js`); the rest is
duplicate `mjs`/`cjs` builds and CHTML output this engine never touches. Still
server-side only, so the browser payload stays zero. The owner accepted this.

### 2. The SVG emitter is smaller than this brief says

`fontCache: "none"` **inlines `<path>` data** — verified: no `<use>`, no
`<defs>` in the output. So `src/pdf/svg.ts` needs paths and transforms and
**not** `<use>`/`<defs>` resolution. Keep a guard that fails loudly if a `<use>`
ever appears rather than silently dropping it.

The container carries what placement needs: `style="vertical-align: -1.577ex"`
for the baseline, `width`/`height` in `ex`, and a `viewBox` in font units.

### 3. The font is New Computer Modern, and that is an improvement

v4 defaults to `mathjax-newcm`, not v3's MathJax-TeX. The engine's text face is
**Latin Modern**; both are Computer Modern derivatives, so math and text sit
together *better* than this brief assumed. No action — just do not "fix" it.

### 4. Undefined macros are SILENT by default — this is the contract risk

MathJax's default package set includes `noundefined`, which renders an undefined
control sequence as **red text with no error at all**. Left alone, that puts a
silent wrong answer inside D38's loud-failure contract.

**Drop it** (`packages: { "[-]": ["noundefined"] }`) and undefined macros become
real errors catchable through `tex.formatError`, which yields
`"Undefined control sequence \\unknowncmd"`. Verified both ways. `formatError`
also catches syntax errors (`\frac{1}` → `"Missing argument for \\frac"`); it
does **not** catch out-of-subset-but-valid constructs — that is §5's job.

### 5. Math IS gated to this brief's In list (owner's call, D41)

MathJax renders several things this brief lists as **Out** — `\begin{cases}` and
`\DeclareMathOperator` both render clean. The owner chose to **gate anyway**:
anything outside the In list is a diagnostic, even when MathJax could draw it.

The recommendation was the opposite (accept MathJax's surface, treat Out as
"not promised"), and the owner overrode it deliberately: a subset engine whose
subset is not precisely knowable cannot honour D38's promise that an
unimplemented construct *says so*. **Cost accepted: a maintained allowlist, and
refusing constructs that demonstrably work.**

Gate on the **MathML** (`MathJax.tex2mml`), not by regexing the TeX source —
macros expand, so the source does not tell you what was actually used.

### 6. Acceptance criterion 1 is replaced

The brief asks for side-by-side comparison against a PDF from real LaTeX.
**There is no TeX on this machine and D38's whole point is that Atrium depends on
none**, so that criterion is unmeetable as written.

**It is replaced by:** render a mathematics-carrying document, open it in brief
38's preview, and **eyeball it in the virtual browser (agent-browser). If it
looks good, it passes.** The owner set this bar explicitly. Everything else in
Acceptance stands unchanged — especially *"every brief 37 and 39 golden still
passes"*, which is not negotiable.
