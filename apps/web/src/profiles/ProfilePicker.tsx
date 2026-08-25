import { useState } from "react";
import type { Profile } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { useActiveProfileId, useAuthStore } from "../lib/auth";
import { profileTintClass } from "../lib/profile-colors";

/**
 * "Who's reading?" — the full-screen gate `AuthGate` mounts after the lock
 * screen passes and while `useNeedsPicker()` is true (brief decision 6: shown
 * once after login, then again only once the device has sat idle past
 * `PROFILE_PICKER_IDLE_MS`). Switching is free (D35 decision 5) — one tap, no
 * password, no PIN, so this renders no lock affordance at all, not even a
 * disabled one; a lock here would imply a protection this feature explicitly
 * doesn't have.
 *
 * Design (brief step 6, explicit): "a quiet typographic grid of name + color,
 * not Netflix's avatar wall." So no avatar circle, no initials badge — each
 * tile IS the profile's kind-tint ground with its name set in the interface
 * voice (design.md: a name here is a card label, same rule CoverCard's title
 * follows even though the words are "written"). The grid tiles hold the
 * colour signal the way a CoverCard's ground already does; nothing new is
 * invented for it.
 */
export function ProfilePicker() {
  // Every top-level surface applies the active theme itself (see LibraryHome,
  // NotesList, Discover) — this gate REPLACES the page tree while it's shown,
  // so without its own call `data-theme` would stay whatever the previous
  // page left it as, or unset on a first load.
  useApplyTheme();
  const profiles = useAuthStore((s) => s.profiles);
  const activeProfileId = useActiveProfileId();
  const switchProfile = useAuthStore((s) => s.switchProfile);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(id: string) {
    setError(null);
    setPendingId(id);
    try {
      await switchProfile(id);
      // On success the store flips `pickerRequired` to false and this gate
      // unmounts itself (AuthGate re-renders `children`) — nothing else to do.
    } catch {
      setError("Couldn't switch profiles. Check your connection and try again.");
      setPendingId(null);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] items-center justify-center bg-paper px-5 py-12">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
            Who&rsquo;s reading?
          </h1>
          <p className="font-ui text-sm text-ink-variant">Pick a profile to continue.</p>
        </div>

        {/* `role="group"`, not "list": each tile below is an interactive
            `<button>`, and overriding a button's implicit role with
            "listitem" is invalid ARIA — browsers drop the interactive
            semantics entirely, so a screen reader (or an accessibility-tree
            query) would lose the buttons. */}
        <div role="group" aria-label="Profiles" className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {profiles.map((profile) => (
            <ProfileTile
              key={profile.id}
              profile={profile}
              active={profile.id === activeProfileId}
              pending={pendingId === profile.id}
              disabled={pendingId !== null}
              onSelect={() => handleSelect(profile.id)}
            />
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-8 text-center font-ui text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function ProfileTile({
  profile,
  active,
  pending,
  disabled,
  onSelect,
}: {
  profile: Profile;
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active || undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-32 flex-col items-center justify-center gap-2 rounded-card border p-6 text-center transition-colors duration-300 ease-paper disabled:cursor-default disabled:opacity-60 ${profileTintClass(profile.color)} ${
        active ? "border-accent" : "border-line-soft/60 hover:border-line"
      }`}
    >
      <span className="font-ui text-base font-semibold tracking-[-0.01em] text-ink">
        {pending ? "Switching…" : profile.name}
      </span>
    </button>
  );
}
