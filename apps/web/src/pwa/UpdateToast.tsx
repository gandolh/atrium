import { useEffect, useRef } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

import { dismiss, notify } from "../components/ui/Toast";

/**
 * PWA update prompt. With `registerType: "prompt"` a freshly
 * deployed service worker installs but *waits* — it never swaps the running app
 * out from under an active reading session. `useRegisterSW` flips `needRefresh`
 * true while that worker waits; we surface this quiet toast so a new deploy is
 * never silently stale nor forced. "Reload" activates the waiting worker
 * (`updateServiceWorker(true)`), which reloads the page onto the new version.
 *
 * In dev / any context without a service worker the hook is a no-op and
 * `needRefresh` stays false, so this renders nothing.
 *
 * It is a Base UI toast (components/ui/Toast.tsx), raised through the app's one toast manager. It is not an error,
 * so it has no timer of its own: it stays until "Reload", "Dismiss", or the worker stops waiting.
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

  const toastId = useRef<string | null>(null);
  useEffect(() => {
    if (needRefresh && toastId.current === null) {
      toastId.current = notify({
        title: "A new version is available.",
        timeout: 0,
        action: { label: "Reload", onClick: () => void updateServiceWorker(true) },
        // "Dismiss" closes the toast; this keeps the worker's flag in step so it is not raised again.
        onClose: () => {
          toastId.current = null;
          setNeedRefresh(false);
        },
      });
    } else if (!needRefresh && toastId.current !== null) {
      const id = toastId.current;
      toastId.current = null;
      dismiss(id);
    }
  }, [needRefresh, setNeedRefresh, updateServiceWorker]);

  return null;
}
