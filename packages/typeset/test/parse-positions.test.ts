import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLatex } from "../src/parse/index.ts";
import type { CommandNode, EnvironmentNode, LatexNode } from "../src/parse/index.ts";

/**
 * Position accuracy (brief 37, chunk 3's non-negotiable acceptance line):
 * every node's `loc.start` must be a `SourceRef` pointing at where it
 * actually starts. `@unified-latex` already reports line/column directly
 * (not byte offsets), 1-based, matching `SourceRef`'s own contract — so the
 * mapping in `from-unified-latex.ts` is a straight pass-through for most
 * nodes. This file locks down the two places it isn't:
 *
 * - CRLF line endings, which the library's tokenizer miscounts as paragraph
 *   breaks unless normalized first (`normalize.ts`).
 * - Two specific node kinds (`whitespace`/`parbreak` at the edge of content
 *   gathered by a macro's custom argument parser, e.g. `\item`) that the
 *   library returns with no `position` at all, which `from-unified-latex.ts`
 *   reconstructs exactly from neighbouring nodes rather than approximating.
 */

function find<T extends LatexNode>(nodes: LatexNode[], pred: (n: LatexNode) => n is T): T {
  const found = nodes.find(pred);
  assert.ok(found, "expected node not found");
  return found as T;
}

/**
 * Searches a node and everything under it — including inside command/
 * environment arguments — for the first match. Needed because `\item`'s
 * "gobble everything up to the next \item/\end" argument parser pulls a
 * nested environment into *its own argument content*, not into the outer
 * environment's `body` as a sibling. That is correct LaTeX (a nested list
 * under a bullet really is that item's content), not something this stage
 * should flatten away.
 */
function findDeep<T extends LatexNode>(nodes: LatexNode[], pred: (n: LatexNode) => n is T): T | undefined {
  for (const n of nodes) {
    if (pred(n)) return n;
    if (n.type === "environment" || n.type === "group" || n.type === "math") {
      const child = findDeep(n.body, pred);
      if (child) return child;
    }
    if (n.type === "command" || n.type === "environment") {
      for (const arg of n.args) {
        const child = findDeep(arg.content, pred);
        if (child) return child;
      }
    }
  }
  return undefined;
}

test("line and column are 1-based and track a multi-line document", () => {
  const src = "one\ntwo\nthree";
  const { root } = parseLatex(src, "x.tex");
  assert.deepEqual(
    root.map((n) => [n.type, n.loc.start.line, n.loc.start.column]),
    [
      ["text", 1, 1],
      ["whitespace", 1, 4],
      ["text", 2, 1],
      ["whitespace", 2, 4],
      ["text", 3, 1],
    ],
  );
});

test("column resets to 1 on every new line, and every node names the given file", () => {
  const { root } = parseLatex("ab\ncd", "chapters/one.tex");
  const second = root.find((n) => n.type === "text" && n.value === "cd") as { loc: { start: { file: string; line: number; column: number } } } | undefined;
  assert.ok(second);
  assert.deepEqual(second.loc.start, { file: "chapters/one.tex", line: 2, column: 1 });
});

test("a command deep inside nested environments still gets its real line, not the environment's", () => {
  const src = ["\\begin{itemize}", "\\item outer", "\\begin{itemize}", "\\item inner", "\\end{itemize}", "\\end{itemize}"].join(
    "\n",
  );
  const { root, diagnostics } = parseLatex(src, "x.tex");
  assert.deepEqual(diagnostics, []);
  const outer = root[0] as EnvironmentNode;
  const inner = findDeep(outer.body, (n): n is EnvironmentNode => n.type === "environment");
  assert.ok(inner, "the nested \\begin{itemize} is somewhere under the outer environment");
  const innerItem = findDeep(inner!.body, (n): n is CommandNode => n.type === "command" && n.name === "item");
  assert.ok(innerItem);
  assert.equal(innerItem!.loc.start.line, 4); // "\\item inner" is line 4
  assert.equal(innerItem!.loc.start.column, 1);
});

test("a CRLF line ending is whitespace, not a spurious paragraph break", () => {
  const { root, diagnostics } = parseLatex("line1\r\nline2", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    root.map((n) => n.type),
    ["text", "whitespace", "text"],
  );
});

test("CRLF normalization preserves line numbers exactly", () => {
  const crlf = parseLatex("one\r\ntwo\r\nthree", "x.tex");
  const lf = parseLatex("one\ntwo\nthree", "x.tex");
  const lines = (r: LatexNode[]) => r.map((n) => n.loc.start.line);
  assert.deepEqual(lines(crlf.root), lines(lf.root));
  assert.deepEqual(
    crlf.root.map((n) => n.loc.start.line),
    [1, 1, 2, 2, 3],
  );
});

test("CRLF and a genuine blank line (CRLFCRLF) still produce exactly one ParBreakNode", () => {
  const { root, diagnostics } = parseLatex("a\r\n\r\nb", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    root.map((n) => n.type),
    ["text", "parbreak", "text"],
  );
});

test("a position @unified-latex drops (the gap before \\item's trailing text) is reconstructed exactly, not approximately", () => {
  // `\item one two` — @unified-latex reports no `position` at all for the
  // leading whitespace inside \item's gathered argument content. Confirmed by
  // direct inspection of its output (see from-unified-latex.ts's doc
  // comment). The true gap is exactly one column: right after "\item" (which
  // ends where "\item" — 5 characters — ends) and right before "one" begins.
  const { root, diagnostics } = parseLatex("\\begin{itemize}\n\\item one\n\\end{itemize}", "x.tex");
  assert.deepEqual(diagnostics, []);
  const env = root[0] as EnvironmentNode;
  const item = find(env.body, (n): n is CommandNode => n.type === "command" && n.name === "item");
  const bodyArg = item.args.find((a) => a.content.length > 0)!;
  const leadingSpace = bodyArg.content[0]!;
  assert.equal(leadingSpace.type, "whitespace");
  // "\\item" occupies columns 1-6 on line 2; the space is column 6-7.
  assert.deepEqual(leadingSpace.loc, {
    start: { file: "x.tex", line: 2, column: 6 },
    end: { file: "x.tex", line: 2, column: 7 },
  });
  const word = bodyArg.content[1]!;
  assert.equal(word.type, "text");
  assert.deepEqual(word.loc.start, { file: "x.tex", line: 2, column: 7 });
});

test("a position-less ParBreakNode between two \\items is reconstructed from where the first item's *content* ends, not from the \\item token itself", () => {
  // Regression case: \item's own `position` only covers the token "\item"
  // (columns 1-6), but its gathered argument content ("one two", columns
  // 6-14) extends well past that. The gap before the next \item must start
  // after the *content*, or the reconstructed position silently regresses to
  // an earlier column.
  const src = "\\begin{itemize}\n\\item one two\n\\item second\n\\end{itemize}";
  const { root, diagnostics } = parseLatex(src, "x.tex");
  assert.deepEqual(diagnostics, []);
  const env = root[0] as EnvironmentNode;
  const gap = find(env.body, (n): n is LatexNode & { type: "parbreak" } => n.type === "parbreak");
  assert.deepEqual(gap.loc, {
    start: { file: "x.tex", line: 2, column: 14 }, // right after "two" ends
    end: { file: "x.tex", line: 3, column: 1 }, // right before the next \item
  });
});

test("column counting is UTF-16 code units, matching plain JS string indexing (an astral character counts as 2 columns)", () => {
  // Not a defect: this is the same convention the Language Server Protocol
  // uses for `character` offsets, and it falls out for free from `@unified-
  // latex` tokenizing a JS string. Documented here so a consumer building a
  // grapheme-aware view (e.g. an editor gutter) knows to convert rather than
  // being surprised the column skipped a value.
  const { root } = parseLatex("😀 x", "x.tex");
  const word = root.find((n) => n.type === "text" && n.value === "x")!;
  // "😀" is one code point but a UTF-16 surrogate pair (2 units), then a
  // space (1 unit) puts "x" at column 4, not column 3.
  assert.equal(word.loc.start.column, 4);
});
