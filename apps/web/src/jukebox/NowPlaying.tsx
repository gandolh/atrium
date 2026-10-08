import { useEffect, useState } from "react";
import type { ControlRequest, LibraryBook, Player, RepeatMode, SettingsRequest } from "@ebook-reader/shared";

import { formatTime } from "../player/format-time";
import { PauseIcon, PlayIcon } from "../player/transport";
import { RemoteButton, TrackArt, trackByline } from "./controls";
import { NextIcon, PreviousIcon, RepeatIcon, ShuffleIcon, SpeakerIcon, StopIcon } from "./icons";
import { useLivePosition } from "./use-jukebox";

/** The repeat control cycles off → one → all. */
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: "one", one: "all", all: "off" };
const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: "Repeat is off",
  one: "Repeating this song",
  all: "Repeating the playlist",
};

const STATE_LABEL = { idle: "Stopped", playing: "Playing", paused: "Paused" } as const;

/**
 * Now playing, the transport and the voice channel for one Player (brief 82).
 * Every control is a request to atrium, which queues a command for the bot
 * (D57), so nothing here plays a sound in this browser. That is the Dock's job.
 * While the bot is offline every control is disabled: nothing would act on it.
 */
export function NowPlaying({
  player,
  book,
  onControl,
  onSettings,
}: {
  player: Player;
  /** The current song's library row, for its artwork. */
  book: LibraryBook | undefined;
  onControl: (request: ControlRequest) => void;
  onSettings: (request: SettingsRequest) => void;
}) {
  const offline = !player.online;
  const disabled = offline;
  const track = player.track;
  const playing = player.state === "playing";

  return (
    <section
      aria-label="Now playing"
      className="flex flex-col gap-5 rounded-card border border-line-soft bg-paper-raised p-4 shadow-l1 sm:p-5"
    >
      <div className="flex items-start gap-4">
        <TrackArt book={track ? book : undefined} className="w-24 sm:w-32" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-ui text-[10px] font-semibold tracking-[0.15em] text-ink-variant uppercase">
            {offline ? "Bot offline" : STATE_LABEL[player.state]}
          </p>
          <h3 className="line-clamp-2 font-display text-[27px] leading-[1.2] font-medium tracking-[-0.02em] text-ink">
            {track ? track.title : "Nothing playing"}
          </h3>
          {track && (
            <p className="truncate font-ui text-sm text-ink-variant">{trackByline(track.artist, track.album)}</p>
          )}
        </div>
      </div>

      <Progress player={player} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-1">
          <RemoteButton label="Previous" onClick={() => onControl({ action: "previous" })} disabled={disabled}>
            <PreviousIcon className="h-5 w-5" />
          </RemoteButton>
          <button
            type="button"
            onClick={() => onControl({ action: playing ? "pause" : "play" })}
            disabled={disabled}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            className="mx-1 grid h-12 w-12 shrink-0 place-items-center rounded-card bg-ink-fill text-on-ink-fill transition-opacity ease-paper hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          >
            {playing ? <PauseIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
          </button>
          <RemoteButton label="Stop" onClick={() => onControl({ action: "stop" })} disabled={disabled}>
            <StopIcon className="h-5 w-5" />
          </RemoteButton>
          <RemoteButton label="Next" onClick={() => onControl({ action: "next" })} disabled={disabled}>
            <NextIcon className="h-5 w-5" />
          </RemoteButton>
        </div>

        <div className="flex items-center gap-1">
          <RemoteButton
            label={player.shuffle ? "Shuffle is on" : "Shuffle is off"}
            pressed={player.shuffle}
            onClick={() => onSettings({ shuffle: !player.shuffle })}
            disabled={disabled}
          >
            <ShuffleIcon className="h-5 w-5" />
          </RemoteButton>
          <RemoteButton
            label={`${REPEAT_LABEL[player.repeat]}. Change repeat`}
            pressed={player.repeat !== "off"}
            onClick={() => onSettings({ repeat: NEXT_REPEAT[player.repeat] })}
            disabled={disabled}
          >
            <RepeatIcon className="h-5 w-5" one={player.repeat === "one"} />
          </RemoteButton>
        </div>
      </div>

      <Voice player={player} disabled={disabled} onControl={onControl} />
    </section>
  );
}

/**
 * Elapsed and total under a 3px rail (design.md "Progress"). It moves on its
 * own between polls while playing and holds while paused. There is no seek in
 * v1, so it is a progress bar, not a slider.
 */
function Progress({ player }: { player: Player }) {
  const positionMs = useLivePosition(player);
  const total = player.track?.durationSeconds ?? null;
  const elapsed = player.track ? Math.min(positionMs / 1000, total ?? Infinity) : 0;
  const pct = total && total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Song progress"
        aria-valuemin={0}
        aria-valuemax={total ?? 0}
        aria-valuenow={Math.floor(elapsed)}
        aria-valuetext={`${formatTime(elapsed)} of ${formatTime(total)}`}
        className="h-[3px] overflow-hidden rounded-full bg-paper-container"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-baseline justify-between font-ui text-xs text-ink-variant tabular-nums">
        <span>{player.track ? formatTime(elapsed) : "--:--"}</span>
        <span>{formatTime(total)}</span>
      </div>
    </div>
  );
}

/** The voice channel the bot sits in, a picker of the guild's others, and Leave. */
function Voice({
  player,
  disabled,
  onControl,
}: {
  player: Player;
  disabled: boolean;
  onControl: (request: ControlRequest) => void;
}) {
  const channels = player.voiceChannels;
  const current = player.voiceChannel;
  const currentId = current?.id ?? null;
  const [choice, setChoice] = useState(currentId ?? channels[0]?.id ?? "");

  // Every poll parses fresh objects, so these key on ids: a poll must not undo
  // a channel somebody is about to join. Follow the bot only when it moves.
  useEffect(() => {
    if (currentId) setChoice(currentId);
  }, [currentId]);
  const channelIds = channels.map((c) => c.id).join(",");
  useEffect(() => {
    const ids = channelIds ? channelIds.split(",") : [];
    setChoice((was) => (ids.includes(was) ? was : (currentId ?? ids[0] ?? "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelIds]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft pt-4">
      <SpeakerIcon className="h-5 w-5 shrink-0 text-ink-variant" />
      <p className="min-w-0 flex-1 truncate font-ui text-sm text-ink">
        {current ? (
          <>
            In <span className="font-semibold">{current.name || "a voice channel"}</span>
          </>
        ) : (
          <span className="text-ink-variant">Not in a voice channel</span>
        )}
      </p>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <label className="relative min-w-0 flex-1 sm:flex-none">
          <span className="sr-only">Voice channel</span>
          <select
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            disabled={disabled || channels.length === 0}
            className="w-full appearance-none rounded-card border border-line bg-paper-raised py-2 pr-8 pl-3 font-ui text-sm text-ink transition outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 sm:w-48"
          >
            {channels.length === 0 && <option value="">No voice channels reported</option>}
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </select>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-variant"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m7 10 5 5 5-5" />
          </svg>
        </label>
        <button
          type="button"
          onClick={() => onControl({ action: "join", channelId: choice })}
          disabled={disabled || !choice || choice === current?.id}
          className="shrink-0 rounded-card border border-line px-3 py-2 font-ui text-sm font-medium text-ink transition hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Join
        </button>
        <button
          type="button"
          onClick={() => onControl({ action: "leave" })}
          disabled={disabled || !current}
          className="shrink-0 rounded-card border border-line px-3 py-2 font-ui text-sm font-medium text-ink transition hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
