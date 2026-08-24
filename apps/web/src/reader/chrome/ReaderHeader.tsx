import { MOTION_MS } from "../../lib/motion";

/**
 * Running orientation header — the top row of BOTH readers' 3-row grid
 * (wiki/reader.md: "orientation lives at the edges"). Extracted from the EPUB
 * reader (chunk 14) so PDF and EPUB present the SAME frame: same treatment,
 * same fade, so only the page content differs.
 *
 * In-flow (not overlaid): it keeps its grid row so the content column never
 * shifts when the chrome fades. Purely decorative — `aria-hidden` and
 * non-interactive; the real title/nav live in the toolbar and page.
 */
export function ReaderHeader({
  title,
  detail,
  visible,
}: {
  /** Left slot — the book title (best-effort; blank renders gracefully). */
  title?: string | null;
  /** Right slot — the running location (EPUB chapter / PDF section). */
  detail?: string | null;
  /** Fades WITH the chrome, matching the toolbar/rail auto-hide. */
  visible: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none flex items-baseline justify-between gap-6 px-6 py-2.5 text-xs text-reader-fg/60 transition-opacity ease-paper motion-reduce:transition-none ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      // design.md "Motion": chrome fades 600ms out / 150ms in — asymmetric, so
      // it lingers on the way out (giving a beat to react) but snaps back the
      // instant the reader asks for it. `motion-reduce:transition-none` above
      // still wins under reduced motion (Tailwind's `transition-none` there
      // disables the transition outright, regardless of this duration).
      style={{ transitionDuration: `${visible ? MOTION_MS.chromeIn : MOTION_MS.chromeOut}ms` }}
    >
      <span className="min-w-0 truncate">{title ?? ""}</span>
      <span className="min-w-0 truncate text-right">{detail ?? ""}</span>
    </div>
  );
}
