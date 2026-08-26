import type { Diagnostic, SourceRef } from "../diagnostics.ts";

/**
 * The parse layer's AST (brief 37, chunk 3). This is the boundary between
 * "what the source says" and "what it means": macro expansion (chunk 6),
 * layout (chunks 4/7) and semantics (chunk 8) all walk this tree, but nothing
 * here decides what `\section` does or what `\x` expands to — see the
 * scope note in each node's doc comment.
 *
 * Every node's `loc.start` is a `SourceRef` pointing at where it begins in
 * the source, per the brief's non-negotiable contract. `loc.end` rides along
 * because dependents need the extent too (e.g. to name a whole construct in
 * a diagnostic, or to slice the original text back out).
 */

/** The half-open span a node occupies in its source file. */
export interface SourceSpan {
  start: SourceRef;
  end: SourceRef;
}

interface NodeBase {
  loc: SourceSpan;
}

/** A run of literal text with no special meaning — words, punctuation, digits. */
export interface TextNode extends NodeBase {
  type: "text";
  value: string;
}

/**
 * Inter-word space that is not a paragraph break: run(s) of spaces/tabs, or a
 * single newline that did not produce a blank line.
 */
export interface WhitespaceNode extends NodeBase {
  type: "whitespace";
}

/** A blank line (one or more) — the LaTeX paragraph separator. */
export interface ParBreakNode extends NodeBase {
  type: "parbreak";
}

/** `% ...` to end of line. `value` excludes the leading `%` and the line ending. */
export interface CommentNode extends NodeBase {
  type: "comment";
  value: string;
  /** Whether the comment follows other content on the same line, vs opening it. */
  sameLine: boolean;
}

/**
 * One of LaTeX's single-character "escaped special" macros — `\%`, `\&`,
 * `\_`, `\#`, `\$`, `\{`, `\}` and similar. These print their literal
 * character and never take arguments, so they get their own node instead of
 * forcing every consumer to special-case a zero-arg `CommandNode` by name.
 *
 * Deliberately distinct from a bare-backslash math macro like `^`/`_` in math
 * mode (which *can* take an argument, e.g. `x^2`) — see `from-unified-latex.ts`
 * for how the two are told apart.
 */
export interface EscapedCharNode extends NodeBase {
  type: "escaped";
  /** The literal character produced, e.g. `"%"` for `\%`. */
  char: string;
}

/**
 * One argument slot on a command or environment: `{...}` or `[...]`.
 *
 * Only commands/environments `@unified-latex` has a known signature for
 * (LaTeX/CTAN built-ins — `\section`, `\newcommand`, `itemize`'s optional
 * label, etc.) get any `Argument`s at all; see `CommandNode`. A slot the
 * signature defines but the source didn't write still appears here with
 * `bracket: null` and empty `content`, so a consumer can always index `args`
 * positionally instead of guessing how many were typed.
 */
export interface Argument {
  /**
   * The delimiter pair actually found in the source: `"{"` for a
   * brace-delimited argument, `"["` for a bracket-delimited (conventionally
   * optional) one, or `null` when the slot exists in the signature but was
   * not written — `content` is then always `[]`.
   */
  bracket: "{" | "[" | null;
  content: LatexNode[];
  loc: SourceSpan;
}

/**
 * `\name`, plus any arguments `@unified-latex` recognises for it.
 *
 * **Only commands with a known signature get `args` populated.** For a
 * command this stage has never heard of (any user macro, including ones
 * defined by a `\newcommand` elsewhere in the same document — this stage does
 * not track definitions, see the module doc comment), `args` is always `[]`,
 * and a `{...}` group written immediately after it in the source shows up as
 * a *sibling* `GroupNode`, not as this command's argument. Deciding it
 * belongs to the command requires knowing the command's arity, which is
 * macro-expansion's job (chunk 6), not the parser's. This is the single
 * biggest surprise in `@unified-latex`'s output — see the handoff notes.
 */
export interface CommandNode extends NodeBase {
  type: "command";
  /** Without the leading backslash, e.g. `"section"`, `"newcommand"`. */
  name: string;
  args: Argument[];
}

/**
 * `\begin{name} ... \end{name}` with matching names and proper nesting.
 *
 * An unmatched or misnamed `\begin`/`\end` never produces one of these: it
 * produces a `syntax` diagnostic and the `\begin`/`\end` are mapped as plain
 * `CommandNode`s instead (faithfully, since that is what they are once the
 * pairing fails) — see the malformed-input notes in `from-unified-latex.ts`.
 */
export interface EnvironmentNode extends NodeBase {
  type: "environment";
  name: string;
  args: Argument[];
  body: LatexNode[];
}

/** A brace group `{...}` that is not a command's argument — e.g. `{\bfseries text}` used purely for scoping. */
export interface GroupNode extends NodeBase {
  type: "group";
  body: LatexNode[];
}

/**
 * `$...$` (inline) or `\[...\]` / `$$...$$` (display). Contents are parsed
 * structurally (macros, groups, text) but given no mathematical meaning —
 * that is a later chunk's job.
 */
export interface MathNode extends NodeBase {
  type: "math";
  display: boolean;
  body: LatexNode[];
}

/**
 * A construct `@unified-latex` recognised syntactically but this stage has no
 * dedicated mapping for (e.g. `\verb|...|`, a `verbatim` environment).
 * Carried through rather than dropped — D38 forbids silently discarding
 * source content, even content this stage does not model. `raw` is the exact
 * source text of the construct, since `originalType` alone is structurally
 * opaque to a consumer that doesn't know `@unified-latex`'s node kinds.
 *
 * This stage does not judge whether the construct is "supported": that is a
 * semantic call for a later chunk (see `unsupported()` in `diagnostics.ts`),
 * not something the parser decides.
 */
export interface UnknownNode extends NodeBase {
  type: "unknown";
  /** The `@unified-latex` node kind this came from, e.g. `"verb"`. */
  originalType: string;
  raw: string;
}

export type LatexNode =
  | TextNode
  | WhitespaceNode
  | ParBreakNode
  | CommentNode
  | EscapedCharNode
  | CommandNode
  | EnvironmentNode
  | GroupNode
  | MathNode
  | UnknownNode;

/**
 * The result of parsing one file. Never throws to produce this — malformed
 * source is reported via `diagnostics` (code `syntax`), and the tree is still
 * as complete as it can honestly be made (see the malformed-input notes in
 * `from-unified-latex.ts`).
 */
export interface ParseResult {
  root: LatexNode[];
  diagnostics: Diagnostic[];
}
