import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

type WithClass<P> = Omit<P, "className"> & { className?: string };

/** A menu of actions behind a button. `modal={false}` leaves the page clickable while it is open. */
export const Menu = BaseMenu.Root;

/** The button that opens it. A styled button of the caller's own goes in through `render`. */
export const MenuTrigger = BaseMenu.Trigger;

export interface MenuPopupProps extends WithClass<ComponentProps<typeof BaseMenu.Popup>> {
  side?: ComponentProps<typeof BaseMenu.Positioner>["side"];
  align?: ComponentProps<typeof BaseMenu.Positioner>["align"];
  sideOffset?: number;
  /** Merged over the positioner's house z-index. */
  positionerClassName?: string;
  /** Anchors the menu to this element instead of its trigger, for a menu opened from code. */
  anchor?: ComponentProps<typeof BaseMenu.Positioner>["anchor"];
}

/** The positioner and the popup, in their portal. The look is the caller's `className`. */
export function MenuPopup({
  side = "bottom",
  align = "start",
  sideOffset = 4,
  positionerClassName,
  anchor,
  className,
  ...props
}: MenuPopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        anchor={anchor}
        className={cn("z-popup outline-none", positionerClassName)}
      >
        <BaseMenu.Popup {...props} className={cn("outline-none", className)} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export const MenuItem = BaseMenu.Item;
export const MenuGroup = BaseMenu.Group;
export const MenuGroupLabel = BaseMenu.GroupLabel;
export const MenuRadioGroup = BaseMenu.RadioGroup;
export const MenuRadioItem = BaseMenu.RadioItem;
