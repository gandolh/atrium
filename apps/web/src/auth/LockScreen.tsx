import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useAuthStore } from "../lib/auth";

/**
 * Auth gate (brief 09, wiki/design.md "Reading Room"). Wraps everything the
 * router renders (mounted in `routes/root-layout.tsx`): checks
 * `GET /auth/status` once on load, then renders either a neutral loading
 * state, the lock screen, or `children` once unlocked. Any later 401 (via
 * `lib/auth.ts`'s `setOnUnauthorized` wiring) flips `status` back to
 * `"locked"`, which re-renders this gate over whatever was mounted.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const checkStatus = useAuthStore((s) => s.checkStatus);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="font-ui text-sm text-ink-variant">Loading…</p>
      </div>
    );
  }

  if (status === "locked") {
    return <LockScreen />;
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
    <div className="flex min-h-screen items-center justify-center bg-paper px-5">
      <div className="w-full max-w-sm rounded-lg border border-line-soft/60 bg-paper-raised p-8 shadow-sm">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-accent">Atrium</h1>
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
