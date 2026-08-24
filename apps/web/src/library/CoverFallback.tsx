import type { MediaKind } from "@ebook-reader/shared";

/**
 * The typographic fallback tile for a missing cover: a tinted `paper-container`
 * ground with the title set in Newsreader. Extracted from `CoverCard` (brief 22)
 * so `/discover` cards reuse the identical treatment; brief 25 makes the glyph
 * media-aware (music note / play / book) so a coverless music or video tile no
 * longer shows a book icon.
 */
export function CoverFallback({ title, kind = "book" }: { title: string; kind?: MediaKind }) {
  const Glyph = kind === "audio" ? NoteGlyph : kind === "video" ? PlayGlyph : BookGlyph;
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
      <Glyph className="h-8 w-8 text-ink-variant/50" />
      <span className="font-display text-lg leading-tight font-semibold text-ink">{title}</span>
    </span>
  );
}

function BookGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12v16H5.5A1.5 1.5 0 0 0 4 20.5z" strokeLinejoin="round" />
      <path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H12v16h6.5a1.5 1.5 0 0 1 1.5 1.5z" strokeLinejoin="round" />
    </svg>
  );
}

function NoteGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V6l11-2v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}

function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path strokeLinejoin="round" d="M11 9.5v5l4-2.5z" fill="currentColor" />
    </svg>
  );
}
