/**
 * `@ebook-reader/typeset` — Atrium's own typesetting engine (brief 37, D38).
 *
 * It reads a *subset* of LaTeX and writes a PDF. It is not a TeX
 * reimplementation and never will be: the scope line is syntax, not semantics,
 * and anything outside the subset produces a diagnostic rather than a guess.
 *
 * The package is a pure library — no filesystem, no network, no processes — so
 * it runs unchanged in Node and in a browser. `compile()` is the whole surface.
 */

export { compile, decodeUtf8, resolveCompileOptions, DEFAULT_COMPILE_OPTIONS } from "./compile.ts";
export type {
  AbortLike,
  CompileFn,
  CompileOptions,
  CompileResult,
  CompileStats,
  ResolvedCompileOptions,
} from "./compile.ts";

export {
  diagnostic,
  error,
  warning,
  info,
  unsupported,
  internalError,
  hasErrors,
  wholeFile,
} from "./diagnostics.ts";
export type { Diagnostic, DiagnosticCode, DiagnosticSeverity, SourceRef } from "./diagnostics.ts";

export { glue, kern, penalty, naturalSize, INFINITE_PENALTY, EJECT_PENALTY } from "./layout/model.ts";
export type {
  Discretionary,
  Glue,
  GlueOrder,
  GlueSet,
  GlyphNode,
  HBox,
  HList,
  HNode,
  Kern,
  Marker,
  Penalty,
  RuleNode,
  VBox,
  VList,
  VNode,
} from "./layout/model.ts";

export { buildPages } from "./layout/page.ts";
export type {
  GlyphRun,
  Page,
  PageBuildOptions,
  PageBuildResult,
  PlacedItem,
  PlacedRule,
} from "./layout/page.ts";

/** Page design: the sizes and dimensions `article.cls` would have supplied. */
export {
  HEADING_DESIGN,
  SIZE10,
  defaultDesign,
  documentDesign,
  itemizeLabel,
  listSpacing,
  parseDimension,
  tocIndent,
} from "./layout/design.ts";
export type { FontSize, ListSpacing, PageDesign, SizeLadder } from "./layout/design.ts";

/** Vertical-list assembly: the document model becomes one tall column. */
export { buildVerticalList, createLayoutContext, footnoteMarker } from "./layout/vlist.ts";
export type { LayoutContext, PreparedFootnote } from "./layout/vlist.ts";

export {
  LATIN_MODERN_FACE_IDS,
  createFontHandle,
  createLatinModernProvider,
  latinModernFaceId,
  scaleToPoints,
} from "./font/handle.ts";
export type {
  FontFamily,
  FontHandle,
  FontProvider,
  FontRequest,
  FontSlant,
  FontWeight,
  LatinModernBytes,
  LatinModernFaceId,
  PositionedGlyph,
  ShapedText,
} from "./font/handle.ts";

/**
 * The pipeline stages, in the order `compile()` runs them. Exported so a caller
 * can drive one stage alone — the golden tests do, and an editor could ask for
 * diagnostics without paying for layout.
 *
 * Named rather than `export *` on purpose: two chunks independently defined a
 * `TextStyle`, and a star re-export would have merged or shadowed them silently.
 * `layout`'s is now `TextFace` (a *resolved* handle at a size); `doc`'s stays
 * `TextStyle` (semantic — a `FontSelection` plus underline, deliberately no
 * size). Listing every name is what makes the next such collision a build error.
 */
export { parseLatex } from "./parse/index.ts";
export type { Argument, LatexNode, ParseResult, SourceSpan } from "./parse/index.ts";

export { buildDocument } from "./doc/index.ts";
export type { BuildDocumentOptions, BuildResult, SourceFiles } from "./doc/index.ts";
export {
  DEFAULT_TEXT_STYLE,
  HEADING_DEPTH,
  SECTION_NUMBER_DEPTH,
  UNRESOLVED_REFERENCE,
  cloneStyle,
  headingMarker,
  labelMarker,
} from "./doc/model.ts";
export type {
  AbstractBlock,
  Block,
  FontSelection,
  FootnoteInline,
  HeadingBlock,
  HeadingLevel,
  Inline,
  LabelInfo,
  LatexDocument,
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
  TextInline,
  TextStyle,
  TieInline,
  TitleBlock,
  TocBlock,
  TocEntry,
  VerbatimBlock,
} from "./doc/model.ts";

export { budgetDiagnostic, createBudget, spend } from "./macro/index.ts";
export type { Budget } from "./macro/index.ts";

/** Line breaking and glue setting. `model.ts`'s vocabulary is already exported above. */
export {
  AWFUL_BAD,
  DECENT_FIT,
  DEFAULT_LINE_BREAK_PARAMS,
  INF_BAD,
  LOOSE_FIT,
  TIGHT_FIT,
  VERY_LOOSE_FIT,
  addNodeExtent,
  badness,
  breakParagraph,
  cloneExtent,
  computeGlueSet,
  createEnglishHyphenator,
  createShaper,
  emptyDiscretionary,
  finishParagraph,
  fontSpacing,
  hpack,
  hyphenateHList,
  isFinished,
  measure,
  parFillSkip,
  paragraphIndent,
  setWidth,
  shapeRun,
  spaceGlue,
  textToHList,
  zeroExtent,
} from "./layout/index.ts";
export type {
  Extent,
  Fitness,
  FontSpacing,
  GlueSetting,
  HyphenateOptions,
  Hyphenator,
  LineBreak,
  LineBreakParams,
  LineBreakResult,
  LineWidths,
  PackReport,
  Shaper,
  TextFace,
  TextRunOptions,
} from "./layout/index.ts";

export { renderPdf } from "./pdf/index.ts";
export type { RenderPdfOptions, RenderPdfResult } from "./pdf/index.ts";
