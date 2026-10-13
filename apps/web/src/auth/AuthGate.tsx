import { useEffect, type ReactNode } from "react";

import { useLogout } from "../../vendor/ward/ward-auth-react.js";
import { useAuthStore, useNeedsPicker } from "../lib/auth";
import { ProfilePicker } from "../profiles/ProfilePicker";
import { LoginPage } from "./LoginPage";

/**
 * The session gate. Mounted in `routes/root-layout.tsx`, so it wraps every
 * route and covers deep links.
 *
 * ## Signed out is a page again
 *
 * Atrium has its own accounts (D58), so "not signed in" renders atrium's own
 * login page, **in place**: the URL stays what the person opened, and once a
 * session exists the gate re-checks and that page renders. Under D53 this was
 * a navigation to Ward's login page; Ward is now one of the two ways in, a
 * button on this page.
 *
 * ## The states
 *
 * - `locked`: no session. The login page.
 * - `forbidden`: the Discord bot's `jukebox` account (D55) in a browser. Not a
 *   sign-in problem, so it says so and offers only signing out.
 * - the API being unreachable, which `checkStatus` deliberately resolves as
 *   `unlocked`: the device is most likely offline, and the library falls back
 *   to its downloaded books on its own. While the API answers but signing in
 *   is not possible (Ward down for a Ward-only account), the login page offers
 *   those downloads itself (brief 77).
 *
 * ## The picker still sits between the gate and the app
 *
 * `pickerRequired` alone is not enough to show it: on a boot with a cached
 * profile list the store can want the picker before the list has been
 * re-fetched, and rendering an empty grid in that window flashes. "Wants the
 * picker but has no profiles yet" is treated as still checking — profiles
 * arrive within one request, and every account always has at least one, since
 * the last profile cannot be deleted.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const checkStatus = useAuthStore((s) => s.checkStatus);
  const pickerRequired = useNeedsPicker();
  const profileCount = useAuthStore((s) => s.profiles.length);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  if (status === "checking") {
    return <Centered>Loading…</Centered>;
  }

  if (status === "locked") {
    return <LoginPage />;
  }

  if (status === "forbidden") {
    return <Forbidden message={error} />;
  }

  if (pickerRequired && profileCount > 0) {
    return <ProfilePicker />;
  }

  return <>{children}</>;
}

/** The bot's account in a browser: say so, and offer the way out. */
function Forbidden({ message }: { message: string | null }) {
  const { logout, pending } = useLogout();
  const signedOut = useAuthStore((s) => s.signedOut);
  return (
    <Centered>
      <p className="max-w-sm text-center font-ui text-sm text-ink-variant">{message}</p>
      <button
        type="button"
        disabled={pending}
        className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        onClick={async () => {
          if (await logout()) signedOut();
        }}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] flex-col items-center justify-center gap-3 bg-paper">
      {children}
    </div>
  );
}
