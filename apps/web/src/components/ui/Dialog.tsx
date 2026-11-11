import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRef, type ComponentProps, type ReactNode, type RefObject } from "react";

import { cn } from "../../lib/cn";

type WithClass<P> = Omit<P, "className"> & { className?: string };

const FIELD = "input:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the close transition ends: the place to unmount what the dialog held. */
  onOpenChangeComplete?: (open: boolean) => void;
  /**
   * For a dialog that holds a form: an outside tap must not throw away what was typed (base-ui rule 12). Esc, the
   * X and Cancel still close it.
   */
  disablePointerDismissal?: boolean;
  children: ReactNode;
}

/**
 * A modal dialog's root (base-ui rule 12): controlled, so code can refuse a close while a request runs. Esc that an
 * inner control already used (`defaultPrevented`) is not the dialog's, so it stays open. Base UI's own Esc listener
 * doesn't look at that flag.
 */
export function Dialog({ open, onOpenChange, onOpenChangeComplete, disablePointerDismissal, children }: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key" && details.event.defaultPrevented) return;
        onOpenChange(next);
      }}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal={disablePointerDismissal}
    >
      {children}
    </BaseDialog.Root>
  );
}

export interface DialogPopupProps extends WithClass<Omit<ComponentProps<typeof BaseDialog.Popup>, "initialFocus">> {
  /** Where focus goes on close. Base UI's default is the element that opened the dialog. */
  finalFocus?: RefObject<HTMLElement | null>;
  /** The scrim behind the dialog: merged over the house one. */
  backdropClassName?: string;
}

/**
 * The scrim and the popup, in their portal. On open, focus goes to the first `[data-autofocus]` inside, else the
 * first field, else the footer's first button, else Base UI's own default (never the X). The popup's size, position
 * and look are the caller's `className`.
 */
export function DialogPopup({ className, backdropClassName, finalFocus, children, ...props }: DialogPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <BaseDialog.Portal>
      {/* design.md "Depth is tonal": modals keep a 12px backdrop blur. */}
      <BaseDialog.Backdrop
        className={cn(
          "fixed inset-0 z-overlay bg-black/40 backdrop-blur-md data-ending-style:opacity-0 data-starting-style:opacity-0 motion-safe:transition-opacity",
          backdropClassName,
        )}
      />
      <BaseDialog.Popup
        {...props}
        ref={popupRef}
        finalFocus={finalFocus}
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
          popupRef.current?.querySelector<HTMLElement>(FIELD) ??
          popupRef.current?.querySelector<HTMLElement>("footer button:not(:disabled)") ??
          true
        }
        className={cn("fixed z-popup outline-none", className)}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

/** The dialog's heading: it names the dialog for a screen reader (base-ui rule 12). */
export const DialogTitle = BaseDialog.Title;

export const DialogDescription = BaseDialog.Description;

/** A button that closes the dialog. An icon-only one carries an `aria-label`. */
export const DialogClose = BaseDialog.Close;
