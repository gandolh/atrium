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
 * file up; the parent does the actual upload.
 *
 * `disabled` (offline, brief 20 item 4) mutes the hero zone / suppresses the
 * overlay — upload is an online-only action.
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

/** Imperative surface for the header's "Add to library" button. */
export interface UploadZoneHandle {
  /** Open the file picker. */
  browse: () => void;
}

export function UploadZone({
  onFile,
  busy,
  disabled = false,
  variant = "hero",
  browseRef,
}: {
  onFile: (file: File) => void;
  busy: boolean;
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
    (file: File) => {
      setError(null);
      const type = detectFileType(file.name, file.type);
      if (type) {
        onFile(file);
      } else {
        setError(INVALID_TYPE_MESSAGE);
      }
    },
    [onFile],
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
      const file = e.dataTransfer?.files?.[0];
      if (file) accept(file);
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
    const file = event.dataTransfer.files[0];
    if (file) accept(file);
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      disabled={disabled}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = ""; // allow re-selecting the same file
        if (file) accept(file);
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
      <div className="grid h-full w-full place-items-center rounded-lg border-2 border-dashed border-accent">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-lg bg-paper-container">
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
      className="mt-3 rounded border border-danger/40 bg-danger-soft/50 px-4 py-2.5 text-sm text-danger"
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
        className={`flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors ${
          disabled
            ? "border-line-soft/50 bg-paper-low/20 opacity-60"
            : dragActive
              ? "border-accent bg-accent/5"
              : "border-line-soft bg-paper-low/40"
        }`}
      >
        <span className="grid h-14 w-14 place-items-center rounded-lg bg-paper-container">
          <UploadGlyph className="h-6 w-6 text-accent" />
        </span>

        <div className="flex flex-col gap-1">
          <h2 className="font-display text-3xl font-bold text-ink">Add to Library</h2>
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
          className="rounded bg-ink-fill px-6 py-2.5 text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
        >
          {disabled ? "Requires connection" : busy ? "Uploading…" : "Upload a file"}
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
