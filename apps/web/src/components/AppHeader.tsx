import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { ProfileSwitcher } from "../profiles/ProfileSwitcher";
import { Wordmark } from "./Rail";
import { useShellSlot } from "./shell-context";
import { ThemePopover } from "./ThemeSwitch";

/**
 * A page's header, rendered into the shell's slot above the page: the raised band at 1280 (search at the left, the
 * page's actions at the right) and the raised top bar on a phone (the wordmark, the profile, the theme button and,
 * right under them, search). The navigation itself is the shell's: the rail and the bottom bar (D63), so the header
 * carries no links.
 *
 * Every non-reader page uses it. A page with neither search nor actions gets no band at 1280, and the LaTeX
 * editor, which hides the rail, gets a band with the wordmark so there is a way back.
 *
 * `actions` fill the band at 1280 only. On a phone the page lays its own actions out under its title (a matched 48 px
 * pair), so nothing shows twice.
 */
export function AppHeader({
  caption,
  search,
  actions,
}: {
  /** A quiet caption (the library's storage usage): in the band at 1280, under the search field on a phone. */
  caption?: ReactNode;
  /** The search field. At 1280 it is the band's left end; on a phone it sits right under the top bar's first row. */
  search?: ReactNode;
  /** Page-level actions at the band's right end (1280 only). */
  actions?: ReactNode;
}) {
  const { slot, chrome } = useShellSlot();
  if (!slot) return null;

  const showBand = Boolean(search || actions || caption || chrome === "bar");

  return createPortal(
    <>
      {showBand && (
        <div className="relative z-sticky hidden border-b border-line bg-paper-raised shadow-l1 min-[821px]:block">
          <div className="mx-auto flex h-18 w-full max-w-(--container-page) items-center justify-between gap-4 px-8">
            {chrome === "bar" && <Wordmark />}
            {search && <div className="max-w-105 min-w-0 flex-1">{search}</div>}
            {caption && <div className="min-w-0">{caption}</div>}
            <div className="ml-auto flex items-center gap-3">{actions}</div>
          </div>
        </div>
      )}
      <header className="relative z-sticky border-b border-line bg-paper-raised shadow-l1 min-[821px]:hidden">
        <div className="flex h-15 items-center justify-between gap-2 px-4">
          <Wordmark className="py-2" />
          <div className="flex items-center gap-2">
            <ProfileSwitcher variant="bar" />
            <ThemePopover />
          </div>
        </div>
        {search && <div className="px-4 pb-3">{search}</div>}
        {caption && <div className="px-4 pb-2">{caption}</div>}
      </header>
    </>,
    slot,
  );
}
