/**
 * PDF emission. `renderPdf` is the whole surface; everything else here exists
 * because it has a test or because a caller needs the type.
 *
 * Not re-exported from the package root by this module — `src/index.ts` is
 * owned by the integration step, which wires the chunks together.
 */
export { renderPdf } from "./render.ts";
export type { RenderPdfOptions, RenderPdfResult } from "./render.ts";
