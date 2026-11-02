---
summary: The typesetting engine's declared scope — what it promises to set (the foundation, figures/tables/bibliography, and mathematics) and what it refuses with a diagnostic, including the permanent Out list and the math gate (D41). Code comments that say "the declared scope" or "the Out list" mean this page.
updated: 2026-11-02
---

# The engine's declared scope

The engine ([typeset.md](typeset.md)) is a subset of LaTeX, and its failure
contract (D38) is that anything outside the subset *says so*: every construct
below that is Out is a diagnostic, never silence. The subset was declared in
three parts, built 2026-08-26 to 2026-08-29: the foundation, then figures,
tables and bibliography, then mathematics ([typeset-math.md](typeset-math.md)).

## The foundation

**In:**
- **Preamble**: `\documentclass{article}` only. `\usepackage` against an
  allowlist that starts with `geometry` (margins only); `amsmath` joined with
  the math. `\title` `\author` `\date` `\maketitle`, `abstract`.
- **Text**: paragraphs, `\emph` `\textbf` `\textit` `\texttt` `\underline`,
  `\footnote`, quotes, en and em dashes, ties (`~`), `\\`, `\newpage`, escaped
  specials (`\%` `\&` `\_` `\#` `\$`).
- **Structure**: `\section` `\subsection` `\subsubsection` `\paragraph` with
  numbering and `*` variants, `\tableofcontents`.
- **Lists**: `itemize` `enumerate` `description`, nested.
- **Cross-references**: `\label` `\ref` `\pageref`, through a second pass.
- **Verbatim**: the `verbatim` environment and `\verb`.
- **User macros**: `\newcommand` / `\renewcommand` with N arguments and one
  optional argument. This is the 90% of macro use that is not programming, and
  it is the boundary.

**Out, permanently:** arbitrary `.sty`/`.cls`, TeX programming (`\def`,
`\catcode`, `\expandafter`, `\csname`, registers), TikZ/pgf, `\marginpar`,
multi-column, a custom `\output`, `book`/`report`/`beamer`, index and glossary
packages, SyncTeX.

## Figures, tables and the bibliography

**In:**
- **Floats**: `figure` and `table` with `[htbp]` placement, `\caption`
  (numbered, per-class counters), `\label`/`\ref` into the reference pass,
  `\listoffigures` / `\listoftables`. Placement prefers here, top, bottom, own
  page, with a deferral queue; a float that can never be placed is a
  diagnostic, not dropped at the end.
- **`\includegraphics`**: PNG and JPEG only, with `width=`, `height=`, `scale=`
  and `\textwidth`-relative widths, from the in-memory file map. Any other
  format is a diagnostic naming it.
- **Tables**: `tabular` with `l c r` and `p{width}` columns, `|` rules,
  `\hline`, `\cline`, `\multicolumn`, and `&` / `\\` cells; column widths
  measured in a first pass, then set.
- **Bibliography**: a `.bib` parser (`article`, `book`, `inproceedings`, `misc`,
  `@string`, cross-references), `\cite` / `\citep`-style keys, `\bibliography` /
  `\bibliographystyle`, and one built-in numeric style. An unknown key is a
  diagnostic and prints `[?]`.

**Out:** `longtable`, `tabularx`, `booktabs`, `multirow`, `subfigure` /
`subcaption`, text wrapped round floats, `\rotatebox`, EPS/PDF/SVG graphics,
BibLaTeX/`biber` syntax, author-year and custom `.bst` styles. These report
`unsupported` (real LaTeX we declined), not `undefined-command`.

## Mathematics

**In:**
- **Inline math** `$…$` and `\(…\)`, on the text baseline.
- **Display math** `\[…\]`, `equation`, `equation*`, `displaymath`: centred,
  spaced, numbered into the existing counter and `\label`/`\ref`.
- **Aligned environments**: `align`, `align*`, `gather`, `split`, with `&`
  alignment points and per-line numbering.
- **Structures**: fractions (`\frac`, `\dfrac`, `\tfrac`), radicals, sub- and
  superscripts, sums, products and integrals with limits in both styles,
  `\binom`, over- and underbraces, accents.
- **Delimiters that grow**: `\left` / `\right`, `\big` and friends.
- **Matrices**: `matrix`, `pmatrix`, `bmatrix`, `vmatrix`, `array` with column
  specs.
- **Symbols**: Greek, relations, operators, arrows, `\mathbb` / `\mathcal` /
  `\mathrm` / `\mathbf` / `\mathit`, `\text` inside math.
- The `amsmath` subset these imply, and nothing beyond it.

**Out:** `\newtheorem` and theorem environments, `cases` beyond what `array`
gives, commutative diagrams, `mathtools` / `physics` / `siunitx`,
`\DeclareMathOperator`, custom math alphabets, TikZ in math. Line breaking
inside math is out too: a display equation wider than the text is a diagnostic,
so the author breaks it.

**The gate (D41, the owner's call).** MathJax can draw some Out items
(`cases`, `\DeclareMathOperator`), and they are refused anyway: a subset whose
edge is not precisely knowable cannot keep the promise that an unimplemented
construct says so. The cost accepted is a maintained allowlist
(`packages/typeset/src/macro/builtins.ts`) and refusing things that work. The
gate reads MathJax's MathML (`tex2mml`), not the TeX source, because macros
expand.
