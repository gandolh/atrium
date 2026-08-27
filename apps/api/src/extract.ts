import { basename, posix } from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { pdf } from "pdf-to-img";
import { parseBuffer } from "music-metadata";
import { kindForFormat, type FileType } from "@ebook-reader/shared";

/**
 * Server-side metadata + cover extraction (decisions.md D26).
 *
 * - EPUB: it's a ZIP. Read `META-INF/container.xml` → the OPF (package) doc →
 *   `<dc:title>` / `<dc:creator>` for metadata, all `<dc:subject>` tags, series
 *   info (`calibre:series`/`calibre:series_index` meta, else EPUB 3
 *   `belongs-to-collection` + `group-position`), and the manifest's cover image
 *   for the thumbnail (EPUB3 `properties="cover-image"`, else EPUB2
 *   `<meta name="cover">` → manifest id).
 * - PDF: render page 1 to a raster via `pdf-to-img` (bundled pdfjs + canvas,
 *   no system deps), and read the doc's Info `Title` / `Author` /
 *   `Subject` + `Keywords` (subjects). No series metadata in a PDF Info dict.
 * - Media (mp3/mp4/webm, brief 23): `music-metadata` `parseBuffer`. mp3 maps
 *   ID3 tags onto the book columns (artist→author, album→series, track→series
 *   index, genre→subjects) and normalizes embedded art to a SQUARE cover;
 *   mp4/webm yield `format.duration` plus any embedded `covr` art, normalized
 *   to its NATIVE aspect inside a 640px bound rather than cropped (brief 42).
 *   That is tag-embedded art only — server-side frame extraction still needs
 *   the ffmpeg binary, which stays declined (brief 23/D40); a video with no
 *   embedded art gets no cover from this path.
 *
 * Every path is best-effort: extraction never throws to the caller — a book
 * with no cover/metadata still gets stored (title falls back to the filename,
 * author to null, cover to null, series to null, subjects to [] → the UI shows
 * a typographic fallback tile).
 */

/** Book cover geometry — 2:3 portrait (design.md: book covers are 2:3). */
const COVER_WIDTH = 400;
const COVER_HEIGHT = 600;
/** Audio cover geometry — square (album art is 1:1, not a book spine). */
const AUDIO_COVER_SIZE = 400;
/** Video cover geometry — a bound, not a fixed size: native aspect shrinks to
 *  fit inside this box (see `toVideoThumbnail`). */
const VIDEO_COVER_BOUND = 640;
const COVER_QUALITY = 78;

export interface ExtractedMeta {
  title: string;
  author: string | null;
  /** Series name, or null when the file carries none. */
  series: string | null;
  /** Position within the series, or null when unknown. */
  seriesIndex: number | null;
  /** Subject/genre tags (trimmed + deduped); empty when none. */
  subjects: string[];
  /** JPEG thumbnail bytes, or null if no cover could be produced. */
  cover: Buffer | null;
  /** Playback length in seconds for audio/video, or null (books / unknown). */
  durationSeconds: number | null;
}

/** Normalize a cover image buffer to a JPEG thumbnail at the given geometry. */
async function toJpegThumbnail(
  image: Buffer,
  width: number,
  height: number,
): Promise<Buffer | null> {
  try {
    return await sharp(image)
      .resize(width, height, { fit: "cover", position: "top" })
      .jpeg({ quality: COVER_QUALITY })
      .toBuffer();
  } catch {
    return null; // corrupt/unsupported image → typographic fallback in UI
  }
}

/** Normalize a book cover to a 2:3 JPEG thumbnail. */
function toThumbnail(image: Buffer): Promise<Buffer | null> {
  return toJpegThumbnail(image, COVER_WIDTH, COVER_HEIGHT);
}

/** Normalize embedded album art to a centered square JPEG thumbnail. */
function toSquareThumbnail(image: Buffer): Promise<Buffer | null> {
  return sharp(image)
    .resize(AUDIO_COVER_SIZE, AUDIO_COVER_SIZE, { fit: "cover", position: "centre" })
    .jpeg({ quality: COVER_QUALITY })
    .toBuffer()
    .catch(() => null); // corrupt/unsupported art → typographic fallback in UI
}

/** Video cover geometry — native aspect, shrunk to fit a 640px bound (brief 42
 *  D40). Unlike audio's fixed SQUARE crop, a video frame's shape is arbitrary
 *  (a portrait poster, a 16:9 frame, ...); `CoverCard` already letterboxes
 *  artwork inside video's 4:3 box, so cropping it here to force a shape would
 *  just fight that. `fit: "inside"` shrinks to fit without cropping or
 *  upscaling.
 *
 *  Exported because `POST /library/:id/cover` (brief 42 step 3) re-encodes the
 *  browser-captured frame through this exact function rather than becoming a
 *  second definition of cover geometry. That re-encode is also what makes
 *  client-supplied bytes safe to store: EXIF, anything appended past the image
 *  data, and a payload that is not an image at all all die here — the last as
 *  the `null` this contract already returns. */
export function toVideoThumbnail(image: Buffer): Promise<Buffer | null> {
  return sharp(image)
    .resize(VIDEO_COVER_BOUND, VIDEO_COVER_BOUND, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: COVER_QUALITY })
    .toBuffer()
    .catch(() => null); // corrupt/unsupported art → typographic fallback in UI
}

/** Strip XML tags/entities from a captured text node. */
function decodeXmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => codePointOrRaw(m, Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec: string) => codePointOrRaw(m, Number.parseInt(dec, 10)))
    .trim();
}

/** `String.fromCodePoint` for a numeric character reference; an out-of-range or
 *  lone-surrogate code point leaves the raw `&#...;` text untouched rather than throwing. */
function codePointOrRaw(raw: string, codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return raw;
  }
}

/** One decoded double-quoted attribute's value from an already-matched tag's raw
 *  text — used AFTER a tag has been located, so attribute ORDER within the tag
 *  never matters (unlike a single regex that requires e.g. `name="..."` to
 *  appear before `content="..."`). */
function tagAttr(tagText: string, attr: string): string | null {
  return new RegExp(`\\b${attr}="([^"]*)"`, "i").exec(tagText)?.[1] ?? null;
}

/**
 * Find the first `<meta ...>` opening tag in `source` (order-independent — see
 * `tagAttr`) for which `matches` is true, then read `readAttr` off that same
 * tag text.
 */
function findMetaAttr(
  source: string,
  matches: (tagText: string) => boolean,
  readAttr: string,
): string | null {
  for (const m of source.matchAll(/<meta\b[^>]*>/gi)) {
    if (matches(m[0])) return tagAttr(m[0], readAttr);
  }
  return null;
}

/**
 * Find the first `<meta ...>...</meta>` element whose opening tag matches
 * `matches` (order-independent), then return its inner text, decoded. Used
 * for the EPUB3 `belongs-to-collection` refinement chain, whose value lives
 * in the element's text content rather than a `content` attribute.
 */
function findMetaText(source: string, matches: (tagText: string) => boolean): string | null {
  for (const m of source.matchAll(/<meta\b[^>]*>/gi)) {
    if (!matches(m[0])) continue;
    if (m[0].trimEnd().endsWith("/>")) return null; // self-closing: no text content
    const rest = source.slice((m.index ?? 0) + m[0].length);
    const close = /^([\s\S]*?)<\/meta>/.exec(rest);
    return close ? decodeXmlText(close[1]) : null;
  }
  return null;
}

function firstMatch(source: string, re: RegExp): string | null {
  const m = re.exec(source);
  return m?.[1] ? decodeXmlText(m[1]) : null;
}

/** Collect every capture-group-1 text for a global regex (decoded, non-empty). */
function allMatches(source: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(re)) {
    const text = m[1] ? decodeXmlText(m[1]) : "";
    if (text) out.push(text);
  }
  return out;
}

/** Trim, drop empties, and dedupe (first spelling wins) — for subject tags. */
function normalizeSubjects(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Parse a series index string (e.g. "2", "1.5") to a finite number, or null. */
function parseSeriesIndex(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// --- EPUB --------------------------------------------------------------------

function findOpfPath(zip: AdmZip): string | null {
  const container = zip.getEntry("META-INF/container.xml");
  if (!container) return null;
  const xml = container.getData().toString("utf8");
  return firstMatch(xml, /<rootfile[^>]*full-path="([^"]+)"/i);
}

/** Resolve a manifest href (relative to the OPF) to a zip entry path. */
function resolveHref(opfPath: string, href: string): string {
  const dir = posix.dirname(opfPath);
  const joined = dir === "." ? href : posix.join(dir, href);
  // Zip entries use forward slashes and no leading "./".
  return joined.replace(/^\.\//, "");
}

function findCoverHref(opf: string): string | null {
  // EPUB3: manifest item with properties="cover-image".
  const epub3 = /<item\b[^>]*\bproperties="[^"]*\bcover-image\b[^"]*"[^>]*>/i.exec(opf);
  if (epub3) {
    const href = /\bhref="([^"]+)"/i.exec(epub3[0]);
    if (href?.[1]) return href[1];
  }
  // EPUB2: <meta name="cover" content="<manifest-id>"> → item by id.
  const coverId = firstMatch(opf, /<meta\b[^>]*\bname="cover"[^>]*\bcontent="([^"]+)"/i);
  if (coverId) {
    const escaped = coverId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const item = new RegExp(`<item\\b[^>]*\\bid="${escaped}"[^>]*>`, "i").exec(opf);
    const href = item ? /\bhref="([^"]+)"/i.exec(item[0]) : null;
    if (href?.[1]) return href[1];
  }
  // Fallback: first image item in the manifest.
  const anyImage = /<item\b[^>]*\bmedia-type="image\/[^"]+"[^>]*>/i.exec(opf);
  if (anyImage) {
    const href = /\bhref="([^"]+)"/i.exec(anyImage[0]);
    if (href?.[1]) return href[1];
  }
  return null;
}

/**
 * Series name + index from the OPF. Prefers Calibre's own meta
 * (`calibre:series` + `calibre:series_index`); falls back to the EPUB 3
 * `belongs-to-collection` refinement chain (only when its `collection-type`
 * is "series"). Returns nulls when neither is present.
 */
function findSeries(opf: string): { series: string | null; seriesIndex: number | null } {
  // Calibre: <meta name="calibre:series" content="..."> (+ ..._index). Attribute
  // order within the tag is irrelevant — findMetaAttr matches the whole tag first.
  const calibreSeries = findMetaAttr(
    opf,
    (tag) => tagAttr(tag, "name") === "calibre:series",
    "content",
  );
  if (calibreSeries) {
    const idx = findMetaAttr(
      opf,
      (tag) => tagAttr(tag, "name") === "calibre:series_index",
      "content",
    );
    return { series: calibreSeries, seriesIndex: parseSeriesIndex(idx) };
  }

  // EPUB 3: <meta property="belongs-to-collection" id="c1">Name</meta>, with
  // a refining <meta refines="#c1" property="collection-type">series</meta>
  // and an optional <meta refines="#c1" property="group-position">N</meta>.
  for (const m of opf.matchAll(
    /<meta\b([^>]*)\bproperty="belongs-to-collection"([^>]*)>([\s\S]*?)<\/meta>/gi,
  )) {
    const attrs = `${m[1]} ${m[2]}`;
    const name = decodeXmlText(m[3] ?? "");
    if (!name) continue;
    const id = tagAttr(attrs, "id");
    if (!id) {
      // No id to refine against → accept the bare collection as a series.
      return { series: name, seriesIndex: null };
    }
    const type = findMetaText(
      opf,
      (tag) => tagAttr(tag, "refines") === `#${id}` && tagAttr(tag, "property") === "collection-type",
    );
    if (type && type.toLowerCase() !== "series") continue; // e.g. a "set"
    const position = findMetaText(
      opf,
      (tag) => tagAttr(tag, "refines") === `#${id}` && tagAttr(tag, "property") === "group-position",
    );
    return { series: name, seriesIndex: parseSeriesIndex(position) };
  }

  return { series: null, seriesIndex: null };
}

async function extractEpub(fileBytes: Buffer, fallbackTitle: string): Promise<ExtractedMeta> {
  let title = fallbackTitle;
  let author: string | null = null;
  let series: string | null = null;
  let seriesIndex: number | null = null;
  let subjects: string[] = [];
  let cover: Buffer | null = null;

  try {
    const zip = new AdmZip(fileBytes);
    const opfPath = findOpfPath(zip);
    if (opfPath) {
      const opfEntry = zip.getEntry(opfPath);
      const opf = opfEntry ? opfEntry.getData().toString("utf8") : "";
      title = firstMatch(opf, /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) ?? fallbackTitle;
      author = firstMatch(opf, /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
      subjects = normalizeSubjects(
        allMatches(opf, /<dc:subject[^>]*>([\s\S]*?)<\/dc:subject>/gi),
      );
      ({ series, seriesIndex } = findSeries(opf));

      const coverHref = findCoverHref(opf);
      if (coverHref) {
        const entry = zip.getEntry(resolveHref(opfPath, decodeURIComponent(coverHref)));
        if (entry) cover = await toThumbnail(entry.getData());
      }
    }
  } catch {
    // fall through with whatever we have
  }

  return { title, author, series, seriesIndex, subjects, cover, durationSeconds: null };
}

// --- PDF ---------------------------------------------------------------------

async function extractPdf(fileBytes: Buffer, fallbackTitle: string): Promise<ExtractedMeta> {
  let title = fallbackTitle;
  let author: string | null = null;
  let subjects: string[] = [];
  let cover: Buffer | null = null;

  try {
    // `pdf-to-img` wants a Uint8Array/Buffer; it exposes flat Info metadata
    // and lazy per-page rasters (bundled pdfjs + canvas, no system deps).
    const doc = await pdf(fileBytes, { scale: 1.5 });
    try {
      // The typed shape covers Title/Author only; Subject/Keywords pass through
      // the Info dict at runtime, so read them via an untyped view.
      const info = doc.metadata as Record<string, unknown> | undefined;
      const infoTitle = doc.metadata?.Title;
      if (typeof infoTitle === "string" && infoTitle.trim()) {
        title = infoTitle.trim();
      }
      const infoAuthor = doc.metadata?.Author;
      if (typeof infoAuthor === "string" && infoAuthor.trim()) {
        author = infoAuthor.trim();
      }
      // Subject is one line; Keywords is a comma/semicolon-separated list.
      const raw: string[] = [];
      const subject = info?.Subject;
      if (typeof subject === "string") raw.push(subject);
      const keywords = info?.Keywords;
      if (typeof keywords === "string") raw.push(...keywords.split(/[,;]/));
      subjects = normalizeSubjects(raw);

      const page1 = await doc.getPage(1);
      cover = await toThumbnail(page1);
    } finally {
      await doc.destroy();
    }
  } catch {
    // fall through — PDF still stored, no cover
  }

  // A PDF Info dict has no series concept.
  return { title, author, series: null, seriesIndex: null, subjects, cover, durationSeconds: null };
}

// --- Media (mp3 / mp4 / webm) ------------------------------------------------

/** Round a `format.duration` (seconds, fractional) to a finite number, or null. */
function normalizeDuration(raw: number | undefined): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * The MIME hint `music-metadata` needs to pick a parser. It must be the real
 * media type (`audio/mpeg`, not `application/mp3`) — an unrecognized hint makes
 * `parseBuffer` throw "Failed to determine audio format".
 */
const MEDIA_MIME: Partial<Record<FileType, string>> = {
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
};

/**
 * Metadata for an audio/video file via `music-metadata` (pure JS, no binary).
 *
 * - mp3: ID3 `title`, `artist`→author, `album`→series, `track.no`→seriesIndex,
 *   `genre`→subjects, and the first embedded picture normalized to a SQUARE
 *   cover — so the artist/album grouping (grouping.ts) works on music unchanged.
 * - mp4/webm: `format.duration`, plus the first embedded picture (a tagged
 *   file's `covr` atom), normalized to its NATIVE aspect inside a 640px bound
 *   instead of cropped to a square (brief 42/D40) — title/author/etc. stay
 *   filename-derived; mp4/webm carry no equivalent of ID3's text frames here.
 *   This is tag-embedded art only: server-side frame extraction still needs
 *   the ffmpeg binary, which stays declined (brief 23) — a video with no
 *   embedded art gets no cover from this path.
 *
 * Best-effort: a parse failure returns the filename title with everything else
 * null/empty, so a bad file never fails the upload.
 */
async function extractMedia(
  fileBytes: Buffer,
  format: FileType,
  fallbackTitle: string,
): Promise<ExtractedMeta> {
  let title = fallbackTitle;
  let author: string | null = null;
  let series: string | null = null;
  let seriesIndex: number | null = null;
  let subjects: string[] = [];
  let cover: Buffer | null = null;
  let durationSeconds: number | null = null;

  try {
    const metadata = await parseBuffer(fileBytes, { mimeType: MEDIA_MIME[format] });
    durationSeconds = normalizeDuration(metadata.format.duration);
    const common = metadata.common;

    // Only mp3 carries the ID3 text tags we map onto book columns; mp4/webm
    // keep title=filename and author/series/subjects null — but embedded
    // picture art (below) is read for BOTH, so a tagged video's `covr` atom
    // is no longer parsed and thrown away (brief 42/D40).
    if (format === "mp3") {
      const tagTitle = common.title?.trim();
      if (tagTitle) title = tagTitle;
      author = common.artist?.trim() || null;
      series = common.album?.trim() || null;
      seriesIndex =
        typeof common.track?.no === "number" && Number.isFinite(common.track.no)
          ? common.track.no
          : null;
      subjects = normalizeSubjects(common.genre ?? []);
    }

    const picture = common.picture?.[0];
    if (picture) {
      cover =
        format === "mp3"
          ? await toSquareThumbnail(Buffer.from(picture.data))
          : await toVideoThumbnail(Buffer.from(picture.data));
    }
  } catch {
    // Unparseable/corrupt media → keep the filename title, store with no cover.
  }

  return { title, author, series, seriesIndex, subjects, cover, durationSeconds };
}

// --- entry -------------------------------------------------------------------

/** Extract title/author/series/subjects/cover/duration for a stored file. Never throws. */
export async function extractMeta(
  fileBytes: Buffer,
  format: FileType,
  originalName: string,
): Promise<ExtractedMeta> {
  const fallbackTitle =
    basename(originalName)
      .replace(/\.(epub|pdf|mp3|mp4|webm)$/i, "")
      .trim() || originalName;

  switch (kindForFormat(format)) {
    case "book":
      return format === "epub"
        ? extractEpub(fileBytes, fallbackTitle)
        : extractPdf(fileBytes, fallbackTitle);
    case "audio":
    case "video":
      return extractMedia(fileBytes, format, fallbackTitle);
  }
}
