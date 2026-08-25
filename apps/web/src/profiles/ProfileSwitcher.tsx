import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useActiveProfile, useAuthStore } from "../lib/auth";
import { profileTintClass } from "../lib/profile-colors";

/**
 * Header entry point (brief step 6, Part B) — always reachable regardless of
 * the 24h picker rule (D35 decision 6), because the "Who's reading?" gate
 * only fires on a stale/missing device choice; a household member switching
 * mid-session needs a door that's open every time. Fits the header's second
 * cluster (`AppHeader`'s "Notes · {actions} · theme" comment) as one more
 * item rather than a new row.
 *
 * Follows `CoverCard`'s per-card overflow menu exactly: `onBlur` on the
 * trigger closes the panel, and every menu item fires on `onMouseDown` (not
 * `onClick`) so the ACTION runs before that blur closes it. "Manage profiles"
 * navigates imperatively (`useNavigate`) in its own `onMouseDown`, rather than
 * a `Link`'s default click-to-navigate, for the same reason: the trigger's
 * `onBlur` fires on mousedown too, so a `Link` relying on the click that
 * follows would already be unmounted (the panel closed) by the time it fires.
 */
export function ProfileSwitcher() {
  const active = useActiveProfile();
  const profiles = useAuthStore((s) => s.profiles);
  const switchProfile = useAuthStore((s) => s.switchProfile);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Nothing to show before the boot reconcile (or login) resolves the active
  // profile — a fraction of a second on a returning device, but real.
  if (!active) return null;

  async function handleSwitch(id: string) {
    if (id === active!.id) {
      setOpen(false);
      return;
    }
    setError(null);
    setPendingId(id);
    try {
      await switchProfile(id);
      setOpen(false);
    } catch {
      // Store stays on the old profile (switchProfile's contract); keep the
      // panel open and say so rather than silently closing on a no-op.
      setError("Couldn't switch. Try again.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        className="flex items-center gap-2 rounded-card px-2 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ColorSwatch color={active.color} />
        <span className="max-w-24 truncate text-ink">{active.name}</span>
        <ChevronGlyph className="h-3 w-3" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Switch profile"
          className="absolute top-9 right-0 z-20 w-52 overflow-hidden rounded-card border border-line-soft bg-paper-raised shadow-lift"
        >
          <p className="border-b border-line-soft/60 px-3 py-2 font-ui text-[11px] font-semibold tracking-[0.08em] text-ink-variant uppercase">
            Switch profile
          </p>
          {profiles.map((profile) => {
            const isActive = profile.id === active!.id;
            return (
              <button
                key={profile.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                disabled={pendingId !== null}
                onMouseDown={() => handleSwitch(profile.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left font-ui text-sm transition disabled:cursor-default disabled:opacity-60 ${
                  isActive ? "font-semibold text-accent" : "text-ink hover:bg-paper-low"
                }`}
              >
                <ColorSwatch color={profile.color} />
                <span className="truncate">
                  {pendingId === profile.id ? "Switching…" : profile.name}
                </span>
              </button>
            );
          })}
          {error && (
            <p role="alert" className="px-3 py-1.5 font-ui text-xs text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            onMouseDown={() => {
              setOpen(false);
              void navigate({ to: "/profiles" });
            }}
            className="block w-full border-t border-line-soft/60 px-3 py-2 text-left font-ui text-sm text-ink-variant transition hover:bg-paper-low hover:text-ink"
          >
            Manage profiles
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A profile's colour as a small tile, not a dot — design.md's radius rule
 * reserves `rounded-full` for genuinely circular affordances (the scrub rail,
 * the note editor's ink swatches/nib dots) and nothing else, and
 * `profile-colors.ts` says the same thing from the other side: "a square
 * colour swatch reads as a tile" is the point, not an accident. `radius-cover`
 * (2px) is the same small-chip radius `CoverCard`'s artwork and duration
 * caption use.
 */
function ColorSwatch({ color }: { color: Parameters<typeof profileTintClass>[0] }) {
  return (
    <span
      aria-hidden
      className={`h-3.5 w-3.5 shrink-0 rounded-(--radius-cover) border border-line-soft/60 ${profileTintClass(color)}`}
    />
  );
}

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}
