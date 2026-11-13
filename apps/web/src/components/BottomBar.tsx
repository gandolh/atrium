import { Link } from "@tanstack/react-router";

import { PLACES } from "./places";

/**
 * The phone's bottom bar: 64 px plus the safe-area inset, four places with an icon and a label, the current one on a
 * pill. It is fixed to the screen's foot and the shell reserves its height (`--bar-offset`), so nothing hides under
 * it. Shown below 821 px.
 */
export function BottomBar() {
  return (
    <nav
      aria-label="Places"
      className="fixed inset-x-0 bottom-0 z-chrome grid min-h-(--height-bar) grid-cols-4 border-t border-line bg-paper-raised px-1 pt-1 pb-[calc(4px+env(safe-area-inset-bottom,0px))] shadow-bar min-[821px]:hidden"
    >
      {PLACES.map((place) => (
        <Link
          key={place.to}
          to={place.to}
          activeOptions={{ exact: place.to === "/", includeSearch: false }}
          className="group flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-card text-micro font-medium text-ink focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:font-semibold aria-[current=page]:text-on-place-current"
        >
          <span className="grid h-8 w-14 place-items-center rounded-full text-ink-variant group-aria-[current=page]:bg-place-current group-aria-[current=page]:text-accent">
            {place.icon({ size: 22 })}
          </span>
          {place.label}
        </Link>
      ))}
    </nav>
  );
}
