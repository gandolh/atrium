import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useAuthStore, useNeedsPicker } from "../lib/auth";
import { listOfflineBooks } from "../lib/offline-store";
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
 * ## Four not-signed-in states, and only one of them redirects
 *
 * - `locked` — no session. Go to Ward. Signing in fixes it.
 * - `forbidden` — a live session with **no atrium grant**. Do *not* redirect:
 *   they are already signed in, and sending them back through login is a loop
 *   that ends where it started. Only a superuser issuing a grant resolves it,
 *   so this says so and stops.
 * - `unavailable` — the API is up but Ward is not (503 `IDENTITY_UNAVAILABLE`).
 *   No redirect either: the login page is Ward's, and it is down. This says
 *   so, retries until Ward answers, and offers the downloaded books meanwhile
 *   (brief 77).
 * - the API being unreachable, which `checkStatus` deliberately resolves as
 *   `unlocked`: the device is most likely offline, and the library falls back
 *   to its downloaded books on its own.
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

  if (status === "unavailable") {
    return <IdentityUnavailable message={error} retry={checkStatus} />;
  }

  if (pickerRequired && profileCount > 0) {
    return <ProfilePicker />;
  }

  return <>{children}</>;
}

/** How often the `unavailable` screen asks again on its own. */
const UNAVAILABLE_RETRY_MS = 15_000;

/**
 * Ward is down. Retries on a timer, when the device comes back online and when
 * the tab is shown again, so starting Ward recovers the app without a reload.
 * The retry is the same `checkStatus` the boot ran: it leaves this screen the
 * moment the probe answers anything other than the 503.
 */
function IdentityUnavailable({
  message,
  retry,
}: {
  message: string | null;
  retry: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const continueWithoutSignIn = useAuthStore((s) => s.continueWithoutSignIn);
  const [retrying, setRetrying] = useState(false);
  const [downloaded, setDownloaded] = useState(0);

  useEffect(() => {
    let live = true;
    // Any profile's downloads: the shelf is device-scoped (brief 20), and with
    // Ward down nobody can be asked who is reading yet.
    void listOfflineBooks(null).then((books) => {
      if (live) setDownloaded(books.length);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let inFlight = false;
    const attempt = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void retry().finally(() => {
        inFlight = false;
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") attempt();
    };
    const timer = window.setInterval(attempt, UNAVAILABLE_RETRY_MS);
    window.addEventListener("online", attempt);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", attempt);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [retry]);

  return (
    <Centered>
      <p className="font-ui text-sm text-ink-variant" role="status">
        {message ?? "Sign-in is unavailable right now. Atrium will try again."}
      </p>
      <div className="flex items-center gap-4">
        <button
          type="button"
          disabled={retrying}
          className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          onClick={() => {
            setRetrying(true);
            void retry().finally(() => setRetrying(false));
          }}
        >
          {retrying ? "Trying…" : "Retry"}
        </button>
        {downloaded > 0 && (
          <button
            type="button"
            className="font-ui text-sm text-ink-variant underline transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => {
              continueWithoutSignIn();
              void navigate({ to: "/books" });
            }}
          >
            Read downloaded books
          </button>
        )}
      </div>
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
