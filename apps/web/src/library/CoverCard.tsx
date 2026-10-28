import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Menu } from "@base-ui/react/menu";
import { lookupSourceForKind, type LibraryBook, type MediaKind } from "@ebook-reader/shared";

import { coverUrl } from "../lib/library-api";
import { coverLayoutId } from "../lib/cover-layout-id";
import { useMotionTransition } from "../lib/motion";
import { formatTime } from "../player/format-time";
import type { OfflineDownloadStatus } from "../lib/use-library";
import { CoverFallback } from "./CoverFallback";
import { LookupDialog } from "./LookupDialog";
import { OfflineToggle } from "./OfflineToggle";

/** Per-book offline download affordance (brief 20 item 2, rendering side). */
export interface CoverOfflineProps {
  state: OfflineDownloadStatus;
  progress: number | null | undefined;
  /** False while the library is serving cached offline rows (no network to download from). */
  canDownload: boolean;
  onDownload: () => void;
  onRemove: () => void;
}

/**
 * "Add to Discord queue" (brief 82): the Jukebox's Players a music tile can
 * queue on, and the write. Shown for `audio` only, and hidden with no Players.
 */
export interface CoverDiscordProps {
  players: readonly { guildId: string; guildName: string }[];
  onAdd: (book: LibraryBook, guildId: string) => Promise<void>;
}

/**
 * Kind → tint class (design.md "Kind tints"), spelled out as full static
 * class names rather than built with a template literal — Tailwind's
 * compiler only picks up class names it can see literally in source, so
 * `` `bg-tint-${kind}` `` would silently ship unstyled.
 */
const TINT_CLASS: Record<MediaKind, string> = {
  book: "bg-tint-book",
  audio: "bg-tint-music",
  video: "bg-tint-video",
};

/**
 * A single book in the library gallery (wiki/design.md "Components" → Tiles).
 * Brief 29 rework: the whole card is now a tinted tile — `bg-tint-{kind}`
 * ground, 1px `line-soft`, 4px radius — with the artwork inset at 2px radius.
 * The tint (plus the format line below the title) carries the kind signal
 * now, so the old top-right EPUB/MUSIC/VIDEO corner badge is gone; see the
 * design.md "tint test" this satisfies (strip every badge, the grid still
 * reads by kind). The duration caption (bottom-left, audio/video) stays — it
 * reports a fact (length), it doesn't badge the kind.
 *
 * Brief 20 adds the offline toggle top-left (`offline`, omitted entirely when
 * IndexedDB isn't supported) and gates the "Remove" library action behind
 * `deleteDisabled` while offline (removing is an API call, not a local op).
 *
 * Brief 23c renders per `book.kind` inside the media box: `audio` centers the
 * (optional) square embedded-art image, or the typographic fallback when
 * absent; `video` centers its own (optional) stored cover, letterboxed inside
 * its 4:3 box instead of cropped (brief 42/D40 — see `CoverArt`), or the
 * typographic fallback when absent; both add a duration caption. The offline
 * toggle is book-only — media is excluded from offline v1 (brief 23's grilled
 * decision), so it's simply not rendered for `kind !== "book"` regardless of
 * what the caller passed.
 *
 * Brief 32's cover → reader shared-layout transition lands here: the media
 * box carries `layoutId={coverLayoutId(book.id)}` for books so it FLIPs into
 * the reader's opening-screen tile (`routes/read.tsx`'s `BookCoverTile`)
 * instead of the navigation just cutting. Audio/video open into `MediaRoute`
 * instead, which has no matching element, so those kinds get no `layoutId`
 * (round 2 fix — dead wiring shouldn't ship).
 *
 * Brief 100 adds **Look up…** to the tile menu for music and books (D59): it
 * opens `LookupDialog`, which asks MusicBrainz or Open Library through the
 * API. Video has no source, so no item. Like Remove it is an API call, so
 * `lookupDisabled` gates it while offline.
 */
export function CoverCard({
  book,
  onOpen,
  onDelete,
  deleteDisabled = false,
  lookupDisabled = false,
  offline,
  discord,
}: {
  book: LibraryBook;
  onOpen: (book: LibraryBook) => void;
  onDelete: (book: LibraryBook) => void;
  deleteDisabled?: boolean;
  lookupDisabled?: boolean;
  offline?: CoverOfflineProps;
  discord?: CoverDiscordProps;
}) {
  // The inline answer to "Add to Discord queue", cleared after a few seconds.
  const [queued, setQueued] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!queued) return;
    const id = window.setTimeout(() => setQueued(null), 4_000);
    return () => window.clearTimeout(id);
  }, [queued]);
  const [imgFailed, setImgFailed] = useState(false);
  const kind = book.kind ?? "book";
  // The dialog is mounted on demand and unmounted after its close transition,
  // so a grid of tiles carries no idle dialogs, and each opening starts fresh.
  const lookupSource = lookupSourceForKind(kind);
  const [lookupMounted, setLookupMounted] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const progressPct = Math.round(book.progress * 100);
  // `player/format-time` is the one duration formatter in the app. A private
  // copy used to live at the foot of this file and ROUNDED where the dock
  // floors, so a 125.6s file read 2:06 on its tile and 2:05 in the dock.
  const durationLabel = book.durationSeconds != null ? formatTime(book.durationSeconds) : null;
  const expandTransition = useMotionTransition("expand");

  // Mixed-row baseline fix (flagged by brief 28, resolved here): a bare 2:3 /
  // 1:1 / 16:9 mix means three different tile heights in the same row once
  // video spans two grid columns. Rather than force every kind into one
  // shape, the OUTER media box gets a fixed aspect per column-span instead:
  // single-span kinds (book, audio) use 2:3, and video's 4:3 box — rendered
  // at DOUBLE the column width via `cellSpan()` in LibraryHome — algebraically
  // lands at the same height (`width * 1.5` either way: 1.5w for a 2:3 box of
  // width w, and 1.5w for a 4:3 box of width 2w). Artwork keeps its native
  // shape inside that box (see `CoverArt`), so a mixed row's captions start
  // at the same y-offset without stretching a square or a landscape frame.
  const mediaAspect = kind === "video" ? "aspect-[4/3]" : "aspect-[2/3]";
  const tintClass = TINT_CLASS[kind];
  const formatLabel = book.format.toUpperCase();
  const discordPlayers = kind === "audio" ? (discord?.players ?? []) : [];

  function addToDiscord(guildId: string, guildName: string) {
    discord
      ?.onAdd(book, guildId)
      .then(() => setQueued({ ok: true, text: `Added to ${guildName}'s queue` }))
      .catch(() => setQueued({ ok: false, text: `Couldn't add to ${guildName}'s queue` }));
  }

  return (
    <div
      className={`group flex flex-col gap-2 rounded-card border border-line-soft ${tintClass} p-2 shadow-l1 transition-[transform,box-shadow] duration-300 ease-paper motion-safe:hover:-translate-y-1 motion-safe:hover:shadow-lift`}
    >
      <div className={`relative ${mediaAspect} w-full`}>
        <button
          type="button"
          onClick={() => onOpen(book)}
          aria-label={`Open ${book.title}`}
          className="absolute inset-0 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          {/* The shared-layout target for the cover → reader morph (brief 32) —
              matched on the reader side by the identical `coverLayoutId`. Book-
              only: audio/video open into `MediaRoute`, which has no matching
              element, so a `layoutId` there would never pair with anything —
              dead wiring rather than a real transition (round 2 fix). */}
          <motion.div
            layoutId={kind === "book" ? coverLayoutId(book.id) : undefined}
            layout
            transition={expandTransition}
            className="h-full w-full overflow-hidden rounded-cover"
          >
            <CoverArt book={book} imgFailed={imgFailed} onImgError={() => setImgFailed(true)} />
          </motion.div>

          {/* Duration caption (audio/video only) — the m:ss / h:mm:ss sibling
              of a page count, bottom-left so it never collides with the
              offline toggle (top-left) or the reading-progress bar (bottom
              edge). */}
          {durationLabel && (
            <span className="absolute bottom-2 left-2 rounded-cover bg-ink/55 px-2 py-1 font-ui text-[11px] leading-none text-on-ink-fill backdrop-blur-sm">
              {durationLabel}
            </span>
          )}

          {/* Reading progress: 3px accent bar at the bottom edge (design.md
              "Structure": Progress = 3px). */}
          {progressPct > 0 && (
            <span className="absolute inset-x-0 bottom-0 h-[3px] bg-ink/10">
              <span className="block h-full bg-accent" style={{ width: `${progressPct}%` }} />
            </span>
          )}
        </button>

        {/* Offline downloads are books-only for v1 (brief 23's grilled
            decision) — the toggle is simply omitted for media, regardless of
            what the caller passed. */}
        {offline && kind === "book" && (
          <OfflineToggle
            bookTitle={book.title}
            state={offline.state}
            progress={offline.progress}
            canDownload={offline.canDownload}
            onDownload={offline.onDownload}
            onRemove={offline.onRemove}
          />
        )}
      </div>

      <div className="flex items-start justify-between gap-2 px-0.5 pb-0.5">
        <div className="min-w-0">
          {/* Card title role (design.md "Typography"): Archivo 600, not the
              reading-pane Newsreader — "card + row titles" are interface
              chrome even though the words themselves came from the book. */}
          <p
            title={book.title}
            className="line-clamp-2 font-ui text-sm leading-snug font-semibold tracking-[-0.01em] text-ink"
          >
            {book.title}
          </p>
          {/* Source line, `ink-variant` (design.md "Components" → Tiles): the
              format label rides along here instead of a corner badge — this
              plus the tint is what now carries kind. */}
          <p className="truncate text-sm text-ink-variant">
            {book.author ? `${book.author} · ${formatLabel}` : formatLabel}
          </p>
          {queued && (
            <p role="status" className={`text-xs ${queued.ok ? "text-ink-variant" : "text-danger"}`}>
              {queued.text}
            </p>
          )}
        </div>

        {/* Per-card overflow → delete (design.md: quiet, appears on hover/focus).
            Base UI's Menu (D22, brief 98), so it works from the keyboard: Enter,
            Space or ArrowDown on the trigger opens it on the first item, the
            arrows move, Enter or Space runs an item, Esc closes and returns to
            the trigger. Not modal, so a click outside still reaches the page. */}
        <Menu.Root modal={false}>
          <Menu.Trigger
            ref={menuTrigger}
            aria-label={`More actions for ${book.title}`}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-card text-ink-variant opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-paper-raised/60 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent data-[popup-open]:opacity-100 max-md:opacity-100"
          >
            <DotsGlyph className="h-4 w-4" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
              <Menu.Popup className="w-48 overflow-hidden rounded-card border border-line-soft bg-paper-raised font-ui shadow-lift outline-none">
                {/* Brief 100: the on-request lookup, music and books only. */}
                {lookupSource && (
                  <Menu.Item
                    disabled={lookupDisabled}
                    onClick={() => {
                      setLookupMounted(true);
                      setLookupOpen(true);
                    }}
                    title={lookupDisabled ? "Looking up requires a connection" : undefined}
                    className={`block w-full cursor-default px-3 py-2 text-left text-sm outline-none ${
                      lookupDisabled ? "cursor-not-allowed text-ink-variant/60" : "text-ink data-[highlighted]:bg-paper-low"
                    }`}
                  >
                    {lookupDisabled ? "Look up (requires connection)" : "Look up…"}
                  </Menu.Item>
                )}
                {/* Brief 82: queue a song on the Discord bot. One Player is one
                    item; several are listed by guild name under a caption. */}
                {discordPlayers.length === 1 && (
                  <Menu.Item
                    onClick={() => addToDiscord(discordPlayers[0].guildId, discordPlayers[0].guildName)}
                    className="block w-full cursor-default px-3 py-2 text-left text-sm text-ink outline-none data-[highlighted]:bg-paper-low"
                  >
                    Add to Discord queue
                  </Menu.Item>
                )}
                {discordPlayers.length > 1 && (
                  <Menu.Group className="border-b border-line-soft py-1">
                    <Menu.GroupLabel className="px-3 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.15em] text-ink-variant uppercase">
                      Add to Discord queue
                    </Menu.GroupLabel>
                    {discordPlayers.map((player) => (
                      <Menu.Item
                        key={player.guildId}
                        onClick={() => addToDiscord(player.guildId, player.guildName)}
                        className="block w-full cursor-default truncate px-3 py-1.5 text-left text-sm text-ink outline-none data-[highlighted]:bg-paper-low"
                      >
                        {player.guildName}
                      </Menu.Item>
                    ))}
                  </Menu.Group>
                )}
                <Menu.Item
                  disabled={deleteDisabled}
                  onClick={() => onDelete(book)}
                  title={deleteDisabled ? "Removing requires a connection" : undefined}
                  className={`block w-full cursor-default px-3 py-2 text-left text-sm outline-none ${
                    deleteDisabled
                      ? "cursor-not-allowed text-ink-variant/60"
                      : "text-danger data-[highlighted]:bg-danger-soft/50"
                  }`}
                >
                  {deleteDisabled ? "Remove (requires connection)" : "Remove"}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      {lookupSource && lookupMounted && (
        <LookupDialog
          book={book}
          source={lookupSource}
          open={lookupOpen}
          onOpenChange={setLookupOpen}
          onClosed={() => setLookupMounted(false)}
          returnFocus={menuTrigger}
        />
      )}
    </div>
  );
}

/**
 * The per-kind cover-art fill, shared by `CoverCard` and the reader's opening
 * screen (`routes/read.tsx`) via the shared-layout box, and by the stacks
 * index so both branch on `book.kind` identically (rather than one of them
 * copying the markup): `audio` centers its square embedded art — the box
 * around it is now taller than it is wide (2:3, see `mediaAspect` above), so
 * the art is centered and letterboxed by the tile's own tint rather than
 * cropped (mp3 art is 400×400; distorting or cropping it would fight the
 * "no distortion" rule) — or the typographic fallback when absent; `video`
 * shows its stored cover the same way, centered and letterboxed inside its
 * 4:3 box (brief 42/D40): a stored frame's native aspect is arbitrary (a
 * portrait poster, a 16:9 frame, ...) and the server-side geometry
 * (`toVideoThumbnail`, extract.ts) shrinks to fit rather than cropping, so the
 * card must not force it to fill 4:3 either — or the typographic fallback
 * when absent; books fill with their full-bleed cover image (already ~2:3, no
 * letterboxing). The caller owns the `imgFailed` state so it can also key
 * other UI off it.
 */
export function CoverArt({
  book,
  imgFailed,
  onImgError,
}: {
  book: LibraryBook;
  imgFailed: boolean;
  onImgError: () => void;
}) {
  const kind = book.kind ?? "book";
  // `hasCover` is a disk check (brief 41) — true for any kind once a cover
  // file exists at its derived path. Video is no longer excluded (brief
  // 42/D40): a stored video cover (today, a tagged file's embedded art;
  // later, an upload/playback capture) renders like any other kind's.
  const showImage = book.hasCover && !imgFailed;

  if (kind === "audio") {
    return showImage ? (
      <div className="flex h-full w-full items-center justify-center">
        <img
          src={coverUrl(book.id, book.coverVersion)}
          alt=""
          onError={onImgError}
          className="aspect-square max-h-full max-w-full object-cover"
        />
      </div>
    ) : (
      <CoverFallback title={book.title} kind="audio" />
    );
  }

  if (kind === "video") {
    // Unlike audio's fixed-square art, a video frame's native aspect is
    // arbitrary (portrait poster, 16:9 frame, ...) — `object-contain` inside
    // a centering flex wrapper letterboxes it by the tile's own tint instead
    // of cropping it to fill the 4:3 box (design.md: artwork keeps its
    // native shape inside its box).
    return showImage ? (
      <div className="flex h-full w-full items-center justify-center">
        <img
          src={coverUrl(book.id, book.coverVersion)}
          alt=""
          onError={onImgError}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    ) : (
      <CoverFallback title={book.title} kind="video" />
    );
  }

  return showImage ? (
    <img
      src={coverUrl(book.id, book.coverVersion)}
      alt=""
      onError={onImgError}
      className="h-full w-full object-cover"
    />
  ) : (
    <CoverFallback title={book.title} kind={kind} />
  );
}

function DotsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
