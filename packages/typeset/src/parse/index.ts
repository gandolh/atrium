import { getParser } from "@unified-latex/unified-latex-util-parse";
import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { mapContentList } from "./from-unified-latex.ts";
import { normalizeLineEndings } from "./normalize.ts";
import type { ParseResult } from "./ast.ts";

/**
 * `@unified-latex`'s parser only depends on the macro/environment catalog
 * baked into `getParser()` at construction time, not on anything from a
 * particular document — it's safe, and considerably cheaper, to build it
 * once per process rather than per call.
 */
const parser = getParser();

/**
 * Parse LaTeX source into Atrium's own AST (brief 37, chunk 3).
 *
 * Turns text into a tree of what the source *says*; it does not expand
 * macros, does not know what any command *means*, and does not resolve
 * `\input` (see the module doc comment in `ast.ts` for the full scope line).
 *
 * `file` is stamped onto every `SourceRef` in the result — it should be the
 * project-relative path the caller knows this source as (`compile()`'s keys
 * into its `files` map), so a diagnostic or later error can point back at a
 * file the caller recognises.
 *
 * **Never throws.** Malformed input (an unclosed environment or group, a
 * stray `}`) is reported as a `syntax` diagnostic with an accurate position,
 * not an exception — consistent with the rest of the engine (see `compile()`
 * in `compile.ts`). This function does not itself wrap anything in try/catch:
 * `@unified-latex`'s base parser is lenient by construction (confirmed by
 * direct testing — see `from-unified-latex.ts`) and never throws for bad
 * *input*; a genuine crash here would be an engine bug, which is exactly what
 * `compile()`'s outer boundary exists to catch and convert to `internal`.
 * Duplicating that net at every internal layer would hide the difference
 * between "bad input" and "our bug" instead of preserving it.
 */
export function parseLatex(source: string, file: string): ParseResult {
  const normalized = normalizeLineEndings(source);
  const raw = parser.parse(normalized);
  const diagnostics: Diagnostic[] = [];
  const initialCursor: SourceRef = { file, line: 1, column: 1 };
  const { nodes } = mapContentList(raw.content, file, normalized, initialCursor, diagnostics);
  return { root: nodes, diagnostics };
}

export type {
  Argument,
  CommandNode,
  CommentNode,
  EnvironmentNode,
  EscapedCharNode,
  GroupNode,
  LatexNode,
  MathNode,
  ParBreakNode,
  ParseResult,
  SourceSpan,
  TextNode,
  UnknownNode,
  WhitespaceNode,
} from "./ast.ts";
