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

/*
 * The auth contract is gone (2026-09-06). Atrium authenticates nobody: Ward
 * owns credentials, sessions and the one login page for the estate, so there is
 * no login request, no login response and no auth-status shape for the client
 * and the API to agree on. What replaced it is not a schema — it is the
 * `ward_session` cookie the browser already holds, validated server-side on
 * every request.
 *
 * The profile contract below **stays**, and stays atrium's: profiles are an
 * identity boundary inside one account and never a security one (D35), and Ward
 * does not know they exist.
 */

// --- Notes contract (brief 26; folders brief 50) ----------------------------
export {
  PAGE_ASPECT,
  NOTE_TOOLS,
  noteToolSchema,
  NOTE_NIBS,
  NOTE_TOOL_LABELS,
  STROKE_VB,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_SCALE,
  nibNoise,
  nibPasses,
  nibPassPoints,
  hasRealPressure,
  strokeNibPasses,
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
  MAX_FOLDER_NAME,
  noteFolderSchema,
  noteFolderListSchema,
  createNoteFolderSchema,
  updateNoteFolderSchema,
  moveNoteSchema,
} from "./notes.js";
export type {
  NoteTool,
  NoteNib,
  NibStrokeOptions,
  NibPass,
  PageTemplate,
  StrokePoint,
  Stroke,
  TextBox,
  NotePage,
  Note,
  NoteSummary,
  CreateNoteRequest,
  UpdateNoteRequest,
  NoteFolder,
  CreateNoteFolderRequest,
  UpdateNoteFolderRequest,
  MoveNoteRequest,
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

// --- LaTeX diagnostic + project/file/compile/version contract (briefs 37, 38) ---
export {
  DIAGNOSTIC_SEVERITIES,
  diagnosticSeveritySchema,
  DIAGNOSTIC_CODES,
  diagnosticCodeSchema,
  diagnosticSchema,
  COMPILE_STATUSES,
  compileStatusSchema,
  latexProjectSchema,
  latexFileSchema,
  latexCompileResultSchema,
  documentVersionSchema,
} from "./latex.js";
export type {
  DiagnosticSeverity,
  DiagnosticCode,
  Diagnostic,
  CompileStatus,
  LatexProject,
  LatexFile,
  LatexCompileResult,
  DocumentVersion,
} from "./latex.js";
