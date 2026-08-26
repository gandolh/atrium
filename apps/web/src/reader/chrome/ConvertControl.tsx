import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { convertTargetForFormat, type FileType, type LibraryBook } from "@ebook-reader/shared";

import { ApiError } from "../../lib/api-client";
import { useCancelConvert, useConvertingBook, useStartConvert } from "../../lib/use-library";
import { SettingsPopover } from "./SettingsPopover";
import { ToolbarButton } from "./ReaderToolbar";

/**
 * The reader's convert status button + format switch (brief 34 step 6, D34).
 * ONE component owns the whole state machine — `none → running → ready|poor`,
 * with `failed` a dead end that only a retry escapes — because decision 9's
 * polling rule ("poll iff the fetched row currently reads `running`") only
 * stays simple if there is exactly one place deciding what the row currently
 * reads. Decision 10: this is the ONLY place a conversion can be started —
 * there is no library-card equivalent, by design.
 *
 * `book` is whatever the caller already has open (`useHydrateBook`'s
 * resolved row). It can be either half of a convert pair:
 *  - a SOURCE book (`convertedFrom === null`) — its `convertStatus` drives
 *    everything below.
 *  - a CONVERTED book (`convertedFrom !== null`) — its OWN `convertStatus` is
 *    always `"none"` on the wire (status lives on the source, never the
 *    derived row), so this side only ever offers the switch back.
 *
 * Renders nothing for a format with no convert target (`convertTargetForFormat`
 * is null for mp3/mp4/webm) — safe to mount unconditionally, though the right
 * call is still to only mount it for `kind === "book"`.
 */
export function ConvertControl({ book }: { book: LibraryBook }) {
  if (book.convertedFrom !== null) {
    return <ConvertedBookSwitch book={book} sourceId={book.convertedFrom} />;
  }
  return <SourceBookControl book={book} />;
}

/**
 * The converted-book side of the pair. Nothing to poll — the routes only
 * operate from the SOURCE side (library-routes.ts), and this row's own status
 * is always `"none"` — so this is a static link, not a state machine.
 * `book.format` is THIS row's format, and D34 restricts convert to pdf⇄epub
 * only, so the source's format is simply the other one — no extra fetch needed
 * just to label the button.
 */
function ConvertedBookSwitch({ book, sourceId }: { book: LibraryBook; sourceId: string }) {
  const navigate = useNavigate();
  const sourceFormat: FileType = book.format === "epub" ? "pdf" : "epub";

  const openSource = () => {
    void navigate({ to: "/read", search: { book: sourceId, format: sourceFormat } });
  };

  // `title` matches the trigger's `label` exactly, matching every other
  // SettingsPopover consumer in this codebase (PdfReader/EpubReader keep the
  // two identical too) — Base UI's `Popover.Trigger` applies its own
  // `aria-label={title}` over the rendered trigger element, so a mismatch here
  // would silently override the more specific button label for screen readers.
  const label = `Show original ${labelFor(sourceFormat)}`;

  return (
    <SettingsPopover
      title={label}
      trigger={
        <ToolbarButton label={label}>
          <ConvertIcon />
        </ToolbarButton>
      }
    >
      <p className="text-sm text-reader-fg/80">
        You're reading the converted {labelFor(book.format)} — the original {labelFor(sourceFormat)}{" "}
        is one tap away.
      </p>
      {/* design.md "accent means state only, never a button fill": ink-filled
          primary, matching the system's one solid-button style. */}
      <button
        type="button"
        onClick={openSource}
        className="rounded-card bg-ink-fill px-3 py-1.5 text-sm font-medium text-on-ink-fill transition hover:opacity-90"
      >
        Show original {labelFor(sourceFormat)}
      </button>
    </SettingsPopover>
  );
}

/** Human label for a format — just the uppercase extension; pulled out so the
 *  wording can't drift between the two components above. */
function labelFor(format: FileType): string {
  return format.toUpperCase();
}

const POOR_NOTE_STORAGE_KEY = "atrium:convert:poorNoteSeen";

/** Has this source book's "looks scanned" note already been shown once? Best-
 *  effort localStorage; a blocked/unavailable store fails toward SHOWING the
 *  note again rather than silently suppressing it (decision 12: warn, never
 *  hide) — the cost of a repeat is a one-line note, not a missed warning. */
function hasSeenPoorNote(sourceId: string): boolean {
  try {
    const raw = window.localStorage.getItem(POOR_NOTE_STORAGE_KEY);
    const seen: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(seen) && seen.includes(sourceId);
  } catch {
    return false;
  }
}

function markPoorNoteSeen(sourceId: string): void {
  try {
    const raw = window.localStorage.getItem(POOR_NOTE_STORAGE_KEY);
    const seen: string[] = raw ? JSON.parse(raw) : [];
    if (!seen.includes(sourceId)) {
      window.localStorage.setItem(POOR_NOTE_STORAGE_KEY, JSON.stringify([...seen, sourceId]));
    }
  } catch {
    // Best-effort — worst case the note reappears next time, which is safe.
  }
}

/** Pull the route's person-facing `{error}` string out of a failed mutation,
 *  falling back to a generic message for anything else (a network error, a
 *  proxy's HTML page). Refusal copy is written for a person already
 *  (library-routes.ts) — this renders it verbatim, never rewords it. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object" && "error" in err.body) {
    const message = (err.body as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

function triggerLabel(status: LibraryBook["convertStatus"], target: FileType): string {
  switch (status) {
    case "none":
      return `Convert to ${labelFor(target)}`;
    case "running":
      return `Converting to ${labelFor(target)}`;
    case "ready":
      return `Switch to ${labelFor(target)}`;
    case "poor":
      return `Switch to ${labelFor(target)} (looks scanned)`;
    case "failed":
      return "Conversion failed — retry";
  }
}

/**
 * The source-book side: the full `none → running → ready|poor` machine, plus
 * `failed`. Owns the live poll (`useConvertingBook`, D34 decisions 8/9) so the
 * trigger's badge and the popover body always reflect the SERVER's current
 * answer, never a locally-remembered "I clicked convert" flag.
 */
function SourceBookControl({ book }: { book: LibraryBook }) {
  const navigate = useNavigate();
  const live = useConvertingBook(book);
  const start = useStartConvert();
  const cancel = useCancelConvert();

  const current = live.data ?? book;
  const targetFormat = convertTargetForFormat(current.format);

  // The "looks scanned" note shows "on first use" (brief 34 step 6) and must
  // not retract mid-session when the trigger marks it seen. It LATCHES rather
  // than being computed once at mount: the status arrives by polling, so the
  // most ordinary way to reach `poor` is to start a conversion and wait for it
  // with the reader open — and a mount-time initializer evaluates while the
  // status is still `running`, freezing the note off for exactly that pass. It
  // would then only appear if the reader were closed and reopened, which is the
  // one path where the warning is least needed.
  //
  // Latching on the book id (not a boolean) also resets it for free when the
  // reader moves to a different book, while `markPoorNoteSeen` — which changes
  // storage, not `current.id` — cannot pull it back out from under the reader.
  const [poorNoteFor, setPoorNoteFor] = useState<string | null>(null);
  useEffect(() => {
    if (current.convertStatus === "poor" && !hasSeenPoorNote(current.id)) {
      setPoorNoteFor(current.id);
    }
  }, [current.convertStatus, current.id]);
  const poorNoteVisible = poorNoteFor === current.id;

  if (targetFormat === null) return null; // media: nothing to convert

  const openConverted = () => {
    if (current.convertedTo) {
      void navigate({ to: "/read", search: { book: current.convertedTo, format: targetFormat } });
    }
  };

  const onTriggerClick = () => {
    if (current.convertStatus === "poor") markPoorNoteSeen(current.id);
  };

  // `title` matches the trigger's label exactly — see the comment in
  // `ConvertedBookSwitch` on why (Base UI's aria-label merge).
  const label = triggerLabel(current.convertStatus, targetFormat);

  return (
    <SettingsPopover
      title={label}
      trigger={
        <ToolbarButton label={label} onClick={onTriggerClick}>
          <span className="relative inline-flex">
            <ConvertIcon />
            {current.convertStatus === "running" && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-reader-accent motion-safe:animate-pulse"
              />
            )}
            {current.convertStatus === "failed" && (
              <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-danger" />
            )}
          </span>
        </ToolbarButton>
      }
    >
      {current.convertStatus === "none" && (
        <>
          <p className="text-sm text-reader-fg/80">
            {targetFormat === "epub"
              ? "A reflowable EPUB reads better on a phone — no pinch-zoom, no side-scroll. The PDF stays exactly as it is."
              : `Convert to a ${labelFor(targetFormat)} you can read here. The ${labelFor(current.format)} stays exactly as it is.`}
          </p>
          <button
            type="button"
            disabled={start.isPending}
            onClick={() => start.mutate(current.id)}
            className="rounded-card bg-ink-fill px-3 py-1.5 text-sm font-medium text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
          >
            {start.isPending ? "Starting…" : `Convert to ${labelFor(targetFormat)}`}
          </button>
          {start.isError && (
            <p role="alert" className="text-xs text-danger">
              {messageFor(start.error, "Couldn't start the conversion.")}
            </p>
          )}
        </>
      )}

      {current.convertStatus === "running" && (
        <>
          <p className="text-sm text-reader-fg/80 motion-safe:animate-pulse">
            Converting to {labelFor(targetFormat)}… this can take a while — Calibre works through
            it in the background. Come back anytime; the button keeps checking on its own.
          </p>
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(current.id)}
            className="rounded-card border border-reader-border px-3 py-1.5 text-sm font-medium text-danger transition hover:bg-reader-surface disabled:opacity-50"
          >
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
          {cancel.isError && (
            <p role="alert" className="text-xs text-danger">
              {messageFor(cancel.error, "Couldn't cancel — try again.")}
            </p>
          )}
        </>
      )}

      {(current.convertStatus === "ready" || current.convertStatus === "poor") && (
        <>
          {current.convertStatus === "poor" && poorNoteVisible && (
            <p className="text-sm text-danger">
              This looks scanned — expect little or no text in the {labelFor(targetFormat)}.
            </p>
          )}
          <p className="text-sm text-reader-fg/80">Ready to read as {labelFor(targetFormat)}.</p>
          <button
            type="button"
            onClick={openConverted}
            className="rounded-card bg-ink-fill px-3 py-1.5 text-sm font-medium text-on-ink-fill transition hover:opacity-90"
          >
            Switch to {labelFor(targetFormat)}
          </button>
        </>
      )}

      {current.convertStatus === "failed" && (
        <>
          <p className="text-sm text-danger">
            {current.convertError ?? "The conversion failed."}
          </p>
          <button
            type="button"
            disabled={start.isPending}
            onClick={() => start.mutate(current.id)}
            className="rounded-card bg-ink-fill px-3 py-1.5 text-sm font-medium text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
          >
            {start.isPending ? "Retrying…" : "Try again"}
          </button>
          {start.isError && (
            <p role="alert" className="text-xs text-danger">
              {messageFor(start.error, "Couldn't start the conversion.")}
            </p>
          )}
        </>
      )}
    </SettingsPopover>
  );
}

// 1.75-stroke line icon matching the reader chrome's icon set (design.md
// "Icons"): two opposing arrows forming a cycle, reading as "convert/exchange".
function ConvertIcon() {
  const stroke = {
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 10V8a4 4 0 0 1 4-4h13" {...stroke} />
      <path d="M17 1l3 3-3 3" {...stroke} />
      <path d="M21 14v2a4 4 0 0 1-4 4H4" {...stroke} />
      <path d="M7 23l-3-3 3-3" {...stroke} />
    </svg>
  );
}
