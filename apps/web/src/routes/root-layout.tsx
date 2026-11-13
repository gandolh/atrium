import type { CSSProperties } from "react";
import { Outlet } from "@tanstack/react-router";

import { AuthGate } from "../auth/AuthGate";
import { PlaybackHost } from "../player/PlaybackHost";
import { DOCK_HEIGHT_PX } from "../player/PlayerDock";
import { AppShell } from "../components/AppShell";
import { useShellChrome } from "../components/shell-context";
import { ToastHost } from "../components/ui/Toast";
import { UpdateToast } from "../pwa/UpdateToast";
import { usePlaybackStore } from "../store/playback-store";

/**
 * Shared app shell. `AppShell` adds the rail (1280) and the bottom bar (phone) around every page but the reader,
 * which is full-screen (`fixed inset-0`) and keeps its own summoned chrome. Each page's `AppHeader` fills the shell's
 * slot above the page. The shell publishes `--rail-offset` and `--bar-offset` (see globals.css) so the player dock
 * clears them.
 *
 * `AuthGate` wraps `<Outlet />` here rather than in `main.tsx`
 * because this is the root *route* component — every route (`/`, `/read`)
 * renders inside it, so gating here covers deep links too, and it's the
 * natural home for app-shell-level concerns (it already owns the shell div).
 *
 * **Playback lives here.** `PlaybackHost` mounts the app's one
 * `<audio>` element and the dock: at shell level, so navigating between routes
 * can't unmount either and a track never stops. It sits INSIDE the auth gate —
 * media is authenticated (the session cookie rides the file URL, which lives
 * under the API prefix), and the login page should show no dock; a session
 * that ends therefore also stops playback, flushing the position on the way
 * out.
 *
 * The shell also makes room for its own dock rather than asking pages to pad
 * themselves: `--dock-height` (0px when nothing is loaded) is published here and
 * consumed as the shell's bottom padding, so no page's last row can end up
 * underneath the bar. That padding is invisible to a `fixed` child, so surfaces
 * that take themselves out of flow or size themselves to the viewport read the
 * variable directly instead: both readers end their `fixed` frame at
 * `bottom: var(--dock-height)` (otherwise the dock covers the progress rail —
 * the reader's only scrub control) and `player/MediaFrame` subtracts it from its
 * min-height.
 */
export function RootLayout() {
  const dockVisible = usePlaybackStore((s) => s.item !== null);
  const chrome = useShellChrome();
  const shellStyle = {
    "--dock-height": dockVisible ? `${DOCK_HEIGHT_PX}px` : "0px",
    paddingBottom: "var(--dock-height)",
  } as CSSProperties;

  return (
    <ToastHost>
      <div className="min-h-screen bg-reader-bg text-reader-fg" style={shellStyle} data-shell={chrome}>
        <AuthGate>
          <AppShell>
            <Outlet />
          </AppShell>
          <PlaybackHost />
        </AuthGate>
        {/* App-level, outside the auth gate: a new deploy should surface even
            while signing in, so the app is never stuck on an old version. */}
        <UpdateToast />
      </div>
    </ToastHost>
  );
}
