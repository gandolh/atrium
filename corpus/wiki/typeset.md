---
summary: The typesetting engine — Atrium's own TypeScript LaTeX-subset compiler. Pipeline, the scope line, the loud-failure contract, and why it performs no I/O.
updated: 2026-08-26
---

# The typesetting engine

`packages/typeset` turns a **subset** of LaTeX into a PDF. It is ours, and it is
not TeX. Built by brief 37; extended by briefs 39 (figures, tables,
bibliography) and 40 (math). See **D38** for why it exists at all.

## The scope line: syntax, not semantics

LaTeX is not a file format, it is a program — `\catcode` lets a document
redefine what characters *mean* mid-parse. So there is no parser to write, only
a macro-expansion machine that must then execute the LaTeX kernel. Measured
2026-08-26: `tex.web` is **25,010 lines** of literate Pascal, and the kernel is
**79 `.dtx` files, 4.81 MB**, before `article.cls`.

We do not do that. We accept LaTeX-*shaped* documents and implement the
commands ourselves. **This is only defensible because the owner has nothing to
import** (brief 38 decision 4): the engine must render what gets written here,
not what CTAN can produce. If a legacy `.tex` corpus ever appears, D38 is the
first thing to revisit.

## The loud-failure contract — the spine

An unimplemented command produces a **diagnostic with file and line**, never a
silent skip and never a guess. A dropped `\thanks` is a missing footnote in a
*published* document; a silently-ignored `\hspace` is a table that looks right
and is wrong.

Two codes carry the distinction, and it is checked in review:

- **`unsupported`** — real LaTeX we deliberately do not implement.
- **`undefined-command` / `undefined-environment`** — not a thing at all.

Conflating them makes the diagnostic useless to a writer. This has been got
wrong twice and caught both times: `\begin{equation}` reported
`undefined-environment`, and a self-including `\input` borrowed
`budget-exceeded`. Treat a borrowed code as a bug, not a detail.

## No I/O — the security design, not a limitation

```
compile(files: Record<string, Uint8Array>, entrypoint, opts) -> { pdf, pages, diagnostics, stats }
```

A pure function over an in-memory file map. No filesystem, no network, no child
processes, no `eval`. `src/` compiles with `"types": []` so Node APIs will not
even typecheck there.

**This deletes the sandboxing problem rather than solving it.** `\write18`
cannot execute because no shell escape is written; `\input{/etc/passwd}` cannot
read anything because `\input` resolves against `files` or becomes a
`missing-file` diagnostic. Path confinement and symlink escape are not engine
concerns — they exist only where brief 38 accepts *uploads*.

What replaces a wall-clock timeout is a **deterministic step budget**:
reproducible where a timer is not, so "this compile was stopped" is testable.
Plus output-size and page caps.

**Known limitation:** `fontkit` pulls `node:fs` into the module graph
transitively. No document can reach it — the engine only ever calls
`fontkit.create(bytes)` — and `"types": []` still blocks first-party use. It
means `dist/` will not load in a host that bans the `fs` module. A browser
bundle resolves to fontkit's browser build and is unaffected.

Fonts are **injected** (`CompileOptions.fonts`) for the same reason: the caller
owns byte acquisition. Omitting them is a `missing-font` error, never a silent
substitution — there is no built-in fallback and there cannot be one.

## The pipeline

```
parse → macro → doc → layout → pdf
```

| Stage | What it does |
|---|---|
| `src/parse/` | `@unified-latex` → our AST, every node carrying a 1-based `SourceRef` |
| `src/macro/` | builtin tables, `\newcommand` expansion, the step budget |
| `src/doc/` | document model: blocks, inlines, counters, labels, `\ref` |
| `src/layout/` | box/glue, Knuth–Plass line breaking, hyphenation, page building |
| `src/font/` | `fontkit` wrapper over committed Latin Modern (GUST FL) |
| `src/pdf/` | `pdf-lib` document structure; glyphs positioned by us |

**Line breaking is total-fit**, not greedy — TeX's badness, fitness classes and
demerits with their values cited. The load-bearing test enumerates all `2^n`
breakings of a short paragraph, scores them with an independently-written
demerits function, and asserts the chosen one is the minimum: a proof rather
than an assertion.

**Glyphs are positioned explicitly.** `pdf-lib` sums *unkerned* advances and
writes them into `/W`, so `drawText` would render unkerned — not merely
mismeasure. `/W` carries the unkerned advance and a `TJ` array carries the kern
difference, recomputed from the running pen so rounding cannot drift.

**The document is laid out twice.** `\ref` resolves during the document build,
but `\pageref` cannot: a page number needs layout, and writing it in changes the
reference's width. The loop runs to a **fixed point** with a cap of three —
LaTeX's `.aux` cycle. A document with no markers lays out once.

## Testing

Brief 37 brought the repo's **first test suite** (`node --test`, no framework —
Node runs the TypeScript directly). Goldens record a **layout dump** — each
box's content, x, y, width, font — never PDF bytes, which are not reproducible.
Rounded to 3 decimals: far below what a reader can see, far above float noise,
so goldens neither flap nor hide a real change.

## What the reviews keep finding

Three scoped finders, twice now, and **every serious finding spanned files owned
by different chunks** — the ToC sharing an `Inline[]` with its heading so
`\pageref` printed the wrong page; a budget latch keyed on a diagnostic code two
unrelated failures also used. Per-chunk verification was honest and still
insufficient, because each chunk was right about its own half. Budget the review
accordingly on 39 and 40.

See [decisions.md](decisions.md) D38, and
[glossary-authoring.md](glossary-authoring.md) for **Typesetting engine**,
**Supported subset** and **Diagnostic**.
