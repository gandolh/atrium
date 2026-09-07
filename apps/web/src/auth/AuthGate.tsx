import { useEffect, type ReactNode } from "react";

import { useAuthStore, useNeedsPicker } from "../lib/auth";
import { goToWardLogin } from "../lib/ward";
import { ProfilePicker } from "../profiles/ProfilePicker";

/**
 * The session gate. Mounted in `routes/root-layout.tsx`, so it wraps every
 * route and covers deep links.
 *
 * ## There is no lock screen any more
 *
 * This file used to end in a `LockScreen` with a username and password form.
 * Atrium does not authenticate anybody now — Ward does, at one login page for
 * the whole estate — so "not signed in" is a **navigation**, not a screen. The
 * `signing-in` state below is what renders for the fraction of a second before
 * the browser leaves; it is deliberately not a form, because a second login
 * form in the estate is exactly what Ward exists to delete.
 *
 * ## Three not-signed-in states, and only one of them redirects
 *
 * - `locked` — no session. Go to Ward. Signing in fixes it.
 * - `forbidden` — a live session with **no atrium grant**. Do *not* redirect:
 *   they are already signed in, and sending them back through login is a loop
 *   that ends where it started. Only a superuser issuing a grant resolves it,
 *   so this says so and stops.
 * - the API (or Ward) being unreachable, which `checkStatus` deliberately
 *   resolves as `unlocked` rather than as either of the above — see its comment.
 *   Sending somebody to a login page served by a service that is down produces a
 *   loop that looks like a rejected password.
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
    return (
      <Centered>
        <p className="font-ui text-sm text-ink-variant">Taking you to sign in…</p>
        {/*
          A manual way through, for the case the automatic navigation did not
          happen — a popup blocker, a browser that swallowed the assign, a
          `checkStatus` that set `locked` on a path the api-client's handler did
          not run on. Without it the person is stuck looking at "Taking you to
          sign in…" forever with nothing to click.
        */}
        <button
          type="button"
          className="font-ui text-sm underline"
          onClick={() => {
            goToWardLogin();
          }}
        >
          Sign in
        </button>
      </Centered>
    );
  }

  if (status === "forbidden") {
    return (
      <Centered>
        <p className="font-ui text-sm text-ink-variant">
          {error ?? "This account does not have access to atrium."}
        </p>
      </Centered>
    );
  }

  if (pickerRequired && profileCount > 0) {
    return <ProfilePicker />;
  }

  return <>{children}</>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] flex-col items-center justify-center gap-3 bg-paper">
      {children}
    </div>
  );
}
