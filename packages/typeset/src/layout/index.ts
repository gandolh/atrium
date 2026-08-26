/**
 * The layout stage: box-and-glue lists in, packed lines out.
 *
 * One import for everything the stages above need. `model.ts` is the shared
 * vocabulary (chunk 1), `page.ts` the positioned output the page builder
 * produces; the rest of this barrel is line breaking and glue setting.
 */

export {
  INF_BAD,
  AWFUL_BAD,
  badness,
  computeGlueSet,
  hpack,
  measure,
  setWidth,
  zeroExtent,
  cloneExtent,
  addNodeExtent,
} from "./glue.ts";
export type { Extent, GlueSetting, PackReport } from "./glue.ts";

export {
  createShaper,
  emptyDiscretionary,
  finishParagraph,
  fontSpacing,
  isFinished,
  parFillSkip,
  paragraphIndent,
  shapeRun,
  spaceGlue,
  textToHList,
} from "./hlist.ts";
export type { FontSpacing, Shaper, TextRunOptions, TextFace } from "./hlist.ts";

export { createEnglishHyphenator, hyphenateHList } from "./hyphenate.ts";
export type { Hyphenator, HyphenateOptions } from "./hyphenate.ts";

export {
  DECENT_FIT,
  DEFAULT_LINE_BREAK_PARAMS,
  FITNESS_NAMES,
  LOOSE_FIT,
  TIGHT_FIT,
  VERY_LOOSE_FIT,
  breakParagraph,
} from "./linebreak.ts";
export type { Fitness, LineBreak, LineBreakParams, LineBreakResult, LineWidths } from "./linebreak.ts";

export {
  HEADING_DESIGN,
  SIZE10,
  defaultDesign,
  documentDesign,
  itemizeLabel,
  listSpacing,
  parseDimension,
  tocIndent,
} from "./design.ts";
export type { FontSize, ListSpacing, PageDesign, SizeLadder } from "./design.ts";

export { buildVerticalList, createLayoutContext, footnoteMarker } from "./vlist.ts";
export type { LayoutContext, PreparedFootnote } from "./vlist.ts";

export { buildPages } from "./page.ts";
export type { GlyphRun, Page, PageBuildOptions, PageBuildResult, PlacedItem, PlacedRule } from "./page.ts";

export { EJECT_PENALTY, INFINITE_PENALTY, glue, kern, naturalSize, penalty } from "./model.ts";
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
} from "./model.ts";
