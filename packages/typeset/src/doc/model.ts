import type { SourceRef } from "../diagnostics.ts";
import type { FontFamily, FontSlant, FontWeight } from "../font/handle.ts";

/**
 * The document model (brief 37, chunk 6): what the source *means*, after macro
 * expansion, counter assignment and reference resolution — and the last stage
 * that still knows about LaTeX. Everything downstream (chunk 7's line breaking
 * and page building) reads this and never touches the parse AST again.
 *
 * The split that matters is **block vs inline**. A block starts on a new
 * vertical position and owns its own line breaking; an inline is horizontal
 * material inside a block. Chunk 7 turns each block's `Inline[]` into an HList
 * and each block into VList entries.
 *
 * Inlines are a **flat list, not a tree**: `\textbf{a \emph{b}}` becomes two
 * text inlines carrying resolved styles rather than nested wrapper nodes.
 * Nesting would force the line breaker to walk a tree while it is already
 * walking a list, and every style LaTeX can express in text mode is a *point*
 * property (which face, underlined or not), so resolving it at build time
 * loses nothing.
 */

/**
 * Which face a run of text wants, in document terms. Structurally identical to
 * `FontRequest` in `font/handle.ts` — deliberately so: chunk 7 passes
 * `style.font` straight to `FontProvider.get()`. It is redeclared here rather
 * than imported as `FontRequest` so the document model does not depend on the
 * font seam's module, only on its vocabulary.
 *
 * Point *size* is not here. Size is a page-design decision (how big is a
 * `\section` heading, how small is a footnote), and chunk 7 owns page design;
 * a block's semantic `kind`/`level` is what it derives size from.
 */
export interface FontSelection {
  family: FontFamily;
  weight: FontWeight;
  slant: FontSlant;
}

/** Everything about how a run of text is set, beyond its characters. */
export interface TextStyle {
  font: FontSelection;
  /**
   * `\underline`. A rule under the run rather than a face, so it rides beside
   * the font selection instead of inside it.
   */
  underline: boolean;
}

/** The document's ground state: upright regular serif, not underlined. */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: { family: "serif", weight: "regular", slant: "upright" },
  underline: false,
};

export function cloneStyle(style: TextStyle): TextStyle {
  return { font: { ...style.font }, underline: style.underline };
}

// --- inlines ---------------------------------------------------------------

interface InlineBase {
  /** Where this material starts in the source. Only `start` — see `SourceSpan`. */
  loc: SourceRef;
}

/** A run of literal characters, already ligature- and quote-translated. */
export interface TextInline extends InlineBase {
  kind: "text";
  text: string;
  style: TextStyle;
}

/** Ordinary inter-word space: a break opportunity that may stretch. */
export interface SpaceInline extends InlineBase {
  kind: "space";
  style: TextStyle;
}

/** `~` — a space that is *not* a break opportunity. */
export interface TieInline extends InlineBase {
  kind: "tie";
  style: TextStyle;
}

/** `\\` — end this line here and start another inside the same block. */
export interface LineBreakInline extends InlineBase {
  kind: "linebreak";
}

/**
 * A named position chunk 7 must record the page of. Emitted at every `\label`
 * and at every heading, and consumed by `BuildResult.resolvePageNumbers` —
 * this is the half of the two-pass cycle that crosses into layout. Maps onto
 * the layout model's `Marker` node one-for-one.
 */
export interface MarkerInline extends InlineBase {
  kind: "marker";
  name: string;
}

/**
 * `\ref` or `\pageref`. `text` is what gets set, and it is **mutable on
 * purpose**: it starts as `UNRESOLVED_REFERENCE`, pass 2 fills in `\ref`, and
 * `resolvePageNumbers` fills in `\pageref` after a layout pass. Chunk 7 reads
 * `text` at shaping time, so re-running layout re-reads whatever is current.
 */
export interface ReferenceInline extends InlineBase {
  kind: "reference";
  refKind: "ref" | "pageref";
  key: string;
  text: string;
  style: TextStyle;
}

/**
 * `\footnote`. The mark (`label`) is set where this sits; `content` belongs at
 * the bottom of whatever page the mark lands on, which only chunk 7 knows.
 */
export interface FootnoteInline extends InlineBase {
  kind: "footnote";
  number: number;
  /** The mark as it prints, e.g. `"1"`. */
  label: string;
  content: Block[];
  /** The style in force where the mark sits; the mark is set in it, raised. */
  style: TextStyle;
}

export type Inline =
  | TextInline
  | SpaceInline
  | TieInline
  | LineBreakInline
  | MarkerInline
  | ReferenceInline
  | FootnoteInline;

/** What `\ref`/`\pageref` prints until (or unless) it resolves. LaTeX's `??`. */
export const UNRESOLVED_REFERENCE = "??";

// --- blocks ----------------------------------------------------------------

/** Sectioning depth. `paragraph` is a run-in heading, not a paragraph of text. */
export type HeadingLevel = "section" | "subsection" | "subsubsection" | "paragraph";

/** Depth of each level, matching LaTeX's `\@startsection` levels for `article`. */
export const HEADING_DEPTH: Readonly<Record<HeadingLevel, number>> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
};

/**
 * `article`'s `secnumdepth`/`tocdepth`. Levels deeper than this are neither
 * numbered nor listed in the ToC — which is why `\paragraph` has no number in
 * a real LaTeX article either.
 */
export const SECTION_NUMBER_DEPTH = 3;

interface BlockBase {
  loc: SourceRef;
}

export interface ParagraphBlock extends BlockBase {
  kind: "paragraph";
  content: Inline[];
  /** False after `\noindent`, and for the first paragraph after a heading. */
  indent: boolean;
}

export interface HeadingBlock extends BlockBase {
  kind: "heading";
  level: HeadingLevel;
  /** `"2.1"`, or `null` for a `*` variant or a level past `SECTION_NUMBER_DEPTH`. */
  number: string | null;
  title: Inline[];
  /** Always present, so the ToC can learn this heading's page. */
  marker: string;
}

export type ListVariant = "itemize" | "enumerate" | "description";

export interface ListItem {
  /**
   * What prints in the margin. `null` for `itemize` — the bullet glyph is a
   * page-design choice and chunk 7 picks it from `ListBlock.depth`. For
   * `enumerate` it is the formatted counter (`"1."`, `"(a)"`); for
   * `description` it is the `\item[...]` term.
   */
  label: Inline[] | null;
  content: Block[];
  loc: SourceRef;
}

export interface ListBlock extends BlockBase {
  kind: "list";
  variant: ListVariant;
  /**
   * How many lists of *any* kind enclose this one, counting itself. Drives
   * indentation.
   */
  depth: number;
  /**
   * How many lists *of the same variant* enclose this one, counting itself —
   * which is not the same number, and is the one LaTeX's labels key off.
   * `\begin{itemize}\item\begin{enumerate}` numbers `1.`, not `(a)`, because
   * `\@enumdepth` counts only `enumerate`s. Chunk 7 picks an `itemize` bullet
   * from this, not from `depth`.
   */
  variantDepth: number;
  items: ListItem[];
}

/** `verbatim` and `\verb`'s block form: lines set literally, no line breaking. */
export interface VerbatimBlock extends BlockBase {
  kind: "verbatim";
  lines: string[];
}

export interface AbstractBlock extends BlockBase {
  kind: "abstract";
  content: Block[];
}

/** `\maketitle`, with `\title`/`\author`/`\date` already collected. */
export interface TitleBlock extends BlockBase {
  kind: "title";
  title: Inline[];
  author: Inline[];
  /** `null` when the document gave no `\date`: the engine has no clock (D38). */
  date: Inline[] | null;
}

/** `\tableofcontents`. The entries live on the document, filled as it is built. */
export interface TocBlock extends BlockBase {
  kind: "toc";
}

/** `\newpage`, `\clearpage`, `\pagebreak`. */
export interface PageBreakBlock extends BlockBase {
  kind: "pagebreak";
}

/** A `\label` that landed between paragraphs rather than inside one. */
export interface MarkerBlock extends BlockBase {
  kind: "marker";
  name: string;
}

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | VerbatimBlock
  | AbstractBlock
  | TitleBlock
  | TocBlock
  | PageBreakBlock
  | MarkerBlock;

// --- the document ----------------------------------------------------------

export interface TocEntry {
  level: HeadingLevel;
  number: string | null;
  title: Inline[];
  /** The heading's marker; chunk 7 resolves it to a page number. */
  marker: string;
}

export interface PackageUse {
  name: string;
  /** The raw `[...]` text, unparsed — `geometry`'s options are chunk 7's to read. */
  options: string;
  loc: SourceRef;
}

export interface LabelInfo {
  key: string;
  /** What `\ref` to this key prints: `"2.1"`, `"3"` for a list item, `"1"` for a footnote. */
  text: string;
  /** The marker name emitted at the label's position; `\pageref` resolves through it. */
  marker: string;
  loc: SourceRef;
}

export interface LatexDocument {
  /** From `\documentclass`; only `article` is implemented. */
  documentClass: string;
  /** The raw `[...]` text of `\documentclass`, unparsed. */
  classOptions: string;
  /**
   * Where the `\documentclass` line is, so a complaint about a class option
   * points at the line the author wrote — `PackageUse.loc` is the same field
   * for `\usepackage`, and the two are read side by side when the page design
   * is worked out. `null` only when the document has no `\documentclass` at
   * all, which is itself an error and leaves no options to complain about.
   */
  classLoc: SourceRef | null;
  packages: PackageUse[];
  blocks: Block[];
  /** In document order, whether or not a `\tableofcontents` asked for them. */
  toc: TocEntry[];
  labels: ReadonlyMap<string, LabelInfo>;
  /** Every footnote in document order, for callers that want them without a walk. */
  footnotes: FootnoteInline[];
}

/** The marker name emitted for `\label{key}`. Chunk 7 only needs it to be a string. */
export function labelMarker(key: string): string {
  return `label:${key}`;
}

/** The marker name emitted for the nth heading (0-based). */
export function headingMarker(index: number): string {
  return `heading:${index}`;
}
