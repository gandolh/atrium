import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from "react";
import {
  detectFileType,
  EPUB_EXTENSIONS,
  EPUB_MIME_TYPES,
  MP3_EXTENSIONS,
  MP3_MIME_TYPES,
  MP4_EXTENSIONS,
  MP4_MIME_TYPES,
  PDF_EXTENSIONS,
  PDF_MIME_TYPES,
  WEBM_EXTENSIONS,
  WEBM_MIME_TYPES,
} from "@ebook-reader/shared";

/**
 * "Add to Library" upload surface. Two variants (hierarchy fix — the uploader
 * used to consume half the first viewport even for an established library):
 *
 * - **hero** (empty library / first run): the original full dropzone — dashed
 *   soft border, centered upload glyph, Newsreader prompt, Ink button.
 * - **ambient** (library has content): renders no visible box at all. Upload
 *   lives behind (a) the header's "Add to library" button via `browseRef` and
 *   (b) a WINDOW-level drag target: dragging a file anywhere over the app
 *   raises a full-screen "drop to add" overlay, so drag-drop capability is
 *   never lost — it just stops outranking the library.
 *
 * Both validate every format the library understands — books (PDF/EPUB),
 * music (MP3), and video (MP4/WebM) — by ext/MIME (D13) before handing the
 * files up; the parent does the actual upload.
 *
 * **Every file, not the first** (brief 70). Music arrives as albums, and a
 * drop or pick of twelve files used to add one and discard eleven without a
 * word. All three entry points now hand up every valid file, in order, and
 * each file is validated on its own: the invalid ones are named with the
 * reason, and they never block the rest.
 *
 * `disabled` (offline, brief 20 item 4) mutes the hero zone / suppresses the
 * overlay — upload is an online-only action.
 *
 * **Video cover capture (brief 42) is NOT here**, despite that brief naming
 * this file: this component only hands a `File` up and never learns the created
 * row's id, and the hero instance unmounts as soon as the library stops being
 * empty. The capture therefore lives at the seam that has the id, the `File`
 * and the resolved POST all at once — `startUploadCoverCapture` in
 * `../lib/use-library`, firing after the upload mutation succeeds.
 */

const ACCEPT = [
  ...PDF_EXTENSIONS,
  ...EPUB_EXTENSIONS,
  ...MP3_EXTENSIONS,
  ...MP4_EXTENSIONS,
  ...WEBM_EXTENSIONS,
  ...PDF_MIME_TYPES,
  ...EPUB_MIME_TYPES,
  ...MP3_MIME_TYPES,
  ...MP4_MIME_TYPES,
  ...WEBM_MIME_TYPES,
].join(",");

const INVALID_TYPE_MESSAGE =
  "Unsupported file type. Please upload a book (PDF/EPUB), music (MP3), or video (MP4/WebM) file.";

/**
 * The rejection message. One file alone keeps the original wording, so a
 * single-file drop reads exactly as it always did; with several, the rejected
 * ones are named, since the rest are being added.
 */
function rejectionMessage(rejected: File[], total: number): string {
  if (total === 1) return INVALID_TYPE_MESSAGE;
  const names = rejected.map((f) => f.name).join(", ");
  const count = rejected.length === 1 ? "1 file wasn't added" : `${rejected.length} files weren't added`;
  return `${count}: ${names} (unsupported type). Books (PDF/EPUB), music (MP3) and video (MP4/WebM) only.`;
}

/** Imperative surface for the header's "Add to library" button. */
export interface UploadZoneHandle {
  /** Open the file picker. */
  browse: () => void;
}

export function UploadZone({
  onFiles,
  busy,
  busyLabel = "Uploading…",
  disabled = false,
  variant = "hero",
  browseRef,
}: {
  /** Every valid file of one drop or pick, in order. Never called empty. */
  onFiles: (files: File[]) => void;
  busy: boolean;
  /** The hero button's text while busy, e.g. "Adding 3 of 12…". */
  busyLabel?: string;
  disabled?: boolean;
  variant?: "hero" | "ambient";
  /** Filled with `{ browse }` so a sibling (the header button) can open the picker. */
  browseRef?: RefObject<UploadZoneHandle | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [windowDrag, setWindowDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(
    (list: ArrayLike<File> | null | undefined) => {
      const files = Array.from(list ?? []);
      if (files.length === 0) return;
      setError(null);
      const valid = files.filter((file) => detectFileType(file.name, file.type) !== null);
      const rejected = files.filter((file) => !valid.includes(file));
      if (rejected.length > 0) setError(rejectionMessage(rejected, files.length));
      if (valid.length > 0) onFiles(valid);
    },
    [onFiles],
  );

  useEffect(() => {
    if (browseRef) browseRef.current = { browse: () => inputRef.current?.click() };
  }, [browseRef]);

  // Window-level drag target: the whole app accepts a dropped file. A depth
  // counter tames dragenter/dragleave churn as the pointer crosses child
  // elements; only drags that actually carry files count (text selections
  // dragged across the page shouldn't raise the overlay).
  useEffect(() => {
    if (disabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setWindowDrag(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // required to allow the drop
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setWindowDrag(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setWindowDrag(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      accept(e.dataTransfer?.files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [disabled, accept]);

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (disabled) return;
    accept(event.dataTransfer.files);
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ACCEPT}
      disabled={disabled}
      onChange={(e) => {
        // Copied before the reset below, which empties the live FileList.
        const files = Array.from(e.target.files ?? []);
        e.target.value = ""; // allow re-selecting the same file
        accept(files);
      }}
      className="hidden"
    />
  );

  // Full-screen "drop to add" overlay. pointer-events-none so the drop event
  // falls through to the window handler above rather than the overlay eating it.
  const overlay = windowDrag && !disabled && (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 bg-paper/90 p-6 backdrop-blur-sm"
    >
      <div className="grid h-full w-full place-items-center rounded-card border-2 border-dashed border-accent">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-card bg-paper-container">
            <UploadGlyph className="h-6 w-6 text-accent" />
          </span>
          <p className="font-display text-2xl font-semibold text-ink">
            Drop to add to your library
          </p>
        </div>
      </div>
    </div>
  );

  const errorAlert = error && (
    <p
      role="alert"
      className="mt-3 rounded-card border border-danger/40 bg-danger-soft/50 px-4 py-2.5 text-sm text-danger"
    >
      {error}
    </p>
  );

  if (variant === "ambient") {
    return (
      <>
        {input}
        {overlay}
        {errorAlert}
      </>
    );
  }

  return (
    <section aria-label="Add to library">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragActive(false);
        }}
        aria-disabled={disabled}
        className={`flex flex-col items-center justify-center gap-4 rounded-card border-2 border-dashed px-6 py-14 text-center transition-colors ${
          disabled
            ? "border-line-soft/50 bg-paper-low/20 opacity-60"
            : dragActive
              ? "border-accent bg-accent/5"
              : "border-line-soft bg-paper-low/40"
        }`}
      >
        <span className="grid h-14 w-14 place-items-center rounded-card bg-paper-container">
          <UploadGlyph className="h-6 w-6 text-accent" />
        </span>

        <div className="flex flex-col gap-1">
          <h2 className="font-display text-3xl font-medium text-ink">Add to Library</h2>
          <p className="text-ink-variant">
            {disabled
              ? "Uploading requires a connection."
              : "Drag & drop a book, MP3, or video (MP4/WebM), or click to browse"}
          </p>
        </div>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
          title={disabled ? "Requires connection" : undefined}
          className="rounded-card bg-ink-fill px-6 py-2.5 text-sm font-semibold tabular-nums text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
        >
          {disabled ? "Requires connection" : busy ? busyLabel : "Upload files"}
        </button>

        {input}
      </div>

      {overlay}
      {errorAlert}
    </section>
  );
}

function UploadGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M12 18v-6M9.5 14.5 12 12l2.5 2.5" />
    </svg>
  );
}
