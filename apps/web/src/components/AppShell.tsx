import { useState, type ReactNode } from "react";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { BottomBar } from "./BottomBar";
import { Rail } from "./Rail";
import { ShellSlotContext, useShellChrome } from "./shell-context";

/**
 * The persistent shell (D63): the rail at 1280, the bottom bar on a phone, and above each page a slot that the page's
 * `AppHeader` fills (the raised band at 1280, the top bar on a phone). The reader gets none of it. The theme is
 * applied here, once, so the rail and the bar are themed on every route.
 */
export function AppShell({ children }: { children: ReactNode }) {
  useApplyTheme();
  const chrome = useShellChrome();
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  if (chrome === "none") return <>{children}</>;

  return (
    <ShellSlotContext value={{ slot, chrome }}>
      <div className="flex min-h-[calc(100dvh-var(--dock-height,0px))] items-stretch">
        {chrome === "full" && <Rail />}
        <div className="flex min-w-0 flex-1 flex-col pb-(--bar-offset)">
          <div ref={setSlot} />
          {children}
        </div>
      </div>
      <BottomBar />
    </ShellSlotContext>
  );
}
