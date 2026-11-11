import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/** The app's one manager, so code outside React can raise a toast. */
const manager = Toast.createToastManager();

export interface NotifyOptions {
  title: ReactNode;
  description?: ReactNode;
  type?: "info" | "error";
  /** Milliseconds before it closes; 0 keeps it until dismissed. An error always stays until dismissed. */
  timeout?: number;
  action?: { label: string; onClick: () => void };
  /** Runs when the toast closes, whichever way: dismissed, timed out or closed by code. */
  onClose?: () => void;
}

/** Shows a toast and returns its id. An error stays until it is dismissed, and is announced at once. */
export function notify({ title, description, type = "info", timeout, action, onClose }: NotifyOptions): string {
  return manager.add({
    title,
    description,
    type,
    timeout: type === "error" ? 0 : (timeout ?? 5000),
    priority: type === "error" ? "high" : "low",
    actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
    onClose,
  });
}

/** Closes one toast by id. */
export function dismiss(id: string): void {
  manager.close(id);
}

/** Wraps the app once: `<ToastHost>…</ToastHost>`. F6 moves keyboard focus into the toast region. */
export function ToastHost({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed inset-x-0 bottom-0 z-toast flex flex-col-reverse items-center gap-2 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none sm:items-end sm:px-6">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "pointer-events-auto w-full max-w-sm rounded-sm border border-line-soft/60 bg-paper-raised shadow-sm",
        "translate-x-(--toast-swipe-movement-x) translate-y-(--toast-swipe-movement-y)",
        "data-swiping:duration-0 motion-safe:transition-[opacity,translate] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]",
        "data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-3 data-starting-style:opacity-0",
        "data-[type=error]:border-danger",
      )}
    >
      <Toast.Content className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Toast.Title className="font-ui text-sm text-ink" />
          <Toast.Description className="font-ui text-xs text-ink-variant" />
        </div>
        <Toast.Close className="rounded-sm px-2 py-1 font-ui text-sm text-ink-variant transition hover:text-ink">
          Dismiss
        </Toast.Close>
        <Toast.Action className="rounded-sm bg-ink-fill px-3.5 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90" />
      </Toast.Content>
    </Toast.Root>
  ));
}
