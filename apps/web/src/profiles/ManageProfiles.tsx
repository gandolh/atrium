import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_PROFILES_PER_ACCOUNT, PROFILE_COLORS, type Profile, type ProfileColor } from "@ebook-reader/shared";

import { AppHeader } from "../components/AppHeader";
import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { useAuthStore } from "../lib/auth";
import { createProfile, deleteProfile, updateProfile } from "../lib/profiles-api";
import { PROFILE_COLOR_LABEL, profileTintClass, suggestProfileColor } from "../lib/profile-colors";
import { noteCountFrom, profileErrorMessage } from "./profile-errors";

/**
 * `/profiles` (brief 35 Part C) — create / rename / recolour / delete, capped
 * at `MAX_PROFILES_PER_ACCOUNT`. Shares the app shell (`AppHeader`) like
 * `/notes`, so the wordmark, search-less nav and theme control stay put; this
 * is a settings surface, not a media destination, so it gets the same plain
 * left-aligned-column treatment `NotesList` uses rather than a tinted tile
 * grid (the grid belongs to the picker's "quiet typographic grid", not to a
 * form-heavy management screen).
 *
 * The two rules the server enforces are enforced here FIRST, so the failure
 * mode a user sees is never a confusing one:
 *  - "Add profile" is hidden past the cap (server would otherwise answer a
 *    duplicate name at the cap with PROFILE_LIMIT instead of NAME_TAKEN).
 *  - the default profile is never offered Delete (server: 400 DEFAULT_PROFILE
 *    — nothing can promote a replacement default, so deleting it would break
 *    the auth guard's fallback).
 */
export function ManageProfiles() {
  useApplyTheme();
  const profiles = useAuthStore((s) => s.profiles);
  const refreshProfiles = useAuthStore((s) => s.refreshProfiles);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);

  const atCap = profiles.length >= MAX_PROFILES_PER_ACCOUNT;
  const defaultProfile = profiles.find((p) => p.isDefault);

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-3xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
      <AppHeader />

      <section aria-label="Profiles" className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl font-semibold text-ink">Profiles</h1>
          <p className="font-ui text-sm text-ink-variant">
            Up to {MAX_PROFILES_PER_ACCOUNT} people in this account, each with their own reading
            progress, notes and settings.{" "}
            <span className="tabular-nums">
              {profiles.length} of {MAX_PROFILES_PER_ACCOUNT}
            </span>
          </p>
        </div>

        <div className="flex flex-col divide-y divide-line-soft/60 rounded-card border border-line-soft/70">
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              onSaved={refreshProfiles}
              onRequestDelete={() => setDeleteTarget(profile)}
            />
          ))}
        </div>

        {atCap ? (
          <p className="rounded-card border border-line-soft/60 bg-paper-low/60 px-4 py-3 font-ui text-sm text-ink-variant">
            This account is full. Delete a profile to add another.
          </p>
        ) : (
          <CreateProfileForm existingColors={profiles.map((p) => p.color)} onCreated={refreshProfiles} />
        )}
      </section>

      {deleteTarget && (
        <DeleteProfileDialog
          profile={deleteTarget}
          defaultName={defaultProfile?.name ?? "Default"}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            void refreshProfiles();
          }}
        />
      )}
    </main>
  );
}

/** One profile's row: colour + name (or its inline rename/recolour form) + actions. */
function ProfileRow({
  profile,
  onSaved,
  onRequestDelete,
}: {
  profile: Profile;
  onSaved: () => Promise<void>;
  onRequestDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState<ProfileColor>(profile.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setName(profile.name);
    setColor(profile.color);
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A name is required.");
      return;
    }
    const nextName = trimmed !== profile.name ? trimmed : undefined;
    const nextColor = color !== profile.color ? color : undefined;
    // Nothing changed. Sending `{}` makes the server's `updateProfileSchema`
    // refinement reject the empty patch as INVALID_REQUEST, which the client
    // renders as "Names must be 1–24 characters." — a confusing complaint
    // about a name the user never touched. Closing the form is what they meant
    // by Save anyway.
    if (!nextName && !nextColor) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateProfile(profile.id, { name: nextName, color: nextColor });
      await onSaved();
      setEditing(false);
    } catch (err) {
      setError(profileErrorMessage(err, "Couldn't save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-3 px-4 py-4">
        <div className="flex items-center gap-3">
          <ColorSwatch color={color} large />
          <label className="flex-1">
            <span className="sr-only">Profile name</span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              className="w-full border-b border-line-soft bg-transparent px-1 py-1.5 font-ui text-sm text-ink outline-none transition focus:border-b-2 focus:border-accent"
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          {PROFILE_COLORS.map((c) => (
            <ColorPickerSwatch key={c} color={c} selected={c === color} onSelect={() => setColor(c)} />
          ))}
        </div>

        {error && (
          <p role="alert" className="font-ui text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-ink-fill px-3 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(false)}
            className="rounded-card px-3 py-1.5 font-ui text-sm text-ink-variant transition hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <ColorSwatch color={profile.color} large />
      <div className="min-w-0 flex-1">
        <p className="truncate font-ui text-sm font-semibold text-ink">{profile.name}</p>
        {profile.isDefault && (
          <p className="font-ui text-xs text-ink-variant">Default — can&rsquo;t be deleted</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={startEdit}
          className="rounded-card px-2.5 py-1.5 font-ui text-sm text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          Edit
        </button>
        {!profile.isDefault && (
          <button
            type="button"
            onClick={onRequestDelete}
            className="rounded-card px-2.5 py-1.5 font-ui text-sm text-ink-variant transition hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/** "Add profile" form, pre-selecting the first colour not already in use (`profile-colors.ts`). */
function CreateProfileForm({
  existingColors,
  onCreated,
}: {
  existingColors: readonly ProfileColor[];
  onCreated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProfileColor>(() => suggestProfileColor(existingColors));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openForm() {
    setName("");
    setColor(suggestProfileColor(existingColors));
    setError(null);
    setOpen(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createProfile({ name: trimmed, color });
      await onCreated();
      setOpen(false);
    } catch (err) {
      setError(profileErrorMessage(err, "Couldn't create this profile. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openForm}
        className="self-start rounded-card border border-line-soft px-4 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        + Add profile
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-card border border-line-soft/70 p-4"
    >
      <label className="flex flex-col gap-1.5">
        <span className="font-ui text-sm font-medium text-ink-variant">Name</span>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          placeholder="e.g. Sam"
          className="w-full border-b border-line-soft bg-transparent px-1 py-1.5 font-ui text-sm text-ink outline-none transition focus:border-b-2 focus:border-accent"
        />
      </label>

      <div className="flex items-center gap-2">
        {PROFILE_COLORS.map((c) => (
          <ColorPickerSwatch key={c} color={c} selected={c === color} onSelect={() => setColor(c)} />
        ))}
      </div>

      {error && (
        <p role="alert" className="font-ui text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-ink-fill px-4 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add profile"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(false)}
          className="rounded-card px-3 py-1.5 font-ui text-sm text-ink-variant transition hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Delete confirm, escalating in place (brief Part C: "show what is lost
 * before it happens"). Stage one always asks about progress, since deleting
 * ALWAYS drops it (`reading_progress` cascades) regardless of notes. The
 * first `deleteProfile` call carries no `reassign` flag; if the server
 * answers 409 `PROFILE_HAS_NOTES`, the dialog re-renders in place naming the
 * count and offering the move rather than a second silent attempt — the note
 * count only exists because that first call asked.
 */
function DeleteProfileDialog({
  profile,
  defaultName,
  onCancel,
  onDeleted,
}: {
  profile: Profile;
  defaultName: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  async function confirm(reassign: boolean) {
    setBusy(true);
    setError(null);
    try {
      await deleteProfile(profile.id, reassign ? { reassign: true } : undefined);
      onDeleted();
    } catch (err) {
      const notes = noteCountFrom(err);
      if (notes !== null && !reassign) {
        // The server just told us what "delete" would destroy — escalate the
        // dialog to name it instead of retrying blind.
        setNoteCount(notes);
      } else {
        setError(profileErrorMessage(err, "Couldn't delete this profile. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 backdrop-blur-md"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-profile-title"
        className="w-full max-w-sm rounded-card border border-line-soft bg-paper-raised p-6 shadow-lift"
      >
        <h2 id="delete-profile-title" className="font-display text-xl font-semibold text-ink">
          Delete {profile.name}?
        </h2>

        {noteCount === null ? (
          <p className="mt-2 font-ui text-sm text-ink-variant">
            Their reading progress will be permanently removed. This can&rsquo;t be undone.
          </p>
        ) : (
          <p className="mt-2 font-ui text-sm text-ink-variant">
            <span className="font-semibold text-ink">{profile.name}</span> has{" "}
            <span className="tabular-nums">{noteCount}</span> note{noteCount === 1 ? "" : "s"}. Deleting
            will move {noteCount === 1 ? "it" : "them"} to <span className="font-semibold text-ink">{defaultName}</span>.
            Reading progress is still permanently removed.
          </p>
        )}

        {error && (
          <p role="alert" className="mt-3 font-ui text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-card px-3 py-1.5 font-ui text-sm text-ink-variant transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => confirm(noteCount !== null)}
            className="rounded bg-ink-fill px-3 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Deleting…" : noteCount === null ? "Delete" : "Move notes & delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small tile swatch (never a circle — see `ProfileSwitcher`'s `ColorSwatch` comment). */
function ColorSwatch({ color, large = false }: { color: ProfileColor; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={`shrink-0 rounded-(--radius-cover) border border-line-soft/60 ${profileTintClass(color)} ${
        large ? "h-8 w-8" : "h-3.5 w-3.5"
      }`}
    />
  );
}

/** One selectable swatch in the colour row — selection uses `accent` (state only). */
function ColorPickerSwatch({
  color,
  selected,
  onSelect,
}: {
  color: ProfileColor;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={PROFILE_COLOR_LABEL[color]}
      title={PROFILE_COLOR_LABEL[color]}
      onClick={onSelect}
      className={`h-7 w-7 rounded-(--radius-cover) border-2 transition ${profileTintClass(color)} ${
        selected ? "border-accent" : "border-line-soft/60 hover:border-line"
      }`}
    />
  );
}
