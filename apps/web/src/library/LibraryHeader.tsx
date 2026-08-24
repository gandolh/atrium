import { useRef, type KeyboardEvent } from "react";

import type { GroupView } from "../lib/library-prefs";

/**
 * Library-scoped controls. The app shell itself (wordmark + nav + theme toggle)
 * lives in `components/AppHeader.tsx`; what remains here is the Shelves⇄Stacks
 * view toggle, which renders beside a `LibraryArea` heading as a peer of Group
 * by / Sort by. The old media-type filter was retired in brief 25 — the media
 * type is now the nav (Books / Music / Videos), not an in-grid control.
 *
 * `StorageCaption` (brief 20 item 2) also lives here: an area passes it into
 * `AppHeader`'s caption slot.
 */

const VIEWS: { value: GroupView; label: string }[] = [
  { value: "shelves", label: "Shelves" },
  { value: "stacks", label: "Stacks" },
];

/**
 * The Shelves⇄Stacks view toggle (brief 21 step 5). A two-segment Reading Room
 * control: Archivo `label-caps`, hairline border, 4px radius, active fill
 * `paper-container-high` — deliberately **no accent** on the control itself
 * (accent is reserved for active values/links; the only accent here is the
 * focus ring). A11y: `radiogroup` semantics + roving tabindex, arrow keys move
 * and select, visible primary focus ring.
 */
export function ViewToggle({
  view,
  onViewChange,
}: {
  view: GroupView;
  onViewChange: (view: GroupView) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !back) return;
    e.preventDefault();
    const current = VIEWS.findIndex((v) => v.value === view);
    const next = (current + (forward ? 1 : VIEWS.length - 1)) % VIEWS.length;
    onViewChange(VIEWS[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="View"
      onKeyDown={onKeyDown}
      className="flex items-center rounded border border-line-soft/60 bg-paper-low p-0.5"
    >
      {VIEWS.map((v, i) => {
        const active = view === v.value;
        return (
          <button
            key={v.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => onViewChange(v.value)}
            className={`rounded-[3px] px-3 py-1.5 font-ui text-xs font-semibold tracking-[0.08em] uppercase transition focus-visible:outline-2 focus-visible:outline-accent ${
              active ? "bg-paper-raised text-ink shadow-sm" : "text-ink-variant hover:text-ink"
            }`}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Storage-used indicator (brief 20 item 2) — a quiet caption, not a widget.
 * Renders nothing until there's something to say: no downloads, or no
 * `storage.estimate()` support, both mean "nothing to report" rather than an
 * error state.
 */
export function StorageCaption({
  storage,
  downloadedCount,
}: {
  storage?: { usage: number; quota: number } | null;
  downloadedCount: number;
}) {
  if (downloadedCount === 0 || !storage || storage.quota <= 0) return null;
  const pct = Math.min(100, Math.round((storage.usage / storage.quota) * 100));
  return (
    <p
      className="text-xs text-ink-variant"
      title={`${formatBytes(storage.usage)} used of ${formatBytes(storage.quota)} available on this device`}
    >
      {formatBytes(storage.usage)} offline &middot; {pct}% of device storage
    </p>
  );
}

/** Human-readable byte size (`1536` → `"1.5 KB"`), binary (1024) units. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[exponent]}`;
}
