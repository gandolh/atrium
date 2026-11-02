/**
 * Shared reading-progress indicator (wiki/reader.md "Progress indicator").
 * Shows "current / total" and a percentage. Format-agnostic: PDF passes page
 * numbers; EPUB passes a location index / total locations. `total`
 * may be `null` while the document is still loading.
 */
export function ProgressIndicator({
  current,
  total,
  unitLabel = "Page",
  variant = "pages",
}: {
  current: number;
  total: number | null;
  unitLabel?: string;
  /**
   * "pages" shows "Page 3 / 21" + a percent chip (PDF). "percent" shows just
   * the percent chip — for reflowable formats where current/total IS the
   * percentage and repeating it reads as a page count ("33 / 100 33%").
   */
  variant?: "pages" | "percent";
}) {
  const percent = total && total > 0 ? Math.round((current / total) * 100) : null;

  return (
    <div className="flex shrink-0 items-center gap-2 text-sm text-reader-fg/80" aria-live="polite">
      {variant === "pages" && (
        <span className="whitespace-nowrap tabular-nums">
          {unitLabel} {current}
          {total !== null ? ` / ${total}` : ""}
        </span>
      )}
      {percent !== null && (
        <span className="rounded bg-reader-surface px-1.5 py-0.5 text-xs tabular-nums text-reader-fg/70">
          {percent}%
        </span>
      )}
    </div>
  );
}
