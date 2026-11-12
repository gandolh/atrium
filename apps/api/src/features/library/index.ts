// The library's public surface: its routes; the book calls the catalog, lookup and LaTeX features make; and the
// start-up checks and sweeps server.ts runs.
export { libraryRoutes } from "./routes.js";
export { toLibraryBook } from "./mapper.js";
export { deleteBookWithArtifacts, getBookForProfile, setBookCover, updateBookMetadataFields } from "./service.js";
export { extractMeta } from "./extract.service.js";
export { isCalibreAvailable } from "./calibre.service.js";
export { cancelAllConverts, sweepInterruptedOutputs } from "./convert.service.js";
export { backfillLibraryMetadata, sweepOrphanThumbnails } from "./library-maintenance.service.js";
