import type { ReactNode } from "react";

/**
 * The shell's places: where the rail (at 1280) and the bottom bar (on a phone) take you. Notes, LaTeX and the
 * Jukebox are peers of the library, not kinds (D33 g, D36), so they are places here. Browse catalogs is an action
 * on the rail, not a place.
 */
export interface Place {
  to: "/" | "/notes" | "/latex" | "/jukebox";
  label: string;
  icon: (props: { size: number }) => ReactNode;
}

function Glyph({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const PLACES: readonly Place[] = [
  {
    to: "/",
    label: "Library",
    icon: ({ size }) => (
      <Glyph size={size}>
        <path d="M5 4v16M10 4v16" />
        <path d="M15 5.5l4 1-3.2 13.5-4-1z" />
      </Glyph>
    ),
  },
  {
    to: "/notes",
    label: "Notes",
    icon: ({ size }) => (
      <Glyph size={size}>
        <path d="M6 3.5h8l4 4V20.5H6z" />
        <path d="M14 3.5v4h4M9 12.5h6M9 16.5h4" />
      </Glyph>
    ),
  },
  {
    to: "/latex",
    label: "LaTeX",
    icon: ({ size }) => (
      <Glyph size={size}>
        <path d="M18 5H7l6 7-6 7h11" />
      </Glyph>
    ),
  },
  {
    to: "/jukebox",
    label: "Jukebox",
    icon: ({ size }) => (
      <Glyph size={size}>
        <path d="M9 18V6l10-2v12" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="16" r="2.5" />
      </Glyph>
    ),
  },
];

export function CompassIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </Glyph>
  );
}

export function PlusIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  );
}

export function FolderPlusIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </Glyph>
  );
}

export function SearchIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Glyph>
  );
}
