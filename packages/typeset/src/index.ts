/**
 * `@ebook-reader/typeset` — Atrium's own typesetting engine (brief 37, D38).
 *
 * It reads a *subset* of LaTeX and writes a PDF. It is not a TeX
 * reimplementation and never will be: the scope line is syntax, not semantics,
 * and anything outside the subset produces a diagnostic rather than a guess.
 *
 * The package is a pure library — no filesystem, no network, no processes — so
 * it runs unchanged in Node and in a browser.
 *
 * **`compile()` is the supported entry point**, and the only one a normal caller
 * needs. Everything below it is exported too — the box/glue vocabulary, the
 * parser, the document model, the line breaker, the PDF writer — so a caller can
 * drive one stage alone (the golden tests do, and an editor could ask for
 * diagnostics without paying for layout). Treat those as the engine's internals
 * made reachable, not as a stable API: they move when the engine moves.
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
  ImageNode,
  Kern,
  MathNode,
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
  PlacedImage,
  PlacedItem,
  PlacedMath,
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
  resolveDocumentLength,
  tocIndent,
} from "./layout/design.ts";
export type { FontSize, LengthContext, ListSpacing, PageDesign, SizeLadder } from "./layout/design.ts";

/** Vertical-list assembly: the document model becomes one tall column. */
export { buildVerticalList, createLayoutContext, floatMarker, footnoteMarker } from "./layout/vlist.ts";
export type { LayoutContext, PreparedFootnote } from "./layout/vlist.ts";

/**
 * Brief 39's remaining seams, each a stub a later chunk fills in: float
 * placement (39.4), table setting (39.3), and `.bib` parsing with the numeric
 * style (39.5). Exported so each chunk can drive its own seam from a test
 * without paying for a whole compile.
 */
/**
 * Mathematics (brief 40). `createMathRenderer` is what a caller builds and
 * hands to `compile()` through `CompileOptions.math`; it is exported from the
 * package root because a caller cannot obtain one any other way, and the
 * engine — which acquires nothing for itself — will not build one for them.
 *
 * The static import graph reaching this line is small: `math/bridge.ts` names
 * `mathjax` only in an `import type` and an `await import()`, so requiring
 * `@ebook-reader/typeset` still costs a caller who sets no mathematics nothing.
 */
export { createMathRenderer } from "./math/index.ts";
export type {
  MathGeometry,
  MathRenderer,
  MathRequest,
  MathResult,
  MathRun,
  MathViewBox,
} from "./math/index.ts";
/** Placing a rendered run: `ex` to points, the baseline, and the display skips. */
export { ABOVE_DISPLAY_SKIP, BELOW_DISPLAY_SKIP, exHeight, setDisplayMath, setMathRun } from "./layout/math.ts";
export type { DisplayMathContext, MathContext, SetDisplay } from "./layout/math.ts";

export { FLOAT_NAME, prepareFloat } from "./layout/float.ts";
export type { FloatContext, PreparedFloat } from "./layout/float.ts";
export { setTable } from "./layout/table.ts";
export type { TableContext } from "./layout/table.ts";
/**
 * Images (chunk 39.2, landed). `decodeImage` and `imageStream` are the two
 * halves — bytes to an intrinsic size, and that size to a PDF `XObject`
 * description — and both are exported because they are separately testable and
 * separately useful: a caller can ask how big a figure is without laying out a
 * document.
 */
export {
  decodeImage,
  imageStream,
  placeImage,
  placedImageSize,
  resolveImageFile,
  unfilterScanlines,
} from "./image/index.ts";
export type {
  DecodedImage,
  ImageColorSpace,
  ImageContext,
  ImageFiles,
  ImageFormat,
  ImageStream,
  Inflate,
  PngPredictor,
  ResolvedImageFile,
} from "./image/index.ts";
export { IMPLEMENTED_BIB_STYLE, formatBibliography, resolveCitations } from "./doc/bib.ts";
export type { BibContext, BibFiles } from "./doc/bib.ts";

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
  DEFAULT_FLOAT_PLACEMENT,
  DEFAULT_TEXT_STYLE,
  HEADING_DEPTH,
  SECTION_NUMBER_DEPTH,
  UNRESOLVED_CITATION,
  UNRESOLVED_REFERENCE,
  captionMarker,
  cloneStyle,
  equationMarker,
  headingMarker,
  isMultiLineDisplay,
  isNumberedDisplay,
  checkDisplayOverrun,
  labelMarker,
  setEquationNumber,
  unimplementedMathSeam,
} from "./doc/model.ts";
export type {
  AbstractBlock,
  BibItem,
  BibliographyBlock,
  Block,
  CaptionBlock,
  CitationInline,
  CitationStyle,
  DisplayMathBlock,
  DisplayMathVariant,
  DocumentLength,
  EquationNumberSetter,
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
  LineBreakInline,
  ListBlock,
  ListItem,
  ListOfBlock,
  ListVariant,
  MarkerBlock,
  MarkerInline,
  DisplayOverrunCheck,
  MathInline,
  MathLine,
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
