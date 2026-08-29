import type { MediaKind } from "@ebook-reader/shared";

import { coverInitial, coverInitialVariant } from "../lib/cover-initial-variant";

/**
 * The typographic fallback tile for a missing cover: title set in Newsreader
 * over whatever ground is behind it. Deliberately paints no background of its
 * own (brief 29) — the caller supplies the ground, which for `CoverCard` is
 * the tile's `bg-tint-{kind}` (design.md "Kind tints"), so a coverless tile
 * still reads by kind once every badge is stripped. `/discover`'s
 * `CatalogResultCard` (not a tinted tile) supplies its own neutral ground
 * instead. Extracted from `CoverCard` (brief 22); brief 25 makes the glyph
 * media-aware (music note / play / book) so a coverless music or video tile
 * no longer shows a book icon.
 *
 * Brief 43/D42 makes coverless tiles tell each other apart: a large, very
 * low-contrast **title initial** bleeding past an edge, whose size and corner
 * vary by a hash of the title (`coverInitialVariant`). Both axes live on the
 * letterform, never on the ground — D42's original second axis was the tile's
 * own lightness, and that was measured and rejected because Reading Room's
 * kind tints are near-achromatic, so any usable lightness ladder swamps the
 * kind signal D33 rests on. See `cover-initial-variant.ts` for the numbers.
 * Because the ground is untouched, this component's "paints no background of
 * its own" contract (brief 29) still holds, and D33's tint test passes by
 * construction — which also means `/discover`'s `CatalogResultCard`, on its
 * neutral ground, is unaffected beyond gaining the same initial.
 */
export function CoverFallback({ title, kind = "book" }: { title: string; kind?: MediaKind }) {
  const Glyph = kind === "audio" ? NoteGlyph : kind === "video" ? PlayGlyph : BookGlyph;
  return (
    <span className="relative flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden px-4 text-center">
      {/* The decorative title initial (design.md Typography, `tile-initial`).
          `aria-hidden`: it is pure texture, and the real title sits right
          below it for assistive tech. `text-ink/10` is the same "barely
          there" wash the progress-bar track already uses, so contrast stays
          low in all three themes without a bespoke per-theme value.

          **No negative z-index.** It shipped with `-z-10`, which put it behind
          the *caller's* tinted ground — `CoverCard` paints `bg-tint-{kind}` on
          an ancestor — so the letter rendered underneath the tile and was
          invisible in every theme. It is positioned and comes first in DOM
          order; the glyph and title below are `relative`, which is what keeps
          them painting over it without pushing this one behind the ground. */}
      <span
        aria-hidden
        className={`font-display text-ink/10 pointer-events-none absolute leading-none font-medium select-none ${coverInitialVariant(title)}`}
      >
        {coverInitial(title)}
      </span>
      <Glyph className="relative h-8 w-8 text-ink-variant/60" />
      <span className="font-display relative text-lg leading-tight font-semibold text-ink">{title}</span>
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
