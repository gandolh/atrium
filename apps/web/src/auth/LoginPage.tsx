import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useLogin, useSession, useWardSignIn } from "../../vendor/ward/ward-auth-react.js";
import { useAuthStore } from "../lib/auth";
import { listOfflineBooks } from "../lib/offline-store";
import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { authMessage, sessionReasonMessage } from "./messages";

/** Where atrium lives on the shared origin: the router's base, with its slash. */
const APP_ROOT = import.meta.env.BASE_URL;

/**
 * Atrium's own sign-in (D58). Rendered by `AuthGate` **in place**, on whatever
 * page the person opened, so a deep link survives signing in: once the
 * session exists the gate re-checks and the page they asked for renders.
 * `/login` is a real route too, because a refused "Sign in with Ward" lands
 * there (`/atrium/login?ward_error=…`), and once signed in it moves on to the
 * library.
 *
 * Two ways in, in this order: atrium's own username and password, which works
 * whether or not Ward is up, and "Sign in with Ward", shown only when the API
 * has Ward configured. There is no Register link: accounts come from the
 * operator's `npm run seed:user`, or from a first Ward sign-in by somebody Ward
 * holds an `atrium` grant for.
 *
 * Every message is atrium's (`messages.ts`); the library sends codes only.
 */
export function LoginPage() {
  useApplyTheme();
  const session = useSession();
  const { login, pending, error, reset } = useLogin();
  const ward = useWardSignIn();
  const checkStatus = useAuthStore((s) => s.checkStatus);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    ward.reset();
    if (await login(username.trim(), password)) {
      setPassword("");
      // The cookie is set; the gate's probe now answers with the profiles.
      await checkStatus();
    }
  }

  function signInWithWard() {
    reset();
    // Back to the page they opened, unless that was the login page itself.
    const here = `${window.location.pathname}${window.location.search}`;
    const returnTo = window.location.pathname.startsWith(`${APP_ROOT}login`) ? APP_ROOT : here;
    void ward.signIn({ returnTo });
  }

  // One notice at a time, most specific first: what just failed, then why the
  // last session ended.
  const notice =
    (error && authMessage(error)) ??
    (ward.error && authMessage(ward.error)) ??
    (session.status === "signed_out" ? sessionReasonMessage(session.reason) : null) ??
    (session.status === "error" ? authMessage(session.error) : null);
  const wardEnabled = session.status === "signed_out" && session.ward.enabled;

  return (
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] items-center justify-center bg-paper px-5 py-12">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col gap-2">
          <p className="font-display text-2xl font-semibold tracking-tight text-accent">Atrium</p>
          <h1 className="font-display text-3xl font-medium tracking-tight text-ink">Sign in</h1>
          <p className="font-ui text-sm text-ink-variant">Your library, notes and reading, where you left them.</p>
        </div>

        {notice && (
          <p
            role="alert"
            className="rounded-card border border-line-soft/70 bg-paper-low/60 px-4 py-3 font-ui text-sm text-ink tabular-nums"
          >
            {notice}
          </p>
        )}

        <form onSubmit={submit} className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="font-ui text-sm font-medium text-ink-variant">Username</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border-b border-line-soft bg-transparent px-1 py-1.5 font-ui text-base text-ink outline-none transition focus:border-b-2 focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-ui text-sm font-medium text-ink-variant">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border-b border-line-soft bg-transparent px-1 py-1.5 font-ui text-base text-ink outline-none transition focus:border-b-2 focus:border-accent"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-ink-fill px-4 py-2 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {wardEnabled && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-line-soft" />
              <span className="font-ui text-xs text-ink-variant">or</span>
              <span className="h-px flex-1 bg-line-soft" />
            </div>
            <button
              type="button"
              disabled={ward.pending}
              onClick={signInWithWard}
              className="rounded-card border border-line-soft px-4 py-2 font-ui text-sm font-medium text-ink transition hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
            >
              {ward.pending ? "Going to Ward…" : "Sign in with Ward"}
            </button>
          </div>
        )}

        <DownloadedBooks />
      </div>
    </div>
  );
}

/**
 * Reading what is already on the device without signing in (brief 77): the
 * library falls back to its downloads when its fetch fails. Offered only when
 * there is something downloaded. Any profile's downloads, because the shelf is
 * device-scoped (brief 20) and nobody has said who is reading yet.
 */
function DownloadedBooks() {
  const navigate = useNavigate();
  const continueWithoutSignIn = useAuthStore((s) => s.continueWithoutSignIn);
  const [downloaded, setDownloaded] = useState(0);

  useEffect(() => {
    let live = true;
    void listOfflineBooks(null).then((books) => {
      if (live) setDownloaded(books.length);
    });
    return () => {
      live = false;
    };
  }, []);

  if (downloaded === 0) return null;
  return (
    <button
      type="button"
      className="self-start font-ui text-sm text-ink-variant underline transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      onClick={() => {
        continueWithoutSignIn();
        void navigate({ to: "/books" });
      }}
    >
      Read downloaded books
    </button>
  );
}
