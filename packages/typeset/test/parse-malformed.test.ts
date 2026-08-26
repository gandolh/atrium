import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLatex } from "../src/parse/index.ts";

/**
 * Malformed-input handling (brief 37, chunk 3's other non-negotiable line):
 * an unclosed environment, an unclosed group, or a stray `}` must produce a
 * `syntax` diagnostic with the right line, and `parseLatex` must never throw.
 *
 * `@unified-latex`'s base parser is lenient by construction — confirmed by
 * direct testing (see `from-unified-latex.ts`'s doc comment) — it never
 * throws for any of these and never marks the tree as broken either; a
 * mismatched `\begin`/`\end` just leaves both as ordinary macros, and an
 * unclosed `{`/stray `}` just leaves the brace as a literal character. All
 * of the actual detection work happens in `checkMalformed` in
 * `from-unified-latex.ts`; these tests are about that detection's output.
 */

test("an unclosed environment produces a syntax diagnostic naming it, at the \\begin line", () => {
  const { root, diagnostics } = parseLatex("intro\n\\begin{itemize}\n\\item one\n", "x.tex");
  assert.equal(diagnostics.length, 1);
  const d = diagnostics[0]!;
  assert.equal(d.severity, "error");
  assert.equal(d.code, "syntax");
  assert.equal(d.file, "x.tex");
  assert.equal(d.line, 2); // "\\begin{itemize}" is line 2
  assert.match(d.message, /unclosed environment `itemize`/);
  assert.equal(d.construct, "\\begin{itemize}");
  // Still produces a tree — the \begin/{itemize} are mapped faithfully as a
  // command and a sibling group, not dropped.
  assert.ok(root.some((n) => n.type === "command" && n.name === "begin"));
});

test("a mismatched \\end produces its own diagnostic naming the environment it claims to close", () => {
  const { diagnostics } = parseLatex("\\begin{itemize}\n\\item one\n\\end{enumerate}\n", "x.tex");
  assert.equal(diagnostics.length, 2);
  const [openDiag, closeDiag] = diagnostics;
  assert.match(openDiag!.message, /unclosed environment `itemize`/);
  assert.equal(closeDiag!.code, "syntax");
  assert.equal(closeDiag!.line, 3); // "\\end{enumerate}" is line 3
  assert.match(closeDiag!.message, /\\end\{enumerate\} has no matching \\begin\{enumerate\}/);
});

test("a stray \\end with no \\begin at all is its own diagnostic", () => {
  const { diagnostics } = parseLatex("text \\end{itemize} more", "x.tex");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, "syntax");
  assert.match(diagnostics[0]!.message, /\\end\{itemize\} has no matching \\begin/);
});

test("an unclosed group produces a syntax diagnostic at the opening brace", () => {
  const { root, diagnostics } = parseLatex("a {grouped text b", "x.tex");
  assert.equal(diagnostics.length, 1);
  const d = diagnostics[0]!;
  assert.equal(d.severity, "error");
  assert.equal(d.code, "syntax");
  assert.equal(d.line, 1);
  assert.match(d.message, /unmatched \{/);
  assert.equal(d.construct, "{");
  // The brace survives as literal text rather than being silently dropped.
  assert.ok(root.some((n) => n.type === "text" && n.value === "{"));
});

test("a stray closing brace produces a syntax diagnostic at its own position", () => {
  const { diagnostics } = parseLatex("a } b", "x.tex");
  assert.equal(diagnostics.length, 1);
  const d = diagnostics[0]!;
  assert.equal(d.code, "syntax");
  assert.equal(d.line, 1);
  assert.equal(d.column, 3);
  assert.match(d.message, /unmatched \}/);
  assert.equal(d.construct, "}");
});

test("a required argument left unclosed to end of input still reports the { it fell back to, not a crash", () => {
  const { diagnostics } = parseLatex("\\section{Unclosed title\nmore text", "x.tex");
  assert.ok(diagnostics.some((d) => d.code === "syntax" && /unmatched \{/.test(d.message)));
});

test("a document with no malformed constructs produces no syntax diagnostics", () => {
  const { diagnostics } = parseLatex("\\section{Fine}\n\nSome text with \\textbf{bold}.\n", "x.tex");
  assert.deepEqual(diagnostics, []);
});

test("parseLatex never throws, across a battery of malformed inputs", () => {
  const inputs = [
    "",
    "{",
    "}",
    "{{{{{",
    "}}}}}",
    "\\begin{a}\\begin{b}\\begin{c}",
    "\\end{a}\\end{b}\\end{c}",
    "\\section{",
    "\\newcommand{\\x}[",
    "$x",
    "\\begin{itemize}\\end{enumerate}\\end{itemize}",
    "%",
    "\\",
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseLatex(input, "x.tex"), `input ${JSON.stringify(input)} should not throw`);
  }
});
