import type { ReactNode } from "react";

/**
 * The offer of a recovered device copy (`lib/unsaved-stash.ts`): the LaTeX
 * editor's (brief 85) and the Notes editor's (brief 88). A choice, not an
 * automatic restore: the server's version may be newer than the copy if the
 * work was edited somewhere else since. Not `role="alert"`: it appears on
 * arrival, not in the middle of typing, and its buttons are the next thing a
 * keyboard reaches after the header.
 *
 * `subject` is what the changes were made to ("main.tex", "this note").
 */
export function RecoveredBanner({
  subject,
  at,
  onRestore,
  onDiscard,
  className = "",
}: {
  subject: ReactNode;
  at: number;
  onRestore: () => void;
  onDiscard: () => void;
  /** Placement only (padding, borders); the banner's look is fixed here. */
  className?: string;
}) {
  const when = new Date(at);
  const sameDay = when.toDateString() === new Date().toDateString();
  const stamp = sameDay
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return (
    <div
      role="region"
      aria-label="Recovered unsaved changes"
      className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-paper-low py-2 ${className}`}
    >
      <p className="min-w-0 flex-1 font-ui text-sm text-ink">
        <span className="font-semibold">Recovered unsaved changes</span> to {subject} from{" "}
        <span className="tabular-nums">{stamp}</span>, which never reached the server.
      </p>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={onRestore}
          className="rounded-card border border-line-soft px-3 py-1 font-ui text-xs font-semibold text-ink transition hover:bg-paper-container focus-visible:outline-2 focus-visible:outline-accent"
        >
          Restore them
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-card px-3 py-1 font-ui text-xs font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
