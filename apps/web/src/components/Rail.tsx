import { Link } from "@tanstack/react-router";

import { ProfileSwitcher } from "../profiles/ProfileSwitcher";
import { CompassIcon, PLACES } from "./places";
import { ThemeToggle } from "./ThemeSwitch";

/** The 232 px rail (at 1280 and wider): a persistent shell, with the profile and the theme at its foot. */
export function Rail() {
  return (
    <aside
      aria-label="Atrium"
      className="sticky top-0 z-raised hidden h-[calc(100dvh-var(--dock-height,0px))] w-(--width-rail) shrink-0 flex-col gap-0 self-start overflow-y-auto border-r border-line bg-paper-raised px-4 pt-6 pb-4 shadow-l1 min-[821px]:flex"
    >
      <Wordmark className="px-3 pb-6" />
      <nav aria-label="Places">
        <ul className="flex flex-col gap-1">
          {PLACES.map((place) => (
            <li key={place.to}>
              <Link
                to={place.to}
                activeOptions={{ exact: place.to === "/", includeSearch: false }}
                className="flex h-11 items-center gap-3 rounded-card px-3 text-body font-medium text-pretty text-ink transition-colors hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-[current=page]:bg-place-current aria-[current=page]:font-semibold aria-[current=page]:text-on-place-current [&_svg]:text-ink-variant aria-[current=page]:[&_svg]:text-accent"
              >
                {place.icon({ size: 20 })}
                {place.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <hr className="mx-3 my-4 border-0 border-t border-line" />
      <Link
        to="/discover"
        className="flex h-11 w-full items-center justify-start gap-2 rounded-card border border-outline bg-paper-raised px-4 text-ui font-medium text-ink transition-colors hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_svg]:text-ink-variant"
      >
        <CompassIcon />
        Browse catalogs
      </Link>
      <div className="mt-auto flex flex-col gap-3 pt-6">
        <ProfileSwitcher variant="rail" />
        <ThemeToggle />
      </div>
    </aside>
  );
}

/** The wordmark: Newsreader, accent, a link home. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      className={`block w-fit rounded-card font-display text-wordmark tracking-[-0.01em] text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className ?? ""}`}
    >
      Atrium
    </Link>
  );
}
