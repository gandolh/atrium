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
