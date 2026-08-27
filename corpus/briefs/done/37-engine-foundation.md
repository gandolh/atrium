# Task 37 — Typesetting engine: foundation

**First of four.** 37 (foundation) → [38](38-latex-editor.md) (editor) →
[39](../todo/39-engine-figures-tables-bib.md) (figures, tables, bibliography) →
[40](../todo/40-engine-math.md) (math). This brief carries the design rationale the
other three refer back to.

## Context

Owner request (2026-08-26): *"Add a brief to make our own wasm library for
parsing Tex and generating pdf's from it. Let's drop the tectonic or other
external library idea at all."* Then, on language: *"i would like to not
introduce another programming language like rust, maybe you can still use
javascript? … Or if it's neccesary, we could use c."*

This replaces the engine half of superseded brief 36 (Tectonic). **D37's engine
clause is revised by D38**; D37's draft/published/versions design survives
untouched and is respecified in brief 38.

### What this is, and what it is deliberately not

It is **our own engine, reading a defined subset of LaTeX**. It is **not a TeX
reimplementation**, and that difference is the only reason this is feasible.

LaTeX is not a file format — it is a program. `\catcode` lets a document
redefine what characters *mean* mid-parse, so there is no parser to write; you
write a macro-expansion machine and then execute the LaTeX kernel on it.
Measured 2026-08-26: Knuth's `tex.web` is **25,010 lines** of literate Pascal,
and the LaTeX kernel in `latex3/latex2e/base` is **79 `.dtx` files, 4.81 MB** of
source — before `article.cls`, `amsmath`, or `graphicx`. Nobody has finished a
from-scratch TeX; the Typst team looked hard and **designed a new language
instead**, which is the most useful data point on the subject.

So the scope line is drawn at **syntax, not semantics**: we accept LaTeX-shaped
documents and implement the commands ourselves in TypeScript. Same shape as
[LaTeX.js](https://github.com/michael-brade/LaTeX.js) (875★, MIT, maintained),
which parses a documented LaTeX subset and implements macros in JS rather than
in TeX. It outputs HTML; we output PDF.

**This is defensible here specifically** because brief 38 decision 4 (inherited
from the grill) says *"a new project starts from a small hello-world. No zip
import — the owner has nothing to bring in."* There is no legacy corpus to
render. The engine must handle what the owner writes, not what CTAN can produce.
**If a legacy `.tex` corpus ever appears, D38 is the first thing to revisit.**

### The failure contract — the spine of all four briefs

A subset engine is only trustworthy if it is **loud**. An unimplemented command
must produce a diagnostic with file and line saying *this engine does not
implement `\foo`* — never a silent skip, never a best-effort guess, never a
wrong render.

This is a correctness requirement, not a nicety. A silently-dropped `\thanks` is
a missing footnote in a *published* document; a silently-ignored `\hspace` is a
table that looks fine and is wrong. **Fail loudly, always.**

## Language: TypeScript. Not Rust, not C, and no WASM.

WASM was only ever on the table because the existing engines are C — SwiftLaTeX
and BusyTeX are Emscripten ports of pdfTeX/XeTeX, and you need WASM to run
*someone else's C*. Writing it ourselves, a TypeScript library runs natively in
Node **and** the browser with no build toolchain, no `.wasm` artifact, and no
glue layer. C was offered and declined: it would mean writing font parsing, PDF
emission and math layout from nothing, because the C ecosystem's answer to all
three *is TeX*. Rust would have bought only speed, at the cost of a second
language.

**What we borrow** (verified 2026-08-26, all MIT/Apache/BSD, monthly npm
downloads) — glyphs and PDF bytes, never the engine:

| Package | Version | Downloads | What it gives us |
|---|---|---|---|
| `@unified-latex/*` | 1.8.4 | 276k | LaTeX source → AST, maintained (pushed 2026-08-18) |
| `fontkit` | 2.0.4 | 47.4M | font parsing, glyph metrics, kerning, ligatures, subsetting |
| `pdfkit` | 0.20.1 | 24.1M | PDF emission with font embedding (updated 2026-08-23) |
| `hypher` | 0.2.5 | 101k | Liang hyphenation — the Rust `hypher` is a port of *this* |
| `tex-linebreak` | 0.9.0 | 5k | Knuth–Plass in JS. Low adoption: **reference, not dependency** |

**What we write**: the parser bindings, the macro layer, the document model,
box-and-glue layout, line and page breaking, and the diagnostics.

### Where it runs: nowhere in particular, and that is the security design

The engine is a **pure function with no I/O**:

```
compile(files: Record<string, Uint8Array>, entrypoint: string, opts)
  -> { pdf: Uint8Array | null, diagnostics: Diagnostic[], stats }
```

No filesystem, no network, no child processes, no `eval`. It takes an in-memory
file map and returns bytes.

**This deletes brief 36's sandboxing spec rather than implementing it.**
`\write18` cannot execute because we never write a shell escape.
`\input{/etc/passwd}` cannot read anything because there is no filesystem to
reach — `\input` resolves against the in-memory map or it is a diagnostic. Path
confinement, symlink escape and `..` traversal stop being engine concerns; they
survive only where brief 38 accepts *uploads*, as ordinary route validation.

Two limits stay real, because a document can be hostile by accident:

- **A step/iteration budget, not a wall clock.** `\newcommand` recursion and
  pathological line breaking are the runaway cases; a deterministic budget is
  reproducible where a timer is not. A wall clock stays as the outer backstop in
  brief 38's route.
- **Output size and page-count caps**, so a runaway loop cannot fill a disk.

**v1 runs in Node**, called from brief 38's compile job. It is browser-capable
*by construction*, so in-editor instant preview is later wiring rather than a
rewrite — but shipping it to the browser is **out of scope in all four briefs**,
and no payload is spent until someone decides it is worth it.

## Fonts

**Latin Modern** (CTAN package `lm` 2.005, GUST Font License — verified
2026-08-26), the OpenType successor to Computer Modern, so documents look like
TeX documents. Roman, italic, bold, bold-italic, typewriter. Committed to the
repo, **subset at emission** by `fontkit` so a PDF carries only used glyphs.

## Scope of THIS brief

**In:**

- **Preamble**: `\documentclass{article}` only. `\usepackage` against an
  allowlist that starts with `geometry` (margins only). `\title` `\author`
  `\date` `\maketitle`, `abstract`.
- **Text**: paragraphs, `\emph` `\textbf` `\textit` `\texttt` `\underline`,
  `\footnote`, quotes, en/em dashes, ties (`~`), `\\`, `\newpage`, escaped
  specials (`\%` `\&` `\_` `\#` `\$`).
- **Structure**: `\section` `\subsection` `\subsubsection` `\paragraph` with
  numbering and `*` variants, `\tableofcontents`.
- **Lists**: `itemize` `enumerate` `description`, nested.
- **Cross-references**: `\label` `\ref` `\pageref` via a second pass.
- **Verbatim**: `verbatim` environment and `\verb`.
- **User macros**: `\newcommand` / `\renewcommand` with N arguments and one
  optional argument. **This is the 90% of macro use that is not programming**,
  and it is the boundary.

**Out of this brief** (each a diagnostic, not silence): math (brief 40), floats,
`\includegraphics`, `tabular`, `.bib` (brief 39), and permanently — arbitrary
`.sty`/`.cls`, TeX programming (`\def`, `\catcode`, `\expandafter`, `\csname`,
registers), TikZ/pgf, `\marginpar`, multi-column, custom `\output`,
`book`/`report`/`beamer`, index and glossary packages, SyncTeX.

## Files you OWN

- `packages/typeset/` — **new workspace package**, the whole engine. **No
  dependency on `apps/api` or `apps/web`**, ever.
  - `src/parse/` — `@unified-latex` bindings, source positions preserved
  - `src/macro/` — builtin command table, `\newcommand`, environments
  - `src/doc/` — document model, counters, labels, the two-pass reference cycle
  - `src/layout/` — boxes, glue, penalties; Knuth–Plass; the page builder
  - `src/font/` — `fontkit` wrapper, metrics, the committed Latin Modern subset
  - `src/pdf/` — `pdfkit` emission
  - `src/diagnostics.ts` — the `Diagnostic` type and the loud-failure helpers
  - `test/fixtures/` + `test/golden/`
- `packages/shared/src/latex.ts` — **new**: the `Diagnostic` shape only, shared
  with brief 38. Nothing else in `packages/shared/` is touched.
- root `package.json` — the workspace entry and the `test` script

## Files you must NOT touch

- `apps/api/**` and `apps/web/**` — **this brief ships no UI and no routes.**
  Wiring is brief 38. If an API change seems needed, stop and say so.
- [calibre.ts](../../../apps/api/src/calibre.ts) and brief 34's job runner — the
  **model** for how a compile is driven, not code to modify or generalize.

## What to do

**M0 — the test harness, first.** This repo has **no test suite**, and a
typesetting engine without golden tests is unmaintainable: every layout change
silently moves every line on every page. A golden file records a **layout dump**
— each box's content, x, y, width, font — plus the diagnostics list. **Not PDF
bytes**, which are not stable across runs. A fixture is a `.tex` file and its
expected dump. Add `npm test` at the root and put it in the gates beside
typecheck and build. Everything after this is test-first.

**M1 — the spine, end to end.** Parse → paragraphs → Knuth–Plass line breaking
with hyphenation → one font → page builder → PDF. A document of plain prose,
with correct margins, page numbers and justified text, opens in `PdfReader` and
looks right. No sections, no math, no floats. **This milestone proves or kills
the architecture — build it before anything else and look hard at the output.**

**M2 — a real document.** Sections and numbering, ToC, lists, footnotes, the
text-level commands, `\newcommand`, labels and `\ref` via the two-pass cycle,
`verbatim`. At the end of M2 the engine can set a written report — which is what
makes brief 38 worth building next.

**Corpus.** D38 is already recorded. Add `wiki/typeset.md` covering the pipeline,
the scope table and the loud-failure contract; update
[architecture.md](../../wiki/architecture.md),
[status.md](../../wiki/status.md), [log.md](../../log.md).

## Acceptance

- A prose document and a structured report each compile to a PDF that opens in
  `PdfReader` and is **visually correct** — checked by eye, not only by test.
- **Every unsupported construct produces a diagnostic with file and line**, with
  a fixture proving it. None is silently ignored.
- Diagnostics carry accurate line numbers through parse, macro expansion and
  layout. A wrong line number is a bug, not a rough edge.
- Golden tests cover every "In" item; `npm test` is green and runs in the gates.
- The engine performs **no** file, network or process access. Grep proves it: no
  `fs`, `child_process`, `net` or `eval` in `packages/typeset/src/`.
- A `\newcommand` that recurses forever is stopped by the step budget with a
  clear message — not by a timeout, not by an OOM.
- Output-size and page-count caps are enforced, each with its own diagnostic.
- `packages/typeset` imports cleanly in Node, depends on neither app, and uses no
  Node-only API in its own source.
- Typecheck + build + the new test suite are clean.
- **No UI.** `apps/web` and `apps/api` are unchanged by this brief.

## Outcome (2026-08-26 — shipped)

Built via plan-split-dispatch: 9 chunks, 5 waves, 5 senior / 4 junior, then 3
scoped review finders and 2 fix rounds. **10,708 lines of engine, 5,335 of
tests, 332 tests green.** `compile()` takes `.tex` and returns a PDF that looks
like a LaTeX document — verified by rendering and looking, not only by golden.

M0, M1 and M2 all landed. Chunk 7 absorbed most of what M2 was scoped as, so
chunk 8 was re-scoped mid-run to the fidelity gaps and the three real bugs
chunk 7 found and correctly refused to patch outside its lane.

**Deviations from the brief, all deliberate:**

- **`pdf-lib`, not `pdfkit`.** The brief named pdfkit. Measured before
  dispatching: it calls `readFileSync` on its bundled `Helvetica.cjs` during
  *document construction*, even when only a custom font is embedded — which
  would have put filesystem access inside `src/` and closed the browser path.
  `pdf-lib` does zero filesystem calls. Cost accepted: it was last published in
  2022, which is a real staleness bet on a frozen spec.
- **`CompileResult` gained `pages`** beyond the brief's signature, because
  goldens need positioned layout and PDF bytes are not reproducible.
- **`.ts` import suffixes inside `src/`**, diverging from `apps/api`'s `.js`
  convention: Node's type stripping does not rewrite specifiers, `tsc` does on
  emit.
- **Node's built-in test runner**, no framework and no new dependency.

**Bugs found by attacking the engine rather than confirming it** — seven, none
caught by the gates:

- `\label` in a section title made `\pageref` print the ToC's page (Critical).
- `egin{equation}` reported `undefined-environment` instead of `unsupported`,
  and stuffed a non-string into a field the shared schema validates at brief
  38's API boundary.
- A budget latch keyed on a diagnostic code two unrelated failures also used —
  a circular `\input` could swallow a genuine exhaustion, truncating a document
  silently. **This was a defect in the controller's own earlier fix.**
- A `ootnote` in a heading typeset twice, under a diagnostic that was false on
  both counts.
- An `\item` opening with a nested list lost its bullet silently.
- `ef` to a nested enumerate item printed `1(a)` for `1a`.
- Control words did not gobble following whitespace.

**Upstream bug fixed, not worked around:** `@pdf-lib/fontkit` writes
`cff.length` into the CFF header's `offSize` byte — 6 for every Latin Modern
face, where the spec allows 1–4. Measured consequence: poppler rendered **every
page in a substitute typeface** and pdf.js could not detect the font type. A
silent catastrophic failure no layout test could have caught.

**Left for later, knowingly:** footnotes are never split across pages (a
too-tall note now reports rather than overflowing silently); `aggedbottom` is
hard-coded; ToC dot leaders are an approximation that falls back to `\hfil` when
an entry wraps; a second `\documentclass` overwrites the first's options while
keeping the first's name; `geometry` validates paper but not text dimensions.

The verify gate held throughout: three chunks died to transient 529s and one to
a session limit, all resumed or re-dispatched with no partial writes to
untangle — because dependencies were staged centrally and every chunk was
fenced off `src/index.ts` and `package.json`.
