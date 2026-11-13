import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/Menu";
import { useActiveProfile, useAuthStore } from "../lib/auth";
import { profileTintClass } from "../lib/profile-colors";

/**
 * Always reachable regardless of the 24h picker rule (D35 decision 6), because the "Who's reading?" gate only fires on
 * a stale/missing device choice; a household member switching mid-session needs a door that's open every time. It sits
 * at the rail's foot at 1280 (`variant="rail"`, full width, the menu opening above it) and in the phone top bar
 * (`variant="bar"`, compact).
 *
 * Base UI's `Menu`, like `CoverCard`'s per-card overflow menu: Enter, Space or ArrowDown on the trigger opens it, the
 * arrows move, Enter or Space runs an item and Esc closes it and returns to the trigger. The profiles are a radio
 * group of menu items; "Manage profiles" and "Account" (the D58 settings page with sign-out) navigate imperatively.
 */
export function ProfileSwitcher({ variant = "bar" }: { variant?: "rail" | "bar" }) {
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
  const activeId = active.id;

  async function handleSwitch(id: string) {
    if (id === activeId) {
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
    <div className={variant === "rail" ? "relative w-full" : "relative shrink-0"}>
      {/* modal={false}: the page stays scrollable and clickable behind the open menu. */}
      <Menu open={open} onOpenChange={setOpen} modal={false}>
        <MenuTrigger
          className={`flex h-11 items-center gap-2 rounded-card border border-line bg-paper-raised px-3 font-ui text-ui font-medium text-ink-variant transition hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-accent ${variant === "rail" ? "w-full text-left" : ""}`}
        >
          <ColorSwatch color={active.color} />
          <span className={`text-ink ${variant === "rail" ? "min-w-0 flex-1" : "max-w-24 truncate"}`}>
            {active.name}
          </span>
          <ChevronGlyph className="h-4 w-4" />
        </MenuTrigger>
        <MenuPopup
          side={variant === "rail" ? "top" : "bottom"}
          align={variant === "rail" ? "start" : "end"}
          aria-label="Switch profile"
          className="w-56 overflow-hidden rounded-card border border-line bg-paper-raised shadow-float"
        >
          <MenuGroup>
            <MenuGroupLabel className="border-b border-line px-3 py-2 font-ui text-micro font-semibold text-ink-variant">
              Switch profile
            </MenuGroupLabel>
            <MenuRadioGroup value={activeId} onValueChange={(id) => void handleSwitch(id)}>
              {profiles.map((profile) => (
                <MenuRadioItem
                  key={profile.id}
                  value={profile.id}
                  // Choosing someone else keeps the menu open until the switch is done, so a failure can be said
                  // inside it. Choosing the active profile changes nothing, so it just closes.
                  closeOnClick={profile.id === activeId}
                  disabled={pendingId !== null}
                  className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left font-ui text-ui text-ink outline-none data-checked:font-semibold data-checked:text-accent data-disabled:opacity-60 data-highlighted:bg-paper-low"
                >
                  <ColorSwatch color={profile.color} />
                  <span className="truncate">{pendingId === profile.id ? "Switching…" : profile.name}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {error && (
            <p role="alert" className="px-3 py-1.5 font-ui text-xs text-danger">
              {error}
            </p>
          )}
          <MenuItem
            onClick={() => void navigate({ to: "/profiles" })}
            className="block w-full cursor-default border-t border-line px-3 py-2 text-left font-ui text-ui text-ink-variant outline-none data-highlighted:bg-paper-low data-highlighted:text-ink"
          >
            Manage profiles
          </MenuItem>
          <MenuItem
            onClick={() => void navigate({ to: "/settings" })}
            className="block w-full cursor-default px-3 py-2 text-left font-ui text-ui text-ink-variant outline-none data-highlighted:bg-paper-low data-highlighted:text-ink"
          >
            Account
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * A profile's colour as a small tile, not a dot — design.md's radius rule
 * reserves `rounded-full` for genuinely circular affordances (the scrub rail,
 * the note editor's ink swatches/nib dots) and nothing else, and
 * `profile-colors.ts` says the same thing from the other side: "a square
 * colour swatch reads as a tile" is the point, not an accident. a 5 px corner.
 */
function ColorSwatch({ color }: { color: Parameters<typeof profileTintClass>[0] }) {
  return <span aria-hidden className={`h-4 w-4 shrink-0 rounded-sm border border-line ${profileTintClass(color)}`} />;
}

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}
