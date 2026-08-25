import { z } from "zod";

/**
 * @ebook-reader/shared — single source of truth for the convert contract +
 * file validation, imported by both apps/web and apps/api so they can't
 * drift (decisions.md D11).
 */

// --- Format enum (kept from the original scaffold; apps/web and apps/api
// import these directly, so the names/shape stay stable) -------------------
export const SUPPORTED_FORMATS = ["pdf", "epub"] as const;

export const formatSchema = z.enum(SUPPORTED_FORMATS);
export type Format = z.infer<typeof formatSchema>;

// --- File validation ---------------------------------------------------
export {
  PDF_MIME_TYPES,
  PDF_EXTENSIONS,
  EPUB_MIME_TYPES,
  EPUB_EXTENSIONS,
  MP3_MIME_TYPES,
  MP3_EXTENSIONS,
  MP4_MIME_TYPES,
  MP4_EXTENSIONS,
  WEBM_MIME_TYPES,
  WEBM_EXTENSIONS,
  pdfMimeSchema,
  epubMimeSchema,
  FILE_TYPES,
  fileTypeSchema,
  MEDIA_KINDS,
  mediaKindSchema,
  kindForFormat,
  DEFAULT_MAX_UPLOAD_MB,
  BYTES_PER_MB,
  DEFAULT_MAX_UPLOAD_BYTES,
  maxUploadBytesFromMb,
  detectFileType,
  isFileSizeValid,
} from "./file-validation.js";
export type { PdfMimeType, EpubMimeType, FileType, MediaKind } from "./file-validation.js";

// --- Library book contract (D24) ------------------------------------------
export {
  libraryBookSchema,
  libraryListSchema,
  updateProgressSchema,
  LIBRARY_SORTS,
  librarySortSchema,
  LIBRARY_GROUPS,
  libraryGroupSchema,
  BOOK_SOURCES,
  bookSourceSchema,
  CONVERT_STATUSES,
  convertStatusSchema,
  convertTargetForFormat,
} from "./library-book.js";
export type {
  LibraryBook,
  UpdateProgressRequest,
  LibrarySort,
  LibraryGroup,
  BookSource,
  ConvertStatus,
} from "./library-book.js";

// --- Catalog contract (brief 22) ------------------------------------------
export {
  CATALOG_SORTS,
  catalogSortSchema,
  catalogSearchParamsSchema,
  catalogBookSchema,
  catalogSearchResponseSchema,
  importRequestSchema,
} from "./catalog.js";
export type {
  CatalogSort,
  CatalogSearchParams,
  CatalogBook,
  CatalogSearchResponse,
  ImportRequest,
} from "./catalog.js";

// --- Auth contract (brief 09) ----------------------------------------------
export {
  loginRequestSchema,
  loginResponseSchema,
  authStatusSchema,
} from "./auth.js";
export type { LoginRequest, LoginResponse, AuthStatus } from "./auth.js";

// --- Notes contract (brief 26) ---------------------------------------------
export {
  PAGE_ASPECT,
  NOTE_TOOLS,
  noteToolSchema,
  PAGE_TEMPLATES,
  pageTemplateSchema,
  strokePointSchema,
  strokeSchema,
  textBoxSchema,
  notePageSchema,
  noteSchema,
  noteSummarySchema,
  noteListSchema,
  createNoteSchema,
  updateNoteSchema,
} from "./notes.js";
export type {
  NoteTool,
  PageTemplate,
  StrokePoint,
  Stroke,
  TextBox,
  NotePage,
  Note,
  NoteSummary,
  CreateNoteRequest,
  UpdateNoteRequest,
} from "./notes.js";

// --- Profile contract (brief 35) -------------------------------------------
export {
  PROFILE_COLORS,
  profileColorSchema,
  MAX_PROFILES_PER_ACCOUNT,
  profileSchema,
  profileListSchema,
  createProfileSchema,
  updateProfileSchema,
  fontSettingsSchema,
  preferencesSchema,
} from "./profile.js";
export type {
  ProfileColor,
  Profile,
  CreateProfileRequest,
  UpdateProfileRequest,
  FontSettingsPreference,
  Preferences,
} from "./profile.js";
