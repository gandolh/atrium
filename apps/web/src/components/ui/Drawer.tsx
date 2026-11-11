import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";

type WithClass<P> = Omit<P, "className"> & { className?: string };

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The edge the panel sits on, which is also the direction a swipe closes it. */
  swipeDirection: "left" | "right";
  /** For a panel that holds a form: an outside tap must not throw away what was typed (base-ui rule 12). */
  disablePointerDismissal?: boolean;
  children: ReactNode;
}

/**
 * A side panel (base-ui rule 15): a swipe toward its edge, a tap outside, the X or Esc closes it. Android's back
 * gesture too. There is no swipe area to open it by an edge swipe, so it can't fight the reader's page-turn swipe.
 */
export function Drawer({ open, onOpenChange, swipeDirection, disablePointerDismissal, children }: DrawerProps) {
  return (
    <BaseDrawer.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key" && details.event.defaultPrevented) return;
        onOpenChange(next);
      }}
      swipeDirection={swipeDirection}
      disablePointerDismissal={disablePointerDismissal}
    >
      {children}
    </BaseDrawer.Root>
  );
}

export interface DrawerPopupProps extends WithClass<ComponentProps<typeof BaseDrawer.Popup>> {
  swipeDirection: "left" | "right";
  /** Merged over the house scrim. */
  backdropClassName?: string;
  /** What the panel scrolls: the area under the title bar. Pass the header yourself, as a child. */
  children: ReactNode;
}

/**
 * The scrim, the viewport and the popup, in their portal. The panel follows the finger while a swipe runs, and
 * slides out to its edge on close. Its width and look are the caller's `className`.
 */
export function DrawerPopup({ className, backdropClassName, swipeDirection, children, ...props }: DrawerPopupProps) {
  const edge = swipeDirection === "left" ? "left-0" : "right-0";
  const away =
    swipeDirection === "left"
      ? "data-ending-style:-translate-x-full data-starting-style:-translate-x-full"
      : "data-ending-style:translate-x-full data-starting-style:translate-x-full";
  return (
    <BaseDrawer.Portal>
      {/* design.md "Depth is tonal": modals keep a 12px backdrop blur. */}
      <BaseDrawer.Backdrop
        className={cn(
          "fixed inset-0 z-overlay bg-black/40 opacity-[calc(1-var(--drawer-swipe-progress))] backdrop-blur-md data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0 motion-safe:transition-opacity",
          backdropClassName,
        )}
      />
      <BaseDrawer.Viewport className="fixed inset-0 z-popup">
        <BaseDrawer.Popup
          {...props}
          className={cn(
            "absolute inset-y-0 outline-none data-swiping:duration-0 data-swiping:select-none motion-safe:transition-transform",
            edge,
            "translate-x-(--drawer-swipe-movement-x)",
            away,
            className,
          )}
        >
          {children}
        </BaseDrawer.Popup>
      </BaseDrawer.Viewport>
    </BaseDrawer.Portal>
  );
}

/** The panel's heading: it names the panel for a screen reader (base-ui rule 15). */
export const DrawerTitle = BaseDrawer.Title;

/** A button that closes the drawer. An icon-only one carries an `aria-label`. */
export const DrawerClose = BaseDrawer.Close;
