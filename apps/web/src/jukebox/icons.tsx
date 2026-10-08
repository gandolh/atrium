import type { ReactNode } from "react";

/**
 * The Jukebox's line icons: inline SVG at the unified 1.75 stroke (design.md
 * "Icons"). Play and pause are the dock's own (`player/transport.tsx`), so the
 * two remotes look like one instrument.
 */

type IconProps = { className?: string };

function Line({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function PreviousIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M6 5.5v13M18 6.5v11l-9-5.5z" />
    </Line>
  );
}

export function NextIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M18 5.5v13M6 6.5v11l9-5.5z" />
    </Line>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1" />
    </Line>
  );
}

export function ShuffleIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M4 7h3.5c4 0 5 10 9 10H20M4 17h3.5c1.6 0 2.7-1.6 3.6-3.6M13 9.6C13.9 8.1 14.9 7 16.5 7H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5" />
    </Line>
  );
}

/** Repeat; `one` adds the small "1" that marks repeating a single song. */
export function RepeatIcon({ className, one }: IconProps & { one?: boolean }) {
  return (
    <Line className={className}>
      <path d="M5 11V9.5A2.5 2.5 0 0 1 7.5 7H19M16.5 4.5 19 7l-2.5 2.5M19 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5M7.5 19.5 5 17l2.5-2.5" />
      {one && <path d="M11.2 10.8 12.4 10v4.2" />}
    </Line>
  );
}

export function UpIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="m7 14 5-5 5 5" />
    </Line>
  );
}

export function DownIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="m7 10 5 5 5-5" />
    </Line>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M7 7l10 10M17 7 7 17" />
    </Line>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7M10.5 10.5v5M13.5 10.5v5" />
    </Line>
  );
}

/** Add to the end of the Queue. */
export function QueueAddIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M4 7h10M4 12h10M4 17h6M17 14v6M14 17h6" />
    </Line>
  );
}

/** Play next: to the head of the Queue. */
export function QueueNextIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M10 7h10M10 12h10M10 17h10M4 9.5l3-2.5-3-2.5" />
    </Line>
  );
}

export function SpeakerIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M5 10v4h3l4 3.5v-11L8 10zM15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
    </Line>
  );
}

export function NoteIcon({ className }: IconProps) {
  return (
    <Line className={className}>
      <path d="M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 18zM19 16a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 19 16z" />
    </Line>
  );
}
