import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

type WithClass<P> = Omit<P, "className"> & { className?: string };

/** A panel anchored to a button, opened by a tap. It is not modal: the page behind stays reachable. */
export const Popover = BasePopover.Root;

/** The button that opens it. A styled button of the caller's own goes in through `render`, never as a child. */
export const PopoverTrigger = BasePopover.Trigger;

export interface PopoverPopupProps extends WithClass<ComponentProps<typeof BasePopover.Popup>> {
  side?: ComponentProps<typeof BasePopover.Positioner>["side"];
  align?: ComponentProps<typeof BasePopover.Positioner>["align"];
  sideOffset?: number;
}

/** The positioner and the popup, in their portal. The look is the caller's `className`. */
export function PopoverPopup({
  side = "bottom",
  align = "center",
  sideOffset = 8,
  className,
  ...props
}: PopoverPopupProps) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-popup">
        <BasePopover.Popup {...props} className={cn("outline-none", className)} />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

/** The panel's heading: it names the panel for a screen reader. */
export const PopoverTitle = BasePopover.Title;
