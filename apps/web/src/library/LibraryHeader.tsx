import { Link } from "@tanstack/react-router";
import type { MediaKind } from "@ebook-reader/shared";

/**
 * Library-scoped controls. The app shell itself (wordmark + search slot + Notes
 * + theme toggle) lives in `components/AppHeader.tsx`; what lives here is the
 * home's own chrome: the **kind filter chips** and the storage caption.
 *
 * Brief 28 (D33 move 1) replaced this file's Shelves⇄Stacks `ViewToggle` — and
 * with it the whole grouping UI — with `KindChips`. Media kind went from being
 * an address (`/books`, brief 25) to being a filter with a count.
 *
 * `StorageCaption` (brief 20 item 2) also lives here: the home passes it into
 * `AppHeader`'s caption slot.
 */

/** One chip: a kind to filter by, or `undefined` for "All". */
export interface KindChoice {
  kind?: MediaKind;
  label: string;
  count: number;
}

/**
 * The kind filter chips (design.md "Components" → Filter chips): 20px radius —
 * the single pill in the system — a `line` border on `paper-raised`, and the
 * **active chip inverts to `ink-fill`**. The count sets in Archivo tabular at
 * 55% opacity (`body` already carries `tabular-nums`).
 *
 * Each chip is a real `<Link>` to `/` with its own `?kind`, not a button: the
 * filter lives in the URL, so Back / refresh / share / middle-click-into-a-new-
 * tab all round-trip, and the browser gives us prefetch + "open in new tab" for
 * free. The active state reaches assistive tech as the `aria-current="page"`
 * that TanStack's `Link` emits for the matching chip (these are links, so
 * `radiogroup` semantics would be a lie) — see `activeOptions` below.
 *
 * A chip with a zero count still renders — a filter set that shrinks and grows
 * as you upload would be its own small confusion, and "Music 0" is honest
 * information about the library.
 */
export function KindChips({
  active,
  choices,
}: {
  active?: MediaKind;
  choices: KindChoice[];
}) {
  return (
    <nav aria-label="Filter by kind" className="flex flex-wrap items-center gap-2">
      {choices.map((choice) => {
        const isActive = choice.kind === active;
        return (
          <Link
            key={choice.kind ?? "all"}
            to="/"
            search={{ kind: choice.kind }}
            // Without this every chip points at `/`, so TanStack's path-only
            // active test marks **All** current on `/?kind=video` too — two
            // chips announcing `aria-current="page"` at once. `includeSearch`
            // makes its activeness (and therefore the `aria-current` it emits)
            // agree with `isActive` below.
            activeOptions={{ exact: true, includeSearch: true }}
            className={`flex items-center gap-1.5 rounded-chip border px-3.5 py-1.5 font-ui text-sm font-medium transition-colors duration-200 ease-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              isActive
                ? "border-ink-fill bg-ink-fill text-on-ink-fill"
                : "border-line bg-paper-raised text-ink-variant hover:text-ink"
            }`}
          >
            {choice.label}
            <span className="font-ui text-xs font-medium opacity-55">{choice.count}</span>
          </Link>
        );
      })}
    </nav>
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
