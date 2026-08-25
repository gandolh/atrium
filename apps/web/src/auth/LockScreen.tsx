import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useAuthStore, useNeedsPicker } from "../lib/auth";
import { ProfilePicker } from "../profiles/ProfilePicker";

/**
 * Auth gate (brief 09, wiki/design.md "Reading Room"). Wraps everything the
 * router renders (mounted in `routes/root-layout.tsx`): checks
 * `GET /auth/status` once on load, then renders either a neutral loading
 * state, the lock screen, the profile picker, or `children` once unlocked.
 * Any later 401 (via `lib/auth.ts`'s `setOnUnauthorized` wiring) flips
 * `status` back to `"locked"`, which re-renders this gate over whatever was
 * mounted.
 *
 * **Brief 35** inserts the "Who's reading?" picker here, after the lock
 * screen and before `children` — exactly the slot the header comment
 * describes. `pickerRequired` alone isn't enough to show it: on a fresh boot
 * `checkStatus` unlocks synchronously from the seeded token and reconciles
 * the profile list asynchronously after (see auth.ts's "unlock first,
 * reconcile after"), so there's a brief window where the gate might already
 * want the picker but `profiles` hasn't arrived yet. Rendering the picker
 * against an empty list in that window would flash an empty grid, so this
 * treats "unlocked, wants the picker, no profiles yet" the same as
 * `"checking"` instead — profiles arrive within one request, and every real
 * account always has at least one (the last profile can't be deleted).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const checkStatus = useAuthStore((s) => s.checkStatus);
  const pickerRequired = useNeedsPicker();
  const profileCount = useAuthStore((s) => s.profiles.length);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  if (status === "checking" || (status === "unlocked" && pickerRequired && profileCount === 0)) {
    return (
      <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] items-center justify-center bg-paper">
        <p className="font-ui text-sm text-ink-variant">Loading…</p>
      </div>
    );
  }

  if (status === "locked") {
    return <LockScreen />;
  }

  if (pickerRequired) {
    return <ProfilePicker />;
  }

  return <>{children}</>;
}

function LockScreen() {
  const login = useAuthStore((s) => s.login);
  const error = useAuthStore((s) => s.error);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = username.trim().length > 0 && password.trim().length > 0 && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] items-center justify-center bg-paper px-5">
      <div className="w-full max-w-sm rounded-lg border border-line-soft/60 bg-paper-raised p-8 shadow-sm">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-accent">Atrium</h1>
          <p className="font-ui text-sm text-ink-variant">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-ui text-sm font-medium text-ink-variant">Username</span>
            <input
              type="text"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border-b border-line-soft bg-transparent px-1 py-2 font-ui text-ink outline-none transition focus:border-b-2 focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-ui text-sm font-medium text-ink-variant">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border-b border-line-soft bg-transparent px-1 py-2 font-ui text-ink outline-none transition focus:border-b-2 focus:border-accent"
            />
          </label>

          {error && (
            <p role="alert" className="font-ui text-sm text-danger">
              {error}
            </p>
          )}

          {/* Disabled ≠ translucent: 50%-opacity Ink reads as an unthemed UA-
              gray button on the very first screen. Empty form → muted paper
              fill; submitting → keep the Ink fill (it's progress, not a dead
              control) with a quiet pulse. */}
          <button
            type="submit"
            disabled={!canSubmit}
            className={`mt-2 rounded px-6 py-2.5 font-ui text-sm font-semibold transition ${
              submitting
                ? "bg-ink-fill text-on-ink-fill motion-safe:animate-pulse"
                : canSubmit
                  ? "bg-ink-fill text-on-ink-fill hover:opacity-90"
                  : "bg-paper-container text-ink-variant"
            }`}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
