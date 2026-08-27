import type { AbortLike } from "../compile.ts";
import type { Diagnostic } from "../diagnostics.ts";
import { error, wholeFile } from "../diagnostics.ts";
import type { CommandNode, LatexNode } from "../parse/index.ts";
import { parseLatex } from "../parse/index.ts";
import { createBudget, spend } from "../macro/budget.ts";
import type { Budget } from "../macro/budget.ts";
import { createExpandContext, expandMacros } from "../macro/expand.ts";
import type { BuildState } from "./build.ts";
import { createBuildState, plainText, readPreamble, walkBlocks } from "./build.ts";
import type { BibContext } from "./bib.ts";
import { formatBibliography, resolveCitations } from "./bib.ts";
import type { Block, CitationInline, LatexDocument, ReferenceInline } from "./model.ts";
import { DEFAULT_TEXT_STYLE, UNRESOLVED_REFERENCE } from "./model.ts";

/**
 * The document layer's entry point (brief 37, chunk 6): a LaTeX project in,
 * a document model out.
 *
 * The pipeline is parse → resolve `\input` → expand macros → split preamble
 * from body → walk → resolve `\ref`. Each stage is a separate module; this
 * file is only the order they run in and the shape of the result.
 *
 * **Never throws.** Like `compile()`, every failure is a `Diagnostic` — a
 * missing file, a runaway macro, an unimplemented construct. The one thing
 * that could still throw is an engine bug, which `compile()` catches at its
 * own boundary and reports as `internal`.
 */

/** Project sources, already decoded. Decoding bytes needs an API `src/` cannot have (D38). */
export type SourceFiles = Readonly<Record<string, string>>;

export interface BuildDocumentOptions {
  /** Defaults to `DEFAULT_COMPILE_OPTIONS.stepBudget`. */
  stepBudget?: number;
  signal?: AbortLike | null;
}

const DEFAULT_STEP_BUDGET = 5_000_000;

export interface BuildResult {
  document: LatexDocument;
  diagnostics: Diagnostic[];
  /** Steps consumed, for `CompileStats.steps`. */
  steps: number;
  /** Every `\ref`/`\pageref` in the document, in source order. */
  references: readonly ReferenceInline[];
  /**
   * Every `\cite`/`\citep`/`\citet`/`\nocite`, in source order — beside
   * `references` rather than on the document for the same reason: they are the
   * *inputs* to a resolution pass, not part of what the document means.
   * `\nocite` sites are here too, and print nothing.
   */
  citations: readonly CitationInline[];
  /**
   * The half of the two-pass cycle that only layout can close.
   *
   * `\pageref` cannot know its page until the document has been broken into
   * pages, and the page it lands on can depend on how wide the reference
   * prints — the same circularity LaTeX resolves with an `.aux` file and a
   * second run. Chunk 7 does the same: lay out once with every `\pageref`
   * still showing `??`, collect `marker name → page number` from the `Marker`
   * nodes it placed, call this, and lay out again. `ReferenceInline.text` is
   * mutable precisely so the second run re-reads it without the model being
   * rebuilt.
   *
   * Returns a diagnostic for every `\pageref` whose marker never appeared,
   * so a reference that would print `??` is never silent.
   */
  resolvePageNumbers(pages: ReadonlyMap<string, number>): Diagnostic[];
}

export function buildDocument(
  files: SourceFiles,
  entrypoint: string,
  options: BuildDocumentOptions = {},
): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const budget = createBudget(options.stepBudget ?? DEFAULT_STEP_BUDGET, options.signal ?? null);
  const st = createBuildState(entrypoint, diagnostics, budget);

  if (!Object.prototype.hasOwnProperty.call(files, entrypoint)) {
    diagnostics.push(error("missing-file", wholeFile(entrypoint), `\`${entrypoint}\` is not in the project`));
    return emptyResult(diagnostics, budget);
  }

  const parsed = parseLatex(files[entrypoint]!, entrypoint);
  for (const d of parsed.diagnostics) diagnostics.push(d);
  const included = resolveInputs(parsed.root, files, [entrypoint], st, 0);

  const expandCtx = createExpandContext(budget, diagnostics);
  const expanded = expandMacros(included, expandCtx);

  const { preamble, body, hasDocumentEnvironment } = splitDocument(expanded);
  // Guarded on `stopped`: once the budget has run out the tree is whatever
  // survived, and reporting a missing \documentclass because expansion never
  // reached it would bury the one diagnostic that explains the failure.
  if (!hasDocumentEnvironment && !budget.stopped) {
    diagnostics.push(
      error(
        "syntax",
        wholeFile(entrypoint),
        "no \\begin{document} — the whole file was treated as the document body",
      ),
    );
  }

  const strays = readPreamble(preamble, st);
  for (const block of walkBlocks(strays, st, DEFAULT_TEXT_STYLE)) {
    if (block.kind === "marker") continue;
    diagnostics.push(
      error("syntax", block.loc, "content before \\begin{document} is not typeset", "preamble"),
    );
  }
  if (st.documentClass === null && !budget.stopped) {
    diagnostics.push(
      error("syntax", wholeFile(entrypoint), "no \\documentclass — the engine implements \\documentclass{article}"),
    );
  }

  const blocks: Block[] = walkBlocks(body, st, DEFAULT_TEXT_STYLE);
  resolveReferences(st);
  resolveBibliography(files, st, budget);

  const document: LatexDocument = {
    documentClass: st.documentClass ?? "article",
    classOptions: st.classOptions,
    classLoc: st.classLoc,
    packages: st.packages,
    blocks,
    toc: st.toc,
    floatList: st.floatList,
    labels: st.labels,
    footnotes: st.footnotes,
  };

  return {
    document,
    diagnostics,
    steps: budget.spent,
    references: st.references,
    citations: st.citations,
    resolvePageNumbers: (pages) => applyPageNumbers(st, pages),
  };
}

function emptyResult(diagnostics: Diagnostic[], budget: Budget): BuildResult {
  return {
    document: {
      documentClass: "article",
      classOptions: "",
      classLoc: null,
      packages: [],
      blocks: [],
      toc: [],
      floatList: [],
      labels: new Map(),
      footnotes: [],
    },
    diagnostics,
    steps: budget.spent,
    references: [],
    citations: [],
    resolvePageNumbers: () => [],
  };
}

// --- \input ----------------------------------------------------------------

/**
 * Splice `\input`/`\include` files in, before macro expansion, so a definition
 * in an included file is in scope for the file that included it.
 *
 * Resolution is against the in-memory map and nothing else — there is no
 * filesystem to reach, which is the engine's entire security design rather
 * than a limitation (D38). A path that is not a key is a `missing-file`
 * diagnostic, so `\input{/etc/passwd}` is a diagnostic and not a read.
 */
function resolveInputs(
  nodes: readonly LatexNode[],
  files: SourceFiles,
  stack: readonly string[],
  st: BuildState,
  depth: number,
): LatexNode[] {
  if (depth > 64) {
    st.diagnostics.push(
      // A fixed structural ceiling, not the step budget — see the note on the
      // self-include below for why the distinction is load-bearing.
      error("limit-exceeded", wholeFile(stack[stack.length - 1] ?? ""), "\\input files nest more than 64 deep"),
    );
    return nodes.slice();
  }
  const out: LatexNode[] = [];
  for (const node of nodes) {
    if (!spend(st.budget)) {
      out.push(node);
      continue;
    }
    if (node.type === "command" && (node.name === "input" || node.name === "include")) {
      for (const produced of expandInput(node, files, stack, st, depth)) out.push(produced);
      continue;
    }
    switch (node.type) {
      case "environment":
        out.push({
          ...node,
          args: node.args.map((a) => ({ ...a, content: resolveInputs(a.content, files, stack, st, depth) })),
          body: resolveInputs(node.body, files, stack, st, depth),
        });
        break;
      case "group":
        out.push({ ...node, body: resolveInputs(node.body, files, stack, st, depth) });
        break;
      case "command":
        out.push(
          node.args.length === 0
            ? node
            : {
                ...node,
                args: node.args.map((a) => ({ ...a, content: resolveInputs(a.content, files, stack, st, depth) })),
              },
        );
        break;
      default:
        out.push(node);
    }
  }
  return out;
}

function expandInput(
  cmd: CommandNode,
  files: SourceFiles,
  stack: readonly string[],
  st: BuildState,
  depth: number,
): LatexNode[] {
  const at = cmd.loc.start;
  const arg = cmd.args.find((a) => a.bracket === "{");
  const requested = arg === undefined ? "" : plainText(arg.content).trim();
  if (requested.length === 0) {
    st.diagnostics.push(error("syntax", at, `\\${cmd.name} needs a file name`, `\\${cmd.name}`));
    return [];
  }
  const resolved = resolvePath(requested, files);
  if (resolved === null) {
    st.diagnostics.push(
      error(
        "missing-file",
        at,
        `\\${cmd.name}{${requested}} — no such file in the project (the engine reads only the files it was given)`,
        `\\${cmd.name}`,
      ),
    );
    return [];
  }
  if (stack.includes(resolved)) {
    st.diagnostics.push(
      // `syntax`, not `budget-exceeded`: a file that includes itself is a
      // malformed document, not an exhausted resource. The codes are what the
      // editor branches on and what the compile stages reason about — a
      // borrowed one reads as "the run ran out of steps", which is both wrong
      // for the writer and, until it was caught in review, able to make a
      // genuine budget exhaustion elsewhere report nothing at all.
      error("syntax", at, `\\${cmd.name}{${requested}} — \`${resolved}\` includes itself`, `\\${cmd.name}`),
    );
    return [];
  }
  const parsed = parseLatex(files[resolved]!, resolved);
  for (const d of parsed.diagnostics) st.diagnostics.push(d);
  const inner = resolveInputs(parsed.root, files, [...stack, resolved], st, depth + 1);
  if (cmd.name !== "include") return inner;
  // `\include` starts and ends a page, which is the only thing that separates
  // it from `\input` in a single-class engine.
  const eject = (): CommandNode => ({ type: "command", name: "clearpage", args: [], loc: cmd.loc });
  return [eject(), ...inner, eject()];
}

function resolvePath(requested: string, files: SourceFiles): string | null {
  const bare = requested.replace(/^\.\//, "");
  for (const candidate of [bare, `${bare}.tex`]) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
  }
  return null;
}

// --- preamble / body split --------------------------------------------------

function splitDocument(nodes: readonly LatexNode[]): {
  preamble: LatexNode[];
  body: LatexNode[];
  hasDocumentEnvironment: boolean;
} {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type === "environment" && node.name === "document") {
      // Anything after `\end{document}` is discarded by LaTeX too, and the
      // parser has already given it to us as siblings; leaving it out here is
      // not a silent drop, it is the documented meaning of `\end{document}`.
      return { preamble: nodes.slice(0, i), body: node.body, hasDocumentEnvironment: true };
    }
  }
  return { preamble: [], body: nodes.slice(), hasDocumentEnvironment: false };
}

// --- pass 2 -----------------------------------------------------------------

/**
 * The first half of the two-pass cycle: `\ref` needs only the label table,
 * which is complete once the whole document has been walked, so it resolves
 * here — forward references included. `\pageref` waits for layout.
 */
function resolveReferences(st: BuildState): void {
  for (const reference of st.references) {
    const info = st.labels.get(reference.key);
    if (info === undefined) {
      st.diagnostics.push(
        error(
          "undefined-reference",
          reference.loc,
          `\\${reference.refKind}{${reference.key}} — no \\label{${reference.key}} anywhere in the document; it prints as ${UNRESOLVED_REFERENCE}`,
          `\\${reference.refKind}`,
        ),
      );
      continue;
    }
    if (reference.refKind === "ref") reference.text = info.text;
  }
}

/**
 * The bibliography half of pass 2 (brief 39). Runs right after
 * `resolveReferences` and for the same reason: every key in the document is
 * known once the whole thing has been walked, and neither answer needs layout.
 *
 * The reference list is formatted *before* the citations are resolved, because
 * a numeric citation prints the entry's position in that list — the order is
 * the answer, so it has to exist first.
 *
 * Both halves are seams `doc/bib.ts` owns (chunk 39.5); this function is only
 * the order they run in and where their inputs come from.
 */
function resolveBibliography(files: SourceFiles, st: BuildState, budget: Budget): void {
  const ctx: BibContext = {
    files,
    citations: st.citations,
    diagnostics: st.diagnostics,
    budget,
    file: st.file,
  };
  for (const block of st.bibliographies) {
    // Re-read here rather than trusting what the block was built with: a
    // `\bibliographystyle` may be written *after* the `\bibliography` it
    // applies to, and in a real document usually is (it sits in the preamble
    // only by convention).
    block.style = st.bibliographyStyle;
    const formatted = formatBibliography(block, ctx);
    block.content.length = 0;
    for (const produced of formatted) block.content.push(produced);
  }
  resolveCitations(ctx);
}

function applyPageNumbers(st: BuildState, pages: ReadonlyMap<string, number>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const reference of st.references) {
    if (reference.refKind !== "pageref") continue;
    const info = st.labels.get(reference.key);
    if (info === undefined) continue; // already reported by `resolveReferences`
    const page = pages.get(info.marker);
    if (page === undefined) {
      diagnostics.push(
        error(
          "undefined-reference",
          reference.loc,
          `\\pageref{${reference.key}} — \\label{${reference.key}} was never placed on a page; it prints as ${UNRESOLVED_REFERENCE}`,
          "\\pageref",
        ),
      );
      continue;
    }
    reference.text = String(page);
  }
  return diagnostics;
}

export {
  DEFAULT_FLOAT_PLACEMENT,
  DEFAULT_TEXT_STYLE,
  UNRESOLVED_CITATION,
  UNRESOLVED_REFERENCE,
  HEADING_DEPTH,
  SECTION_NUMBER_DEPTH,
  captionMarker,
  cloneStyle,
  headingMarker,
  labelMarker,
} from "./model.ts";
export type {
  AbstractBlock,
  BibItem,
  BibliographyBlock,
  Block,
  CaptionBlock,
  CitationInline,
  CitationStyle,
  DocumentLength,
  FloatBlock,
  FloatClass,
  FloatListEntry,
  FloatPlacement,
  FloatPlacementLetter,
  FontSelection,
  FootnoteInline,
  HeadingBlock,
  HeadingLevel,
  ImageInline,
  ImageSizing,
  Inline,
  LabelInfo,
  LatexDocument,
  LengthRegister,
  ListOfBlock,
  LineBreakInline,
  ListBlock,
  ListItem,
  ListVariant,
  MarkerBlock,
  MarkerInline,
  PackageUse,
  PageBreakBlock,
  ParagraphBlock,
  ReferenceInline,
  SpaceInline,
  TableBlock,
  TableCell,
  TableColumn,
  TableColumnAlign,
  TableColumnSpec,
  TableRow,
  TableRule,
  TextInline,
  TextStyle,
  TieInline,
  TitleBlock,
  TocBlock,
  TocEntry,
  VerbatimBlock,
} from "./model.ts";
