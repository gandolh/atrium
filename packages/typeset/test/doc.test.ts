import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocument } from "../src/doc/index.ts";
import type { BuildResult } from "../src/doc/index.ts";
import type {
  Block,
  HeadingBlock,
  Inline,
  ListBlock,
  MarkerBlock,
  ParagraphBlock,
  TitleBlock,
  VerbatimBlock,
} from "../src/doc/index.ts";
import type { Diagnostic } from "../src/diagnostics.ts";

/**
 * The document model (brief 37, chunk 6): blocks, inlines, counters, labels.
 *
 * Nearly every test goes through `buildDocument` with a whole (tiny) document
 * rather than through the walker directly, because the preamble/body split and
 * the reference pass are part of what is being asserted.
 */

function build(body: string, preamble = ""): BuildResult {
  const source = `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
  return buildDocument({ "main.tex": source }, "main.tex");
}

function blocks(body: string, preamble = ""): Block[] {
  const result = build(body, preamble);
  assert.deepEqual(
    result.diagnostics.filter((d) => d.severity === "error"),
    [],
    `unexpected errors: ${result.diagnostics.map((d) => d.message).join("; ")}`,
  );
  return result.document.blocks;
}

/** Every character a block would set, ignoring style — enough for most assertions. */
function textOf(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "space":
        out += " ";
        break;
      case "tie":
        out += "~";
        break;
      case "linebreak":
        out += "\n";
        break;
      case "reference":
        out += node.text;
        break;
      case "footnote":
        out += `[fn${node.label}]`;
        break;
      case "marker":
        break;
    }
  }
  return out;
}

function paragraphs(body: string): string[] {
  return blocks(body)
    .filter((b): b is ParagraphBlock => b.kind === "paragraph")
    .map((b) => textOf(b.content));
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code ?? "?");
}

// --- text -------------------------------------------------------------------

test("prose becomes one paragraph per blank line", () => {
  assert.deepEqual(paragraphs("one two\n\nthree"), ["one two", "three"]);
});

test("a single newline is inter-word space, not a paragraph break", () => {
  assert.deepEqual(paragraphs("one\ntwo"), ["one two"]);
});

test("dashes and quotes get TeX's ligatures even when the parser split them", () => {
  assert.deepEqual(paragraphs("a--b, c---d, ``q'' and 'x'"), ["a–b, c—d, “q” and ’x’"]);
});

test("a tie is its own inline, not a space", () => {
  const [para] = blocks("Figure~1") as ParagraphBlock[];
  assert.deepEqual(
    para!.content.map((n) => n.kind),
    ["text", "tie", "text"],
  );
});

test("\\\\ produces a linebreak inline inside the same paragraph", () => {
  const [para] = blocks("a\\\\b") as ParagraphBlock[];
  assert.deepEqual(
    para!.content.map((n) => n.kind),
    ["text", "linebreak", "text"],
  );
});

test("escaped specials print their literal character", () => {
  assert.deepEqual(paragraphs("\\% \\& \\_ \\# \\$ \\{ \\}"), ["% & _ # $ { }"]);
});

test("\\textbf, \\textit and \\texttt each set one part of the font request", () => {
  const [para] = blocks("a\\textbf{b}\\textit{c}\\texttt{d}") as ParagraphBlock[];
  const styles = para!.content.filter((n) => n.kind === "text").map((n) => n.style.font);
  assert.deepEqual(styles, [
    { family: "serif", weight: "regular", slant: "upright" },
    { family: "serif", weight: "bold", slant: "upright" },
    { family: "serif", weight: "regular", slant: "italic" },
    { family: "mono", weight: "regular", slant: "upright" },
  ]);
});

test("\\emph toggles rather than sets, so emphasis inside emphasis is upright", () => {
  const [para] = blocks("\\emph{a \\emph{b}}") as ParagraphBlock[];
  const slants = para!.content.filter((n) => n.kind === "text").map((n) => n.style.font.slant);
  assert.deepEqual(slants, ["italic", "upright"]);
});

test("\\underline rides beside the font selection", () => {
  const [para] = blocks("\\underline{a}b") as ParagraphBlock[];
  const flags = para!.content.filter((n) => n.kind === "text").map((n) => n.style.underline);
  assert.deepEqual(flags, [true, false]);
});

test("a style declaration lasts to the end of its group and no further", () => {
  const [para] = blocks("a{\\bfseries b}c") as ParagraphBlock[];
  const weights = para!.content.filter((n) => n.kind === "text").map((n) => n.style.font.weight);
  assert.deepEqual(weights, ["regular", "bold", "regular"]);
});

test("\\footnote takes a number, carries its own blocks, and is listed on the document", () => {
  const result = build("a\\footnote{note} b\\footnote{other}");
  const footnotes = result.document.footnotes;
  assert.deepEqual(
    footnotes.map((f) => f.label),
    ["1", "2"],
  );
  assert.equal(textOf((footnotes[0]!.content[0] as ParagraphBlock).content), "note");
});

test("\\noindent suppresses the indent of the paragraph it opens", () => {
  const [first, second] = blocks("\\noindent a\n\nb") as ParagraphBlock[];
  assert.equal(first!.indent, false);
  assert.equal(second!.indent, true);
});

// --- structure --------------------------------------------------------------

test("sections number and nest, and reset their subordinates", () => {
  const headings = blocks(
    "\\section{A}\\subsection{A1}\\subsubsection{A1a}\\section{B}\\subsection{B1}",
  ).filter((b): b is HeadingBlock => b.kind === "heading");
  assert.deepEqual(
    headings.map((h) => `${h.level}:${h.number}`),
    ["section:1", "subsection:1.1", "subsubsection:1.1.1", "section:2", "subsection:2.1"],
  );
});

test("a * variant is unnumbered and stays out of the table of contents", () => {
  const result = build("\\section{A}\\section*{B}\\section{C}");
  const headings = result.document.blocks.filter((b): b is HeadingBlock => b.kind === "heading");
  assert.deepEqual(
    headings.map((h) => h.number),
    ["1", null, "2"],
  );
  assert.deepEqual(
    result.document.toc.map((e) => e.number),
    ["1", "2"],
  );
});

test("\\paragraph is a heading but article does not number it (secnumdepth 3)", () => {
  const [heading] = blocks("\\paragraph{P}") as HeadingBlock[];
  assert.equal(heading!.kind, "heading");
  assert.equal(heading!.level, "paragraph");
  assert.equal(heading!.number, null);
});

test("the paragraph after a heading is not indented", () => {
  const result = blocks("\\section{A}\ntext");
  const para = result.find((b): b is ParagraphBlock => b.kind === "paragraph");
  assert.equal(para!.indent, false);
});

test("itemize, enumerate and description each become a list block", () => {
  for (const variant of ["itemize", "enumerate", "description"] as const) {
    const item = variant === "description" ? "\\item[T] a" : "\\item a";
    const [list] = blocks(`\\begin{${variant}}${item}\\end{${variant}}`) as ListBlock[];
    assert.equal(list!.kind, "list");
    assert.equal(list!.variant, variant);
    assert.equal(list!.items.length, 1);
  }
});

test("enumerate items carry LaTeX's own labels", () => {
  const [list] = blocks("\\begin{enumerate}\\item a\\item b\\end{enumerate}") as ListBlock[];
  assert.deepEqual(
    list!.items.map((i) => textOf(i.label ?? [])),
    ["1.", "2."],
  );
});

test("itemize items carry no label — the bullet is chunk 7's to choose", () => {
  const [list] = blocks("\\begin{itemize}\\item a\\end{itemize}") as ListBlock[];
  assert.equal(list!.items[0]!.label, null);
});

test("a description item's term is its label", () => {
  const [list] = blocks("\\begin{description}\\item[Term] meaning\\end{description}") as ListBlock[];
  assert.equal(textOf(list!.items[0]!.label ?? []), "Term");
});

test("a nested list is found inside the preceding \\item's gobbled argument", () => {
  // The parser's `\item` signature swallows everything up to the next
  // `\item`/`\end`, nested environments included — walking only the outer
  // environment's `body` would miss this one entirely.
  const [outer] = blocks(
    "\\begin{itemize}\\item one\\begin{itemize}\\item deep\\end{itemize}\\item two\\end{itemize}",
  ) as ListBlock[];
  assert.equal(outer!.items.length, 2);
  const nested = outer!.items[0]!.content.find((b): b is ListBlock => b.kind === "list");
  assert.equal(nested!.depth, 2);
  assert.equal(nested!.variantDepth, 2);
});

test("an enumerate inside an itemize numbers from 1: enumerate depth is its own", () => {
  const [outer] = blocks(
    "\\begin{itemize}\\item one\\begin{enumerate}\\item a\\item b\\end{enumerate}\\end{itemize}",
  ) as ListBlock[];
  const nested = outer!.items[0]!.content.find((b): b is ListBlock => b.kind === "list");
  assert.equal(nested!.depth, 2);
  assert.equal(nested!.variantDepth, 1);
  assert.deepEqual(
    nested!.items.map((i) => textOf(i.label ?? [])),
    ["1.", "2."],
  );
});

test("a second-level enumerate uses letters in parentheses", () => {
  const [outer] = blocks(
    "\\begin{enumerate}\\item one\\begin{enumerate}\\item a\\end{enumerate}\\end{enumerate}",
  ) as ListBlock[];
  const nested = outer!.items[0]!.content.find((b): b is ListBlock => b.kind === "list");
  assert.equal(textOf(nested!.items[0]!.label ?? []), "(a)");
});

test("verbatim keeps its lines literally and drops the surrounding newlines", () => {
  const [verb] = blocks("\\begin{verbatim}\n a  b \\x\nsecond\n\\end{verbatim}") as VerbatimBlock[];
  assert.equal(verb!.kind, "verbatim");
  assert.deepEqual(verb!.lines, [" a  b \\x", "second"]);
});

test("abstract becomes its own block holding blocks", () => {
  const [abstract] = blocks("\\begin{abstract}Summary.\\end{abstract}");
  assert.equal(abstract!.kind, "abstract");
});

test("\\maketitle collects \\title, \\author and \\date from the preamble", () => {
  const [title] = blocks("\\maketitle", "\\title{T}\\author{A}\\date{D}\n") as TitleBlock[];
  assert.equal(title!.kind, "title");
  assert.equal(textOf(title!.title), "T");
  assert.equal(textOf(title!.author), "A");
  assert.equal(textOf(title!.date ?? []), "D");
});

test("\\maketitle without \\date warns and prints no date — the engine has no clock", () => {
  const result = build("\\maketitle", "\\title{T}\n");
  const [title] = result.document.blocks as TitleBlock[];
  assert.equal(title!.date, null);
  assert.ok(result.diagnostics.some((d) => d.severity === "warning" && d.code === "unsupported"));
  assert.deepEqual(
    result.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
});

test("\\tableofcontents becomes a block, with entries collected on the document", () => {
  const result = build("\\tableofcontents\\section{A}\\subsection{B}");
  assert.equal(result.document.blocks[0]!.kind, "toc");
  assert.deepEqual(
    result.document.toc.map((e) => [e.level, e.number, e.marker]),
    [
      ["section", "1", "heading:0"],
      ["subsection", "1.1", "heading:1"],
    ],
  );
});

test("\\newpage becomes a page break block", () => {
  assert.equal(blocks("a\\newpage b")[1]!.kind, "pagebreak");
});

// --- cross-references -------------------------------------------------------

test("\\ref resolves a label defined earlier", () => {
  assert.deepEqual(paragraphs("\\section{A}\\label{a}\n\ntext \\ref{a}"), ["text 1"]);
});

test("\\ref resolves a label defined later — that is what the second pass is for", () => {
  assert.deepEqual(paragraphs("see \\ref{later}\n\n\\section{A}\\label{later}"), ["see 1"]);
});

test("\\label inside an enumerate item refers to the item, not the section", () => {
  const result = build("\\begin{enumerate}\\item a\\label{i}\\item b\\end{enumerate}\n\n\\ref{i}");
  assert.equal(result.document.labels.get("i")!.text, "1");
});

test("\\ref to a nested enumerate item follows \\p@enumN, which parenthesises nothing at level 2", () => {
  // `classes.dtx`: `\p@enumii{\theenumi}`, `\p@enumiii{\theenumi(\theenumii)}`,
  // `\p@enumiv{\p@enumiii\theenumiii}`. The parentheses at level 2 belong to
  // `\labelenumii` — what the item prints in its own margin — and to the
  // *prefix* `\p@enumiii`, never to a reference that stops at level 2.
  const two = build(
    "\\begin{enumerate}\\item a\n\\begin{enumerate}\\item b\\label{deep}\\end{enumerate}\\end{enumerate}\n\n\\ref{deep}",
  );
  assert.equal(two.document.labels.get("deep")!.text, "1a");

  const three = build(
    "\\begin{enumerate}\\item a\n\\begin{enumerate}\\item b\n\\begin{enumerate}\\item c\\label{deeper}" +
      "\\end{enumerate}\\end{enumerate}\\end{enumerate}\n\n\\ref{deeper}",
  );
  assert.equal(three.document.labels.get("deeper")!.text, "1(a)i");
});

test("\\label inside a footnote refers to the footnote", () => {
  const result = build("a\\footnote{n\\label{f}}");
  assert.equal(result.document.labels.get("f")!.text, "1");
});

test("an unresolved \\ref is a diagnostic and still prints ??", () => {
  const result = build("see \\ref{nope}");
  assert.deepEqual(codes(result.diagnostics), ["undefined-reference"]);
  const [para] = result.document.blocks as ParagraphBlock[];
  assert.equal(textOf(para!.content), "see ??");
});

test("a duplicate \\label is a diagnostic and the first definition wins", () => {
  const result = build("\\section{A}\\label{k}\\section{B}\\label{k}\n\n\\ref{k}");
  assert.ok(result.diagnostics.some((d) => d.code === "duplicate-label"));
  assert.equal(result.document.labels.get("k")!.text, "1");
});

test("\\label emits a marker so layout can report its page", () => {
  const result = build("\\section{A}\\label{a}");
  const marker = result.document.blocks.find((b): b is MarkerBlock => b.kind === "marker");
  assert.equal(marker?.name, "label:a");
  assert.equal(result.document.labels.get("a")!.marker, "label:a");
});

test("\\pageref prints ?? until layout reports the page, then the page", () => {
  const result = build("\\section{A}\\label{a}\n\npage \\pageref{a}");
  const para = result.document.blocks.find((b): b is ParagraphBlock => b.kind === "paragraph");
  assert.equal(textOf(para!.content), "page ??");

  const extra = result.resolvePageNumbers(new Map([["label:a", 7]]));
  assert.deepEqual(extra, []);
  assert.equal(textOf(para!.content), "page 7");
});

test("a \\pageref whose marker never reaches a page is reported, not left silent", () => {
  const result = build("\\section{A}\\label{a}\n\n\\pageref{a}");
  const extra = result.resolvePageNumbers(new Map());
  assert.deepEqual(codes(extra), ["undefined-reference"]);
});

// --- files ------------------------------------------------------------------

test("\\input splices another file in, with its macros in scope afterwards", () => {
  const result = buildDocument(
    {
      "main.tex": "\\documentclass{article}\\input{defs}\\begin{document}\\hi\\end{document}",
      "defs.tex": "\\newcommand{\\hi}{hello}",
    },
    "main.tex",
  );
  assert.deepEqual(
    result.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  const [para] = result.document.blocks as ParagraphBlock[];
  assert.equal(textOf(para!.content), "hello");
});

test("\\input of a file that is not in the project is a missing-file diagnostic", () => {
  const result = build("\\input{/etc/passwd}");
  assert.deepEqual(codes(result.diagnostics), ["missing-file"]);
});

test("a file that includes itself is stopped rather than looping", () => {
  const result = buildDocument(
    { "main.tex": "\\documentclass{article}\\begin{document}\\input{main}\\end{document}" },
    "main.tex",
  );
  // `syntax`, not `budget-exceeded`: a self-including file is a malformed
  // document, not an exhausted resource. Borrowing the budget code told the
  // writer the wrong thing, and — because compile() latched "already reported"
  // off that code — could suppress a real budget exhaustion later in the same
  // run, silently truncating the document with nothing to say why.
  const hit = result.diagnostics.find((d) => d.construct === "\\input");
  assert.ok(hit !== undefined, `expected a diagnostic about the self-include, got ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.code, "syntax");
  assert.equal(hit.severity, "error");
  assert.ok(!result.diagnostics.some((d) => d.code === "budget-exceeded"));
});

test("a missing entrypoint is a diagnostic, not a throw", () => {
  const result = buildDocument({}, "main.tex");
  assert.deepEqual(codes(result.diagnostics), ["missing-file"]);
});

// --- the loud-failure contract ----------------------------------------------

/*
 * These two asserted, until chunk 40.3, that *all* math reported `unsupported`
 * — the placeholder brief 37 left behind. Brief 40 landed and math is
 * implemented, so the assertions now check the behaviour that replaced it: a
 * math run becomes a typed node carrying its TeX, and only a construct outside
 * brief 40's In list still reports `unsupported` (D41 §5). They are not
 * relaxed: each still pins a file, a line and a construct on the diagnostic,
 * because the position contract is what they were really guarding.
 *
 * `test/math-contract.test.ts` is where the In/Out inventory lives.
 */
test("inline math becomes a math inline carrying its source, with a file and a line", () => {
  const result = build("before $x^2$ after");
  assert.deepEqual(codes(result.diagnostics), []);
  const para = result.document.blocks[0] as ParagraphBlock;
  const math = para.content.find((i) => i.kind === "math");
  assert.ok(math !== undefined, "the paragraph carries a math inline");
  assert.equal(math.kind === "math" && math.source, "x^{2}");
  assert.equal(math.loc.file, "main.tex");
  assert.equal(math.loc.line, 3);
});

test("a math construct outside brief 40's In list is still unsupported, with a file and a line", () => {
  // `\mathfrak` needs a fraktur face this engine does not ship, so it is on
  // the Out list — real LaTeX, declined, which is `unsupported` and never
  // `undefined-command` (D38).
  const result = build("before $\\mathfrak{g}$ after");
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic!.code, "unsupported");
  assert.equal(diagnostic!.construct, "\\mathfrak");
  assert.equal(diagnostic!.file, "main.tex");
  assert.equal(diagnostic!.line, 3);
});

test("display math becomes a display block, and \\[...\\] is what names it", () => {
  const result = build("\\[x\\]");
  assert.deepEqual(codes(result.diagnostics), []);
  const block = result.document.blocks[0]!;
  assert.equal(block.kind, "displaymath");
  assert.equal(block.kind === "displaymath" && block.construct, "\\[...\\]");
  assert.equal(block.kind === "displaymath" && block.numbered, false);
});

test("an unimplemented environment is `unsupported`, an unknown one is `undefined-environment`", () => {
  // `tabular` used to be this exemplar: chunk 39.3 implemented it for real,
  // so a valid one (as this fixture is) now sets quietly instead. `longtable`
  // is still genuinely unsupported.
  assert.deepEqual(codes(build("\\begin{longtable}{ll}a\\end{longtable}").diagnostics), ["unsupported"]);
  assert.deepEqual(codes(build("\\begin{frobnicate}a\\end{frobnicate}").diagnostics), [
    "undefined-environment",
  ]);
});

test("an unimplemented command is `unsupported`, an unknown one is `undefined-command`", () => {
  // `\includegraphics` used to be this exemplar: chunk 39.2 implemented it
  // for real, so it now produces no document-layer diagnostic at all (the
  // image is decoded and placed at layout time instead). `\textsc` is still
  // genuinely unsupported.
  assert.deepEqual(codes(build("\\textsc{s}").diagnostics), ["unsupported"]);
  assert.deepEqual(codes(build("\\frobnicate{x}").diagnostics), ["undefined-command"]);
});

test("TeX programming says so, and says it is permanent", () => {
  const result = build("\\def\\x{y}");
  const diagnostic = result.diagnostics.find((d) => d.construct === "\\def");
  assert.equal(diagnostic!.code, "unsupported");
  assert.match(diagnostic!.message, /permanently out of scope/);
});

test("a package outside the allowlist is unsupported, and geometry is recorded", () => {
  const result = build("a", "\\usepackage{tikz}\\usepackage[margin=1in]{geometry}\n");
  assert.ok(
    result.diagnostics.some((d) => d.code === "unsupported" && d.construct === "\\usepackage{tikz}"),
  );
  assert.deepEqual(result.document.packages, [
    { name: "geometry", options: "margin=1in", loc: { file: "main.tex", line: 2, column: 18 } },
  ]);
});

test("a class other than article is unsupported", () => {
  const result = buildDocument(
    { "main.tex": "\\documentclass{book}\\begin{document}a\\end{document}" },
    "main.tex",
  );
  assert.ok(result.diagnostics.some((d) => d.code === "unsupported" && /article/.test(d.message)));
});

test("every unsupported diagnostic carries a file, a line and the construct", () => {
  // The fixture keeps `\includegraphics` and `tabular` for historical
  // continuity, but neither contributes an `unsupported` diagnostic here any
  // more: both are chunk 39.2/39.3 constructs that are genuinely implemented
  // now (a valid, single-cell `tabular` sets quietly; a bare `\includegraphics{a}`
  // is only wrong at layout time, over a missing file, which this
  // document-layer-only `build()` never reaches). The math exemplar had to be
  // swapped for the same reason at chunk 40.3: a bare `$x$` is implemented
  // now, so it was replaced by `$\mathfrak{g}$` — still math, still one
  // `unsupported`, but the one brief 40 actually declines (a math alphabet
  // needing a face this engine does not ship). Only that, `\textsc` and
  // `\hspace` are still unimplemented, so the count is 3, not 5.
  const result = build(
    "\\includegraphics{a}\n\\begin{tabular}{l}x\\end{tabular}\n$\\mathfrak{g}$\n\\textsc{s}\n\\hspace{1cm}",
  );
  const unsupported = result.diagnostics.filter((d) => d.code === "unsupported");
  assert.equal(unsupported.length, 3);
  for (const d of unsupported) {
    assert.equal(d.file, "main.tex");
    assert.ok(d.line > 0, `${d.message} has no line`);
    assert.ok(typeof d.construct === "string" && d.construct.length > 0);
  }
});

test("a document with no \\documentclass is a diagnostic", () => {
  const result = buildDocument({ "main.tex": "\\begin{document}a\\end{document}" }, "main.tex");
  assert.ok(result.diagnostics.some((d) => d.code === "syntax" && /documentclass/.test(d.message)));
});

test("a document with no \\begin{document} is a diagnostic, and the body still builds", () => {
  const result = buildDocument({ "main.tex": "\\documentclass{article}\nhello" }, "main.tex");
  assert.ok(result.diagnostics.some((d) => /begin\{document\}/.test(d.message)));
  assert.equal(textOf((result.document.blocks[0] as ParagraphBlock).content), "hello");
});

test("an unpaired \\begin does not typeset the environment's name", () => {
  const result = build("\\begin{itemize}\\item a");
  const para = result.document.blocks.find((b): b is ParagraphBlock => b.kind === "paragraph");
  assert.ok(para === undefined || !textOf(para.content).includes("itemize"));
  assert.ok(result.diagnostics.some((d) => d.code === "syntax"));
});

test("\\item outside a list is a diagnostic", () => {
  assert.ok(build("\\item a").diagnostics.some((d) => d.code === "syntax"));
});

test("the step budget stops the builder as well as the expander", () => {
  const source = "\\documentclass{article}\\begin{document}" + "word ".repeat(200) + "\\end{document}";
  const result = buildDocument({ "main.tex": source }, "main.tex", { stepBudget: 50 });
  assert.ok(result.diagnostics.some((d) => d.code === "budget-exceeded"));
});

test("steps are reported so the caller can fill in CompileStats", () => {
  const result = build("hello world");
  assert.ok(result.steps > 0);
});
