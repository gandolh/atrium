import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  useChangePassword,
  useLogout,
  useSession,
  useSetLocalPassword,
  useWardLink,
  useWardResult,
  useWardSignOut,
  useWardUnlink,
} from "../../vendor/ward/ward-auth-react.js";
import { AppHeader } from "../components/AppHeader";
import { useAuthStore } from "../lib/auth";
import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { authMessage } from "./messages";

/**
 * `/settings` — the account (D58): its password, its Ward link, signing out.
 *
 * The same plain left-aligned column as `/profiles`, its sibling: a settings
 * surface, not a media destination. Profiles are people inside the account;
 * this page is the account itself, the household's key.
 *
 * Ward round trips end here. Linking, and confirming it's you before a first
 * password, both leave for Ward and come back to `/atrium/settings?ward=…`;
 * the auth client reads that once at startup, and the hooks below report it.
 */
export function AccountSettings() {
  useApplyTheme();
  const session = useSession();
  const signedOut = useAuthStore((s) => s.signedOut);

  /*
   * Every way this page can end the session lands here: signing out, signing
   * out of Ward too, and unlinking Ward from a session that began with it. The
   * hooks' state says signed out first; the store follows, and the gate puts
   * the login page up.
   */
  useEffect(() => {
    if (session.status === "signed_out") signedOut();
  }, [session.status, signedOut]);

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-3xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
      <AppHeader />

      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-semibold text-ink">Account</h1>
        {session.status === "signed_in" && (
          <p className="font-ui text-sm text-ink-variant">
            Signed in as <span className="font-semibold text-ink">{session.user.username}</span>
            {session.session.origin === "ward" ? " with Ward." : " with your password."}
          </p>
        )}
      </div>

      {session.status === "signed_in" ? (
        <>
          <WardResult />
          {session.user.hasPassword ? <ChangePassword /> : <FirstPassword />}
          {session.ward.enabled && <WardLink linked={session.ward.linked} hasPassword={session.user.hasPassword} />}
          <SignOut wardSession={session.session.origin === "ward"} />
        </>
      ) : (
        <p className="font-ui text-sm text-ink-variant">Loading…</p>
      )}
    </main>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-card border border-line-soft/70 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-medium text-ink">{title}</h2>
        {description && <p className="font-ui text-sm text-ink-variant">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const INPUT =
  "w-full border-b border-line-soft bg-transparent px-1 py-1.5 font-ui text-sm text-ink outline-none transition focus:border-b-2 focus:border-accent";
const PRIMARY =
  "self-start rounded bg-ink-fill px-4 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const SECONDARY =
  "self-start rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60";

function PasswordField({
  label,
  autoComplete,
  value,
  onChange,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex max-w-sm flex-col gap-1.5">
      <span className="font-ui text-sm font-medium text-ink-variant">{label}</span>
      <input
        type="password"
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    </label>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="font-ui text-sm text-danger tabular-nums">
      {children}
    </p>
  );
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="font-ui text-sm text-ink">
      {children}
    </p>
  );
}

/** What the last Ward round trip came back with, if this page load is its end. */
function WardResult() {
  const { result, error, clear } = useWardResult();
  if (!result && !error) return null;
  const text =
    result === "linked"
      ? "Your Ward account is linked. You can sign in with it from now on."
      : result === "reauthenticated"
        ? "Ward confirmed it's you. Set your password below."
        : authMessage(error!);
  return (
    <div className="flex items-start justify-between gap-4 rounded-card border border-line-soft/70 bg-paper-low/60 px-4 py-3">
      <p role="status" className="font-ui text-sm text-ink">
        {text}
      </p>
      <button
        type="button"
        onClick={clear}
        className="shrink-0 font-ui text-sm text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        Dismiss
      </button>
    </div>
  );
}

/** A password change, for an account that has one. Ends its other sessions. */
function ChangePassword() {
  const { changePassword, pending, error, done } = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await changePassword(current, next)) {
      setCurrent("");
      setNext("");
    }
  }

  return (
    <Section title="Password" description="Changing it signs out every other device on this account.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} />
        <PasswordField label="New password" autoComplete="new-password" value={next} onChange={setNext} />
        {error && <Alert>{authMessage(error)}</Alert>}
        {done && !error && <Done>Password changed.</Done>}
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Saving…" : "Change password"}
        </button>
      </form>
    </Section>
  );
}

/**
 * A first Atrium password, for an account made by a Ward sign-in. It is what
 * lets that person in while Ward is down. Allowed within ten minutes of a Ward
 * sign-in; after that Ward asks for its own password first.
 */
function FirstPassword() {
  const local = useSetLocalPassword();
  const [next, setNext] = useState("");

  // On success the session is re-read, `hasPassword` turns true, and this
  // section gives way to the password change.
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await local.setPassword(next)) setNext("");
  }

  const needsWard = local.error?.code === "reauthentication_required";
  return (
    <Section
      title="Atrium password"
      description="This account signs in with Ward only. Set a password so you can still get in while Ward is down."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <PasswordField label="New password" autoComplete="new-password" value={next} onChange={setNext} />
        {local.error && <Alert>{authMessage(local.error)}</Alert>}
        {local.done && !local.error && <Done>Password set.</Done>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={local.pending} className={PRIMARY}>
            {local.pending ? "Saving…" : "Set password"}
          </button>
          {needsWard && (
            <button type="button" onClick={() => void local.reauthenticate()} className={SECONDARY}>
              Confirm with Ward
            </button>
          )}
        </div>
      </form>
    </Section>
  );
}

/** Link a Ward account to this one, or unlink it. Never matched by name: you link your own. */
function WardLink({ linked, hasPassword }: { linked: boolean; hasPassword: boolean }) {
  const link = useWardLink();
  // Unlinking ends every session that began with Ward, this one included if
  // it did; the page's effect then hands over to the login page.
  const unlink = useWardUnlink();

  if (!linked) {
    return (
      <Section title="Ward" description="Link your Ward account to sign in here with Ward as well as your password.">
        {link.error && <Alert>{authMessage(link.error)}</Alert>}
        <button type="button" disabled={link.pending} onClick={() => void link.link()} className={SECONDARY}>
          {link.pending ? "Going to Ward…" : "Link Ward account"}
        </button>
      </Section>
    );
  }

  return (
    <Section
      title="Ward"
      description={
        hasPassword
          ? "Linked. You can sign in with Ward or with your password."
          : "Linked, and it's your only way in. Set a password above before unlinking."
      }
    >
      {unlink.error && <Alert>{authMessage(unlink.error)}</Alert>}
      <button type="button" disabled={unlink.pending} onClick={() => void unlink.unlink()} className={SECONDARY}>
        {unlink.pending ? "Unlinking…" : "Unlink Ward"}
      </button>
    </Section>
  );
}

/** Sign out here, or here and at Ward too when this session began with Ward. */
function SignOut({ wardSession }: { wardSession: boolean }) {
  const { logout, pending, error } = useLogout();
  const out = useWardSignOut();

  return (
    <Section title="Sign out" description="Atrium forgets this device's profile choice too.">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || out.pending}
          onClick={() => void logout()}
          className={PRIMARY}
        >
          {pending ? "Signing out…" : "Sign out"}
        </button>
        {wardSession && (
          <button
            type="button"
            disabled={pending || out.pending}
            // Ends this session, then leaves for Ward, which ends the Ward
            // session too and sends the browser back to Atrium.
            onClick={() => void out.signOut()}
            className={SECONDARY}
          >
            {out.pending ? "Signing out…" : "Sign out of Ward too"}
          </button>
        )}
      </div>
      {(error ?? out.error) && <Alert>{authMessage((error ?? out.error)!)}</Alert>}
    </Section>
  );
}
