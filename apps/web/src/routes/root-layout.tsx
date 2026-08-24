import type { CSSProperties } from "react";
import { Outlet } from "@tanstack/react-router";

import { AuthGate } from "../auth/LockScreen";
import { PlaybackHost } from "../player/PlaybackHost";
import { DOCK_HEIGHT_PX } from "../player/PlayerDock";
import { UpdateToast } from "../pwa/UpdateToast";
import { usePlaybackStore } from "../store/playback-store";

/**
 * Shared app shell. The library home owns its own header (`AppHeader` —
 * wordmark + search + theme toggle) and the readers are full-screen (`fixed
 * inset-0`), so the shell adds no chrome of its own except the player dock.
 *
 * `AuthGate` wraps `<Outlet />` here (brief 09) rather than in `main.tsx`
 * because this is the root *route* component — every route (`/`, `/read`)
 * renders inside it, so gating here covers deep links too, and it's the
 * natural home for app-shell-level concerns (it already owns the shell div).
 *
 * **Playback lives here (brief 31).** `PlaybackHost` mounts the app's one
 * `<audio>` element and the dock: at shell level, so navigating between routes
 * can't unmount either and a track never stops. It sits INSIDE the auth gate —
 * media is authenticated (the file URL carries the token), and the lock screen
 * should show no dock; a session that locks therefore also stops playback,
 * flushing the position on the way out.
 *
 * The shell also makes room for its own dock rather than asking pages to pad
 * themselves: `--dock-height` (0px when nothing is loaded) is published here and
 * consumed as the shell's bottom padding, so no page's last row can end up
 * underneath the bar. Surfaces that size themselves to the viewport read the
 * same variable (see `player/MediaFrame`).
 */
export function RootLayout() {
  const dockVisible = usePlaybackStore((s) => s.item !== null);
  const shellStyle = {
    "--dock-height": dockVisible ? `${DOCK_HEIGHT_PX}px` : "0px",
    paddingBottom: "var(--dock-height)",
  } as CSSProperties;

  return (
    <div className="min-h-screen bg-reader-bg text-reader-fg" style={shellStyle}>
      <AuthGate>
        <Outlet />
        <PlaybackHost />
      </AuthGate>
      {/* App-level, outside the auth gate: a new deploy should surface even on
          the lock screen so the app is never stuck on an old version. */}
      <UpdateToast />
    </div>
  );
}
