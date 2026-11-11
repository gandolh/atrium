/**
 * Library-page offline banner — shown when
 * `useLibraryList().isOffline` is true: the live `GET /library` fetch failed
 * and the grid below is rendering the downloaded books' cached snapshots
 * instead. Quiet single line, no dismiss (it persists until the next
 * successful fetch, which the reconnect flow / `refetch` triggers).
 */
export function OfflineBanner() {
  return (
    <p
      role="status"
      className="flex items-center gap-2.5 rounded-sm border border-line-soft/60 bg-paper-low px-4 py-2.5 text-sm text-ink-variant"
    >
      <OfflineGlyph className="h-4 w-4 shrink-0" />
      You&rsquo;re offline — showing only the books you&rsquo;ve downloaded. Reconnect to see the full library.
    </p>
  );
}

function OfflineGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      {/* Three wifi arcs, widest to narrowest, plus the signal dot. */}
      <path strokeLinecap="round" d="M3.5 9a13 13 0 0 1 7-3.2M17.5 5.8A13 13 0 0 1 20.5 9" />
      <path strokeLinecap="round" d="M6.5 13a8.5 8.5 0 0 1 4.2-2.2M15 11.3a8.5 8.5 0 0 1 2.5 1.7" />
      <path strokeLinecap="round" d="M9.5 17a4 4 0 0 1 3.3-1.2" />
      <path d="M12 19.2h.01" strokeLinecap="round" />
      {/* Slash across the whole glyph signals "no connection". */}
      <path strokeLinecap="round" d="M2.5 4.5l19 15" />
    </svg>
  );
}
