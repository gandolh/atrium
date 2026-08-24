import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * PWA update prompt (brief 19). With `registerType: "prompt"` a freshly
 * deployed service worker installs but *waits* — it never swaps the running app
 * out from under an active reading session. `useRegisterSW` flips `needRefresh`
 * true while that worker waits; we surface this quiet toast so a new deploy is
 * never silently stale nor forced. "Reload" activates the waiting worker
 * (`updateServiceWorker(true)`), which reloads the page onto the new version.
 *
 * In dev / any context without a service worker the hook is a no-op and
 * `needRefresh` stays false, so this renders nothing.
 *
 * Styling is Reading Room (design.md): theme tokens only (they remap per
 * `data-theme`, so the toast themes with the reader in light/sepia/dark), Archivo
 * UI role, 4px radius, a soft single-border card (L1 elevation), and the Ink
 * button for the primary action. Accent stays unused — reserved for
 * active/progress/links.
 */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <UpdatePrompt
      onReload={() => void updateServiceWorker(true)}
      onDismiss={() => setNeedRefresh(false)}
    />
  );
}

function UpdatePrompt({
  onReload,
  onDismiss,
}: {
  onReload: () => void;
  onDismiss: () => void;
}) {
  // Entrance: mount hidden + nudged down, then settle. A one-shot effect (this
  // subtree only mounts once `needRefresh` is true) drives the transition;
  // `motion-reduce` collapses it to an instant appearance.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    // Full-width wrapper is click-through (pointer-events-none); only the card
    // itself is interactive. Bottom-anchored, centred on mobile and tucked to
    // the trailing edge on wider screens, clear of the safe-area inset.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:justify-end sm:px-6"
    >
      <div
        className={`pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded border border-line-soft/60 bg-paper-raised px-4 py-3 shadow-sm transition duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
          shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
        }`}
      >
        <p className="min-w-0 flex-1 font-ui text-sm text-ink">
          A new version is available.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-2 py-1 font-ui text-sm text-ink-variant transition hover:text-ink"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onReload}
          className="rounded bg-ink-fill px-3.5 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
