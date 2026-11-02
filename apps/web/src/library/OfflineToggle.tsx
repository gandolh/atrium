import type { OfflineDownloadStatus } from "../lib/use-library";

/**
 * Per-book "Available offline" control — a quiet icon
 * button anchored top-left on the cover, mirroring the format badge's
 * top-right position (`CoverCard`). One glyph + one tap per lifecycle state:
 *
 *   idle        → download glyph, hidden until the card is hovered/focused
 *                 (same reveal pattern as the card's "…" menu trigger); tap
 *                 starts the download.
 *   downloading → a progress ring (determinate from `progress`, spinning
 *                 when indeterminate); always visible, non-interactive — the
 *                 data layer exposes no cancel.
 *   downloaded  → a small dimmed check, always visible; tap removes the
 *                 local copy. Removal never touches the network, so it stays
 *                 enabled even when `canDownload` is false.
 *   error       → a retry glyph, always visible; tap retries the download.
 *
 * `canDownload` gates the idle/error taps only (starting a download needs a
 * network round-trip through `fetchBookFile`).
 */
export function OfflineToggle({
  bookTitle,
  state,
  progress,
  canDownload,
  onDownload,
  onRemove,
}: {
  bookTitle: string;
  state: OfflineDownloadStatus;
  progress: number | null | undefined;
  canDownload: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const base =
    "absolute top-2.5 left-2.5 grid h-7 w-7 place-items-center rounded-(--radius-cover) bg-ink/55 backdrop-blur-sm";

  if (state === "downloading") {
    const pct = progress == null ? null : Math.round(progress * 100);
    return (
      <span
        role="status"
        aria-label={pct == null ? `Downloading ${bookTitle} for offline reading` : `Downloading ${bookTitle}: ${pct}%`}
        title={pct == null ? "Downloading…" : `Downloading… ${pct}%`}
        className={`${base} text-on-ink-fill`}
      >
        <ProgressRing progress={progress ?? null} />
      </span>
    );
  }

  if (state === "downloaded") {
    return (
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${bookTitle} from offline downloads`}
        title="Downloaded for offline reading — tap to remove"
        className={`${base} text-on-ink-fill opacity-70 transition hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent`}
      >
        <CheckGlyph className="h-3.5 w-3.5" />
      </button>
    );
  }

  if (state === "error") {
    return (
      <button
        type="button"
        disabled={!canDownload}
        onClick={onDownload}
        aria-label={canDownload ? `Retry offline download for ${bookTitle}` : "Offline download failed — requires connection"}
        title={canDownload ? "Download failed — tap to retry" : "Download failed — requires connection"}
        className={`${base} text-danger transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50`}
      >
        <RetryGlyph className="h-3.5 w-3.5" />
      </button>
    );
  }

  // idle
  return (
    <button
      type="button"
      disabled={!canDownload}
      onClick={onDownload}
      aria-label={canDownload ? `Save ${bookTitle} for offline reading` : "Save for offline reading — requires connection"}
      title={canDownload ? "Save for offline reading" : "Requires connection"}
      className={`${base} text-on-ink-fill opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 max-md:opacity-100`}
    >
      <DownloadGlyph className="h-3.5 w-3.5" />
    </button>
  );
}

/** Determinate ring (from `progress`) that spins in place when indeterminate (`progress === null`). */
function ProgressRing({ progress }: { progress: number | null }) {
  const size = 16;
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - (progress ?? 0.3));

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={progress == null ? "animate-spin" : ""}
      aria-hidden
    >
      <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} className="stroke-current/30" fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
        className="stroke-current transition-[stroke-dashoffset] duration-200"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%" }}
      />
    </svg>
  );
}

function DownloadGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function RetryGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 1 1 2.5 5.8M4 12V7m0 5h5" />
    </svg>
  );
}
