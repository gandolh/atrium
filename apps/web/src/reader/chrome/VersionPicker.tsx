import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import type { Format, LibraryBook } from "@ebook-reader/shared";

import { ApiError } from "../../lib/api-client";
import { fetchBookFile, type LibraryVersionsResult } from "../../lib/library-api";
import { useBookVersions, useDeleteBookVersion } from "../../lib/use-library";
import { useReaderStore } from "../../store/reader-store";
import { useChromeHold } from "./use-auto-hide-chrome";
import { MOTION_MS } from "../../lib/motion";

/**
 * The reader's version picker (brief 38 step 7, decisions 8–11) — a QUIET
 * control, not a feature to advertise. Reader chrome only: mounted as a
 * floating sibling of `PdfReader` in `routes/read.tsx`, never inside it —
 * `PdfReader` stays byte-for-byte unmodified (the brief's own constraint: a
 * `contain: layout` wrapper is the precedent for embedding it without edits,
 * but this reader already fills the true viewport, so a plain `fixed` sibling
 * suffices). It reads/writes the shared reader store directly (`loadedFile`,
 * `loadedVersionId`) exactly like `ConvertControl` reads it via hooks — no
 * prop plumbing back through `PdfReader` is needed for a version switch to
 * take effect.
 *
 * Renders nothing below two versions (an ordinary upload has none; a
 * freshly-published document has exactly one) — the `!open` half of the
 * render guard below. Once open with ≥2 rows, it keeps showing through a
 * delete that drops the count to one, so "delete the very last version" (the
 * one path that removes the whole library entry, decision 11) stays reachable
 * from the SAME session instead of vanishing out from under whoever is mid
 * cleanup.
 */
export function VersionPicker({ book }: { book: LibraryBook }) {
  const chromeVisible = useReaderStore((s) => s.chromeVisible);
  const loadedBookId = useReaderStore((s) => s.loadedBookId);
  const loadedVersionId = useReaderStore((s) => s.loadedVersionId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Only ever asked for a published document — every other source answers
  // truthfully with `versions: []`, but there's no reason to ask for one.
  const versionsQuery = useBookVersions(book.id, book.source === "latex");
  const deleteVersion = useDeleteBookVersion(book.id);

  const [open, setOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useChromeHold(open);

  const switchingRef = useRef(false);

  /**
   * Fetch `versionId`'s bytes and load them (decision 10). `preserveLocation`
   * is true ONLY when `versionId` is the version the stored `locator` was
   * measured in (`currentVersionId`) — every other switch starts at page 0,
   * ignoring whatever locator happens to be on file for a DIFFERENT version's
   * page numbering.
   */
  const switchToVersion = useCallback(
    async (versionId: string, preserveLocation: boolean) => {
      if (switchingRef.current) return;
      switchingRef.current = true;
      setBusyId(versionId);
      setActionError(null);
      try {
        const file = await fetchBookFile(book, undefined, versionId);
        const initialLocation = preserveLocation ? pageFromLocator(book.locator) : null;
        useReaderStore
          .getState()
          .setLoadedBook(file, book.format as Format, book.id, initialLocation, versionId);
      } catch {
        setActionError("Couldn't open that version.");
      } finally {
        switchingRef.current = false;
        setBusyId(null);
      }
    },
    [book],
  );

  // Default selection, once (decision 9): `currentVersionId` if it still names
  // a version, else the newest. `loadedVersionId !== null` is the "already
  // resolved" guard — the very first hydrate (`useHydrateBook`, untouched by
  // this chunk) always fetches the newest with no `?version=` and seeds
  // `loadedVersionId: null`; this effect either cheaply tags that fetch as
  // correct or, for the rarer case of a profile pinned to an older version,
  // fetches the right bytes and swaps them in.
  //
  // **Falling back because the stored version is GONE is a version mismatch,
  // and decision 10 says a mismatch starts at page 0 — even when the fallback
  // happens to equal the newest id.** That last clause is the whole bug this
  // guard exists for: read v2 at page 40, someone deletes v2 (not the last, so
  // the book survives), reopen. The unversioned hydrate has already seeded
  // `initialLocation = 40` from the stale locator, `pickDefaultVersion` falls
  // back to the newest — and because that newest id *is* `versions[0].id`, the
  // effect used to take the cheap "already correct, nothing to refetch" branch
  // and only tag the version, never resetting the position. The reader opened a
  // document at page 40, a number never measured against it.
  //
  // So the two questions are separated: WHICH bytes to load (do we need a
  // refetch?) and WHETHER the stored locator belongs to them.
  useEffect(() => {
    const data = versionsQuery.data;
    if (!data || data.versions.length <= 1) return;
    if (loadedBookId !== book.id || loadedVersionId !== null) return;
    const defaultId = pickDefaultVersion(data);
    // The stored locator was measured in `currentVersionId` and nowhere else.
    // `currentVersionId === null` (never recorded, or nulled by a version
    // delete) can pair with nothing, so it never preserves a location either.
    const keepLocation = data.currentVersionId !== null && defaultId === data.currentVersionId;

    if (defaultId !== data.versions[0].id) {
      // A profile pinned to an older version: different bytes, so fetch them.
      // `keepLocation` is necessarily true here — the only way `defaultId` is
      // not the newest is that it IS the still-present `currentVersionId`.
      void switchToVersion(defaultId, keepLocation);
      return;
    }

    const state = useReaderStore.getState();
    if (keepLocation || !state.loadedFile) {
      // Bytes already correct and the locator belongs to them: just attach the
      // label, exactly as before. (With no `loadedFile` there is nothing to
      // re-tag in place — leave the id set and let the reader seed itself.)
      state.setLoadedVersionId(defaultId);
      return;
    }

    // Bytes already correct, locator NOT ours. Reset the position without
    // re-downloading a file we already have — `switchToVersion` would refetch
    // the identical bytes, which on a large PDF is a real download to undo a
    // page number. Both halves of the position have to go:
    //  - `setLoadedBook` clears `initialLocation` (what a future `PdfReader`
    //    mount would resume to) and `progressFraction`, and tags the version;
    //  - `setCurrentLocation` moves the reader that is ALREADY mounted, which
    //    the store update alone cannot do — `PdfReader` re-reads
    //    `initialLocation` only when the `file` identity changes, and this hands
    //    it the very same `File`.
    // Page 1 is a PDF's page 0: it is where `switchToVersion(id, false)` lands
    // too (`initialLocation: null` → `PdfReader`'s mount effect picks 1).
    state.setLoadedBook(state.loadedFile, book.format as Format, book.id, null, defaultId);
    state.setCurrentLocation(1);
  }, [versionsQuery.data, book.id, book.format, loadedBookId, loadedVersionId, switchToVersion]);

  const data = versionsQuery.data;
  if (!data) return null;
  if (data.versions.length <= 1 && !open) return null;

  const activeId = loadedVersionId ?? pickDefaultVersion(data);

  const onSelect = (versionId: string) => {
    if (versionId === activeId || busyId) return;
    setOpen(false);
    void switchToVersion(versionId, versionId === data.currentVersionId);
  };

  const onConfirmDelete = async (versionId: string) => {
    const current = versionsQuery.data;
    if (!current) return;
    const isLast = current.versions.length === 1;
    const deletingActive = versionId === activeId;
    setBusyId(versionId);
    setActionError(null);
    try {
      await deleteVersion.mutateAsync(versionId);
      if (isLast) {
        // Decision 11: the whole library entry — row, PDF, zip — is gone with
        // it. Refresh the GALLERY (every profile's view), not just this
        // picker, and leave the reading session behind: there is nothing left
        // to read.
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        setOpen(false);
        void navigate({ to: "/" });
        return;
      }
      setConfirmingId(null);
      if (deletingActive) {
        // We just deleted the version we were reading. The server nulls this
        // profile's `reading_progress.version_id` on delete (`ON DELETE SET
        // NULL`), so the freshly-refetched `currentVersionId` already reflects
        // that — same default-selection rule, now landing on whatever's left.
        const refreshed = await versionsQuery.refetch();
        if (refreshed.data) {
          const nextId = pickDefaultVersion(refreshed.data);
          void switchToVersion(nextId, nextId === refreshed.data.currentVersionId);
        }
      }
    } catch (err) {
      setActionError(libraryErrorMessage(err, "Couldn't delete that version."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className={`pointer-events-none fixed right-3 top-2.5 z-20 sm:right-5 sm:top-3 transition-opacity ease-paper motion-reduce:transition-none ${
        chromeVisible ? "opacity-100" : "opacity-0"
      }`}
      style={{ transitionDuration: `${chromeVisible ? MOTION_MS.chromeIn : MOTION_MS.chromeOut}ms` }}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={`pointer-events-auto flex items-center gap-1.5 rounded-card border border-reader-border/70 bg-reader-surface/90 px-2.5 py-1 font-ui text-xs text-reader-fg/75 shadow-l1 backdrop-blur transition hover:text-reader-fg focus-visible:outline-2 focus-visible:outline-reader-accent ${
            chromeVisible ? "" : "pointer-events-none"
          }`}
          aria-label="Choose a version"
        >
          <span className="tabular-nums">
            Version {data.versions.find((v) => v.id === activeId)?.versionNo ?? "…"}
          </span>
          <ChevronIcon open={open} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
            <Popover.Popup className="w-72 rounded-card border border-reader-border bg-reader-bg p-3 text-reader-fg shadow-l1 transition data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-reduce:transition-none">
              <Popover.Title className="mb-2 px-1 font-ui text-[11px] font-semibold uppercase tracking-[0.15em] text-reader-fg/55">
                Versions
              </Popover.Title>
              <ul className="flex flex-col gap-0.5">
                {data.versions.map((version) => (
                  <VersionRow
                    key={version.id}
                    versionNo={version.versionNo}
                    publishedAt={version.publishedAt}
                    active={version.id === activeId}
                    busy={busyId === version.id}
                    confirming={confirmingId === version.id}
                    onSelect={() => onSelect(version.id)}
                    onRequestDelete={() => {
                      setActionError(null);
                      setConfirmingId(version.id);
                    }}
                    onCancelDelete={() => setConfirmingId(null)}
                    onConfirmDelete={() => void onConfirmDelete(version.id)}
                  />
                ))}
              </ul>
              {actionError && (
                <p role="alert" className="mt-2 px-1 font-ui text-xs text-danger">
                  {actionError}
                </p>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** Currently-published-version selection rule (decision 9): stick with the
 * version this profile's progress is recorded against, if it still exists;
 * otherwise the newest (`versions` is newest-first). Shared by the mount
 * effect and the post-delete recovery path so the two can never disagree.
 *
 * It answers WHICH version to open and nothing else. Whether the stored
 * `locator` may come along is a separate question every caller asks for itself
 * (`id === data.currentVersionId`), because the answers differ: this can return
 * the newest id as a FALLBACK from a deleted version, which is a version
 * mismatch, and decision 10 starts those at page 0. */
function pickDefaultVersion(data: LibraryVersionsResult): string {
  const stillPresent =
    data.currentVersionId !== null && data.versions.some((v) => v.id === data.currentVersionId);
  return stillPresent ? (data.currentVersionId as string) : data.versions[0].id;
}

/** PDF-only (every versioned document is one — publishing produces nothing
 * else): the stored locator is a bare page number, same parse as
 * `use-hydrate-book.ts`'s `resumeLocation` for the pdf branch. */
function pageFromLocator(locator: string | null): number | null {
  if (!locator) return null;
  const page = Number(locator);
  return Number.isFinite(page) && page >= 1 ? page : null;
}

/** Mirrors `ConvertControl.tsx`'s local `messageFor` — `/library` routes
 * answer `{ error: "<prose>" }` (the code field IS the message), unlike
 * `/latex`'s `{ error: CODE, message: "<prose>" }`. Kept local rather than
 * shared: each `/library` consumer in this codebase already has its own tiny
 * copy rather than a shared mapper. */
function libraryErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object" && "error" in err.body) {
    const message = (err.body as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

function VersionRow({
  versionNo,
  publishedAt,
  active,
  busy,
  confirming,
  onSelect,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  versionNo: number;
  publishedAt: string;
  active: boolean;
  busy: boolean;
  confirming: boolean;
  onSelect: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-1 rounded-card px-1 py-1 transition hover:bg-reader-surface">
      <button
        type="button"
        onClick={onSelect}
        disabled={active || busy}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-card px-1.5 py-1 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-reader-accent" : "bg-transparent"}`}
          />
          <span
            className={`tabular-nums font-ui text-sm ${active ? "font-semibold text-reader-fg" : "text-reader-fg/85"}`}
          >
            Version {versionNo}
          </span>
        </span>
        <span className="shrink-0 tabular-nums font-ui text-xs text-reader-fg/55">
          {formatVersionDate(publishedAt)}
        </span>
      </button>

      {confirming ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onConfirmDelete}
            disabled={busy}
            className="rounded-card px-1.5 py-1 font-ui text-[11px] font-semibold text-danger transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-reader-accent"
          >
            Delete?
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            disabled={busy}
            className="rounded-card px-1.5 py-1 font-ui text-[11px] text-reader-fg/70 transition hover:text-reader-fg focus-visible:outline-2 focus-visible:outline-reader-accent"
          >
            No
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Delete version ${versionNo}`}
          onClick={onRequestDelete}
          disabled={busy}
          className="shrink-0 rounded-card p-1.5 text-reader-fg/45 transition hover:text-danger disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-reader-accent"
        >
          <TrashIcon />
        </button>
      )}
    </li>
  );
}

const versionDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatVersionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : versionDateFormatter.format(date);
}

/** 1.75-stroke chevron, matching the reader chrome's icon set — rotates open,
 * with the same reduced-motion path every other chrome disclosure uses. */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className={`h-3 w-3 shrink-0 transition-transform duration-200 ease-paper motion-reduce:transition-none ${
        open ? "rotate-180" : ""
      }`}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6M14 11v6" />
    </svg>
  );
}
