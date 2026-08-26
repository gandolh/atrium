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

export { compile, resolveCompileOptions, DEFAULT_COMPILE_OPTIONS } from "./compile.ts";
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

export type { GlyphRun, Page, PlacedItem, PlacedRule } from "./layout/page.ts";

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
