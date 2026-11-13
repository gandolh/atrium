import { createContext, useContext } from "react";
import { useRouterState } from "@tanstack/react-router";

/**
 * What shell chrome a page gets:
 *
 * - `full`: the rail at 1280 (Library, Notes, LaTeX, Jukebox, Browse catalogs, the profile and the theme at its
 *   foot), the bottom bar on a phone.
 * - `bar`: the LaTeX editor. The rail steps aside at every width to give the editor the room, and a phone keeps its
 *   bottom bar.
 * - `none`: the reader, which stays immersive and keeps its summoned chrome.
 */
export type ShellChrome = "full" | "bar" | "none";

/** The shell chrome for the page on screen. */
export function useShellChrome(): ShellChrome {
  const { pathname, project } = useRouterState({
    select: (s) => ({
      pathname: s.location.pathname,
      project: (s.location.search as { project?: string }).project,
    }),
  });
  if (pathname.startsWith("/read")) return "none";
  if (pathname.startsWith("/latex") && project) return "bar";
  return "full";
}

/** Where a page's `AppHeader` renders (the band above the page at 1280, the top bar on a phone), and the chrome. */
export interface ShellSlot {
  slot: HTMLElement | null;
  chrome: ShellChrome;
}

export const ShellSlotContext = createContext<ShellSlot>({ slot: null, chrome: "none" });

export function useShellSlot(): ShellSlot {
  return useContext(ShellSlotContext);
}
