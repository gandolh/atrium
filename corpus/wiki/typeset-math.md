---
summary: How Atrium's engine sets mathematics — MathJax v4 SVG, the SVG-to-PDF emitter, the subset gate, and the three MathJax behaviours that had to be switched off (one of them a purity hole).
updated: 2026-08-29
---

# Mathematics in the typesetting engine

Brief 40, decision **D41**. Read [typeset.md](typeset.md) first — the scope
line, the loud-failure contract and the no-I/O purity all apply unchanged here
and are not restated.

TeX in, **MathJax v4 SVG** out, then our own SVG→PDF emitter (`pdf/svg.ts`)
writes path operators straight into the content stream — no `XObject`, nothing
to register. `fontCache: "none"` inlines every glyph, so there is no
`<use>`/`<defs>` to resolve; a `<use>` appearing anyway is a loud guard rather
than a silently missing glyph.

**The renderer is injected, exactly as fonts are.** `createMathRenderer()` is
async and `compile()` is sync, so construction happens outside. A document with
math and no renderer is an **error**, never a quiet omission.

**Three MathJax packages are switched off, and the first is a security
property rather than a preference.** `require` and `autoload` let the
**document** cause MathJax to load a component off disk (`\require{physics}`, or
even a plain `\color{red}{x}` via autoload) — the same class of hole as
`\write18`, arriving through a dependency, and it would falsify the no-I/O claim
above. `noundefined` makes an undefined macro silent red text instead of a
catchable error. And `linebreaks.inline` is off: v4 breaks inline math itself
into several `<svg>`s, which is out of scope and breaks the overrun check.

**Fonts are warmed at construction** — v4 splits New Computer Modern into ~40
lazily-loaded ranges and a cold `\mathbb{R}` *throws*. A test sweeps the symbol
corpus so a missed range is a red test, not a retry inside a compile.

**The subset is gated on the MathML, never on the TeX source** — macros expand,
so the source does not say what was used. Proof: a `\newcommand` hiding
`\begin{cases}` is still refused, naming `cases`. The gate is literal about
brief 40's In list, so `\displaystyle`, `\boldsymbol` and friends are refused
despite rendering — D41's accepted cost, each a one-line widening.

**Known gap:** per-line numbering in a multi-line display. `\begin{align}` goes
to MathJax as one run, so per-line baselines live inside a single SVG. Reported
at the display's own line rather than dropped.
