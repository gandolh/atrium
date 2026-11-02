import { z } from "zod";

/**
 * File validation for the convert flow — shared by apps/web (pre-upload
 * checks) and apps/api (server-side enforcement).
 *
 * Detection is extension/MIME only, no magic-byte sniffing (decisions.md
 * D13) — spoofing isn't a threat model for a personal, single-user tool.
 */

export const PDF_MIME_TYPES = ["application/pdf"] as const;
export const PDF_EXTENSIONS = [".pdf"] as const;

export const EPUB_MIME_TYPES = ["application/epub+zip"] as const;
export const EPUB_EXTENSIONS = [".epub"] as const;

// Media formats — what the native <audio>/<video> playback path
// supports (extends D12's "formats = what the playback/read path supports").
// Real browsers vary the MIME they attach: mp3 files often arrive as
// `audio/mp3`, MediaRecorder emits `audio/webm` for webm audio, and m4a-ish
// mp4 audio comes through as `audio/mp4` — so each table carries those variants.
export const MP3_MIME_TYPES = ["audio/mpeg", "audio/mp3"] as const;
export const MP3_EXTENSIONS = [".mp3"] as const;

export const MP4_MIME_TYPES = ["video/mp4", "audio/mp4"] as const;
export const MP4_EXTENSIONS = [".mp4"] as const;

export const WEBM_MIME_TYPES = ["video/webm", "audio/webm"] as const;
export const WEBM_EXTENSIONS = [".webm"] as const;

export const pdfMimeSchema = z.enum(PDF_MIME_TYPES);
export const epubMimeSchema = z.enum(EPUB_MIME_TYPES);

export type PdfMimeType = z.infer<typeof pdfMimeSchema>;
export type EpubMimeType = z.infer<typeof epubMimeSchema>;

/**
 * Every file format this app understands (D12, extended for media in the media library):
 * PDF/EPUB books plus MP3 audio and MP4/WebM video — the formats browsers play
 * natively (no transcoding). Detection stays extension/MIME only (D13).
 */
export const FILE_TYPES = ["pdf", "epub", "mp3", "mp4", "webm"] as const;
export const fileTypeSchema = z.enum(FILE_TYPES);
export type FileType = z.infer<typeof fileTypeSchema>;

/**
 * The kind of media a format is: a `book` (paged reader), `audio` (player), or
 * `video` (player). The gallery filters and the player/card rendering branch on
 * this; web consumes `kindForFormat` in later chunks.
 */
export const MEDIA_KINDS = ["book", "audio", "video"] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** Map a file format to its media kind (pdf/epub → book, mp3 → audio, mp4/webm → video). */
export function kindForFormat(format: FileType): MediaKind {
  switch (format) {
    case "mp3":
      return "audio";
    case "mp4":
    case "webm":
      return "video";
    default:
      return "book";
  }
}

/**
 * Default max upload size in bytes (50MB per D15). The API may override this
 * from `MAX_UPLOAD_MB` — callers should compute their own limit and pass it
 * to `isFileSizeValid` / `maxUploadBytesFromMb` rather than hardcoding this
 * constant everywhere.
 */
export const DEFAULT_MAX_UPLOAD_MB = 50;
export const BYTES_PER_MB = 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = DEFAULT_MAX_UPLOAD_MB * BYTES_PER_MB;

/** Convert a megabyte limit (e.g. from `MAX_UPLOAD_MB` env) to bytes. */
export function maxUploadBytesFromMb(maxUploadMb: number): number {
  return maxUploadMb * BYTES_PER_MB;
}

function getExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return name.slice(dotIndex).toLowerCase();
}

/**
 * The extension + MIME signals for each format, in match-priority order. The
 * table keeps `detectFileType` uniform as formats widen.
 */
const FORMAT_SIGNALS: {
  format: FileType;
  extensions: readonly string[];
  mimeTypes: readonly string[];
}[] = [
  { format: "pdf", extensions: PDF_EXTENSIONS, mimeTypes: PDF_MIME_TYPES },
  { format: "epub", extensions: EPUB_EXTENSIONS, mimeTypes: EPUB_MIME_TYPES },
  { format: "mp3", extensions: MP3_EXTENSIONS, mimeTypes: MP3_MIME_TYPES },
  { format: "mp4", extensions: MP4_EXTENSIONS, mimeTypes: MP4_MIME_TYPES },
  { format: "webm", extensions: WEBM_EXTENSIONS, mimeTypes: WEBM_MIME_TYPES },
];

/**
 * Classify a file as one of `FILE_TYPES` (pdf/epub/mp3/mp4/webm), or null, using
 * its name (extension) and, if provided, its MIME type. Detection is
 * extension/MIME only (D13).
 *
 * A KNOWN supported extension is authoritative: it classifies the file on its
 * own and a (possibly wrong/mislabelled) MIME can neither contradict it nor
 * reroute it to a different format — otherwise e.g. `movie.mp4` served with a
 * stray `audio/mpeg` would be stored/served/played as mp3. Only when the
 * extension is unknown or absent do we fall back to classifying by MIME alone.
 */
export function detectFileType(name: string, mime?: string): FileType | null {
  const ext = getExtension(name);
  const normalizedMime = mime?.toLowerCase();

  // A known supported extension wins outright — MIME can't override or reroute it.
  for (const { format, extensions } of FORMAT_SIGNALS) {
    if ((extensions as readonly string[]).includes(ext)) return format;
  }

  // Unknown/absent extension: fall back to MIME alone when it's conclusive.
  if (normalizedMime) {
    for (const { format, mimeTypes } of FORMAT_SIGNALS) {
      if ((mimeTypes as readonly string[]).includes(normalizedMime)) return format;
    }
  }

  return null;
}

/** Validate a file size (bytes) against a given limit (bytes, inclusive). */
export function isFileSizeValid(
  sizeBytes: number,
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): boolean {
  return sizeBytes >= 0 && sizeBytes <= maxBytes;
}
