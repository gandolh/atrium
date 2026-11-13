import { useState, type ReactElement, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/Popover";
import { useChromeHold } from "./use-auto-hide-chrome";

/**
 * Shared settings surface (wiki/reader.md "Settings surface via Base UI
 * Popover/Dialog + Slider"). A Base UI Popover anchored to a toolbar trigger.
 *
 * Format-agnostic shell: the *contents* are supplied by the caller as
 * `children`, so PDF passes zoom/fit + invert controls and EPUB
 * passes font size/family/spacing/margin + theme controls. This is
 * one half of the format-adaptive seam (the other half is `ReaderToolbar`'s
 * `formatControls` slot).
 */
export function SettingsPopover({
  trigger,
  title,
  children,
}: {
  /**
   * The trigger element. Rendered AS the Popover trigger via Base UI's `render`
   * prop (prop-merging), so pass a single focusable element (e.g. a button) —
   * this avoids nesting a button inside a trigger wrapper.
   */
  trigger: ReactElement;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The popover is anchored to the toolbar — keep the chrome from auto-hiding
  // underneath it while open.
  useChromeHold(open);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} aria-label={title} />
      <PopoverPopup
        side="top"
        className="w-72 rounded-card border border-reader-border bg-reader-bg p-4 text-reader-fg shadow-float transition data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
      >
        <PopoverTitle className="mb-3 text-sm font-semibold">{title}</PopoverTitle>
        <div className="flex flex-col gap-4">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}
