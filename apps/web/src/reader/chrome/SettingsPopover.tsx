import { useState, type ReactElement, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";

import { useChromeHold } from "./use-auto-hide-chrome";

/**
 * Shared settings surface (wiki/reader.md "Settings surface via Base UI
 * Popover/Dialog + Slider"). A Base UI Popover anchored to a toolbar trigger.
 *
 * Format-agnostic shell: the *contents* are supplied by the caller as
 * `children`, so PDF passes zoom/fit + invert controls (brief 06) and EPUB
 * passes font size/family/spacing/margin + theme controls (brief 07). This is
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
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} aria-label={title} />
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} className="z-50">
          <Popover.Popup className="w-72 rounded-card border border-reader-border bg-reader-bg p-4 text-reader-fg shadow-l1 transition data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-reduce:transition-none">
            <Popover.Title className="mb-3 text-sm font-semibold">{title}</Popover.Title>
            <div className="flex flex-col gap-4">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
