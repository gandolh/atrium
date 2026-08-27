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

/**
 * A length as an `\includegraphics` key or a `p{...}` column writes it (brief
 * 39). Deliberately **unresolved**: the document layer knows what the source
 * asked for, and only the page design knows how many points `0.8\textwidth` or
 * `2em` come to. Resolving here would bake one page design into the model, and
 * the model is built once and laid out up to three times.
 */
export type DocumentLength =
  /** An absolute unit — `pt`, `bp`, `in`, `cm`, `mm`, `pc`, `sp` — already in points. */
  | { kind: "points"; value: number }
  /** `em`/`ex`: a multiple of the type size in force where the construct sits. */
  | { kind: "font"; value: number; unit: "em" | "ex" }
  /** `0.8\textwidth`: a multiple of one of LaTeX's page-dimension registers. */
  | { kind: "relative"; factor: number; of: LengthRegister };

/** The `\...width`/`\...height` registers the engine reads in a length. */
export type LengthRegister =
  | "textwidth"
  | "linewidth"
  | "columnwidth"
  | "textheight"
  | "paperwidth"
  | "paperheight";

/** The sizing keys of `\includegraphics[...]`, exactly as the source wrote them. */
export interface ImageSizing {
  /** `width=`. */
  width: DocumentLength | null;
  /** `height=`. */
  height: DocumentLength | null;
  /**
   * `scale=`, a plain multiplier of the image's intrinsic size. LaTeX lets
   * `scale` combine with nothing else; `width`/`height` win where both appear
   * and the clash is a diagnostic (`doc/build.ts`).
   */
  scale: number | null;
}

/**
 * `\includegraphics[...]{file}` — horizontal material, so an inline: it can sit
 * in a paragraph, and inside a `figure` it is a paragraph of its own.
 *
 * **No bytes here, and no intrinsic size.** The engine performs no I/O (D38):
 * the file arrives in `compile()`'s file map like every other input, and
 * decoding it is `src/image/`'s job at layout time (chunk 39.2). This node
 * carries only what the *source* said.
 */
export interface ImageInline extends InlineBase {
  kind: "image";
  /** The name as written, `\includegraphics{fig/plot}`'s `fig/plot` — no extension guessing here. */
  path: string;
  sizing: ImageSizing;
  /** The style in force, for a diagnostic that needs to name the surroundings. */
  style: TextStyle;
}

/** Which of the `\cite` family produced a citation — they print differently. */
export type CitationStyle =
  /** `\cite` — the bare label, `[1]`. */
  | "plain"
  /** `\citep` — parenthesised, natbib's numeric form of which is also `[1]`. */
  | "parenthetical"
  /** `\citet` — textual: `Author [1]`, which needs the entry's author. */
  | "textual"
  /** `\nocite` — sets nothing; the keys still enter the bibliography. */
  | "silent";

/**
 * `\cite{a,b}` and friends. `text` is **mutable on purpose**, exactly as
 * `ReferenceInline.text` is: it starts as `UNRESOLVED_CITATION` and the
 * bibliography pass fills it in once every key is known (`doc/bib.ts`, chunk
 * 39.5). Layout reads it at shaping time, so a later pass sees the rewrite.
 */
export interface CitationInline extends InlineBase {
  kind: "citation";
  style: CitationStyle;
  /** The command as written, `"\\citep"`, for diagnostics. */
  construct: string;
  /** The keys in `{a,b}`, in the order written, trimmed and non-empty. */
  keys: readonly string[];
  /** What prints. `[?]` until the bibliography resolves it — visible in the PDF, by design. */
  text: string;
  textStyle: TextStyle;
}

export type Inline =
  | TextInline
  | SpaceInline
  | TieInline
  | LineBreakInline
  | MarkerInline
  | ReferenceInline
  | FootnoteInline
  | ImageInline
  | CitationInline;

/** What `\ref`/`\pageref` prints until (or unless) it resolves. LaTeX's `??`. */
export const UNRESOLVED_REFERENCE = "??";

/**
 * What a `\cite` prints for a key no bibliography entry matched. Brief 39 asks
 * for this specifically: an unknown key is a diagnostic *and* a visible mark in
 * the PDF, so the problem cannot be missed by someone reading the output rather
 * than the log.
 */
export const UNRESOLVED_CITATION = "[?]";

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

// --- floats, captions and the lists of them (brief 39) ---------------------

/**
 * Which counter a float steps, which `\listof...` collects it, and which name
 * its caption is given. `figure` and `table` are the two `article` defines;
 * `\newfloat` and the `float` package are out of scope.
 */
export type FloatClass = "figure" | "table";

/** One letter of `[htbp]`. `!` is carried separately as `override`. */
export type FloatPlacementLetter = "h" | "t" | "b" | "p";

/**
 * `\begin{figure}[htbp]` — where the author will accept this float.
 *
 * Kept **as written**, duplicates removed, rather than normalised into flags:
 * LaTeX tries the positions in its own fixed order (here, top, bottom, page)
 * regardless of the order the letters appear in, so a placer wants the *set*,
 * while a diagnostic about a float that could not be placed wants to quote what
 * the author actually asked for. One field serves both; a bag of booleans
 * serves only the first.
 */
export interface FloatPlacement {
  letters: readonly FloatPlacementLetter[];
  /** `[!ht]` — ignore the class's aesthetic limits (`\topfraction` and friends). */
  override: boolean;
  /** False when no `[...]` was written at all, so the class default (`tbp`) applies. */
  explicit: boolean;
}

/** `article`'s `\fps@figure`/`\fps@table`: what a float with no `[...]` gets. */
export const DEFAULT_FLOAT_PLACEMENT: FloatPlacement = {
  letters: ["t", "b", "p"],
  override: false,
  explicit: false,
};

/**
 * A `figure`/`table` environment: content that does not belong at the point it
 * was written. **This block does not carry a position** — where it ends up is
 * the page builder's answer (`layout/float.ts`, chunk 39.4), which is the whole
 * meaning of the word float.
 */
export interface FloatBlock extends BlockBase {
  kind: "float";
  floatClass: FloatClass;
  /** The environment name as written, `figure*` included — the `construct` for diagnostics. */
  construct: string;
  /** The `*` form, which spans both columns. `article` here is one-column, but a placer must still know. */
  spanning: boolean;
  placement: FloatPlacement;
  /** The float's material in source order, captions among it — a caption's position is content. */
  content: Block[];
}

/**
 * `\caption{...}` inside a float. Only ever built *inside* a `FloatBlock.content`
 * (`doc/build.ts` refuses one anywhere else), because a caption's number comes
 * from the float's class and its setting is part of setting the float.
 */
export interface CaptionBlock extends BlockBase {
  kind: "caption";
  floatClass: FloatClass;
  /** `"3"` — `\thefigure`. Null only when the float class could not be established. */
  number: string | null;
  content: Inline[];
  /** Always present, so `\listoffigures` and `\pageref` can learn the caption's page. */
  marker: string;
}

/** `\listoffigures` / `\listoftables`. The entries live on the document. */
export interface ListOfBlock extends BlockBase {
  kind: "listof";
  floatClass: FloatClass;
}

/**
 * One line of a `\listoffigures`/`\listoftables` — the float equivalent of
 * `TocEntry`, and collected the same way: in document order as the captions are
 * built, whether or not the document asked for the list.
 */
export interface FloatListEntry {
  floatClass: FloatClass;
  /** `"3"`, or null when the caption could not be numbered. */
  number: string | null;
  /**
   * The caption's inlines — **the same array the caption sets**, not a copy, so
   * a `\ref` inside it resolves in both places at once. Layout must drop
   * occurrence-only inlines when it re-sets them; see `tocTitle` in
   * `layout/vlist.ts` for the bug that rule exists to prevent.
   */
  title: Inline[];
  /** The caption's marker; layout resolves it to a page number. */
  marker: string;
}

// --- tables (brief 39) ------------------------------------------------------

/** A `tabular` column's horizontal alignment. `paragraph` is `p{width}`. */
export type TableColumnAlign = "left" | "center" | "right" | "paragraph";

/** One entry of a `tabular` column specification. */
export interface TableColumn {
  align: TableColumnAlign;
  /** The `{width}` of a `p` column; null for `l`, `c` and `r`. */
  width: DocumentLength | null;
  /**
   * How many `|` rules were written immediately before this column. Two is
   * `||`, LaTeX's double rule; more is legal and rare.
   */
  rulesBefore: number;
}

/** A parsed `{|l|c|p{3cm}|}`. */
export interface TableColumnSpec {
  columns: readonly TableColumn[];
  /** `|`s after the last column, which belong to no column. */
  rulesAfter: number;
}

/**
 * `\hline` (the whole width) or `\cline{2-3}` (columns 2 to 3).
 *
 * `from`/`to` are 1-based and inclusive, and both null for an `\hline` — which
 * is not the same as `1-n`, because a `\cline` spanning every column still
 * draws only under the columns rather than across the table's own rules.
 */
export interface TableRule {
  from: number | null;
  to: number | null;
  loc: SourceRef;
}

/**
 * One cell. Content is `Inline[]`: a cell is horizontal material, and a `p{}`
 * column line-breaks it internally with the same breaker a paragraph uses.
 * Block content in a cell is a diagnostic rather than a nested column.
 */
export interface TableCell {
  content: Inline[];
  /** `\multicolumn{n}` — how many of the table's columns this cell occupies. 1 normally. */
  span: number;
  /** `\multicolumn`'s own one-column spec, which overrides the table's for this cell. */
  override: TableColumn | null;
  /** `\multicolumn`'s trailing `|`s, which override the table's for this cell's right edge. */
  overrideRulesAfter: number;
  loc: SourceRef;
}

export interface TableRow {
  cells: TableCell[];
  /** `\hline`s and `\cline`s written above this row, in the order written. */
  rulesAbove: TableRule[];
  loc: SourceRef;
}

/**
 * A `tabular`. **Parsed only** by chunk 39.1: the grid, the column spec and the
 * rules are here, and not one width has been measured — column measurement and
 * grid setting are `layout/table.ts`'s (chunk 39.3), because both need a shaper
 * and a measure the document layer must not know about.
 */
export interface TableBlock extends BlockBase {
  kind: "table";
  /** The environment name as written — `tabular` today. */
  construct: string;
  spec: TableColumnSpec;
  rows: TableRow[];
  /** `\hline`s and `\cline`s after the last row. */
  rulesBelow: TableRule[];
}

// --- bibliography (brief 39) ------------------------------------------------

/** One `\bibitem{key} text` of a `thebibliography` environment. */
export interface BibItem {
  key: string;
  /** `\bibitem[label]{key}`'s optional label; null for the numeric default. */
  label: Inline[] | null;
  content: Block[];
  loc: SourceRef;
}

/**
 * The reference list — from `\bibliography{refs}` (keys resolved out of `.bib`
 * files) or from a literal `thebibliography` environment.
 *
 * `content` is what actually gets set, and it is filled by `doc/bib.ts` (chunk
 * 39.5) out of ordinary blocks, so the vertical list needs no bibliography
 * layout of its own. It is empty until that chunk lands.
 */
export interface BibliographyBlock extends BlockBase {
  kind: "bibliography";
  /** `"\\bibliography"` or `"thebibliography"` — the `construct` for diagnostics. */
  construct: string;
  source: "bibfile" | "thebibliography";
  /** The names in `\bibliography{a,b}`, as written and without a `.bib` suffix. */
  bibFiles: readonly string[];
  /** `\bibliographystyle`'s argument, or null when the document gave none. */
  style: string | null;
  /** `\begin{thebibliography}{99}`'s widest-label argument; null for a `.bib` list. */
  widestLabel: string | null;
  /** The `\bibitem`s of a `thebibliography`, in source order. Empty for a `.bib` list. */
  entries: readonly BibItem[];
  /** The formatted list, filled by `doc/bib.ts`. Empty until chunk 39.5. */
  content: Block[];
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
  | MarkerBlock
  | FloatBlock
  | CaptionBlock
  | ListOfBlock
  | TableBlock
  | BibliographyBlock;

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
  /**
   * Every `\caption`, in document order, for `\listoffigures` and
   * `\listoftables` — one list for both classes, filtered by `floatClass`
   * where it is set, because the two lists are collected by the same code and
   * splitting them here would only move the filter.
   */
  floatList: FloatListEntry[];
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

/** The marker name emitted for the nth `\caption` (0-based). */
export function captionMarker(index: number): string {
  return `caption:${index}`;
}
