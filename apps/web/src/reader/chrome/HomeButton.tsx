import { useNavigate } from "@tanstack/react-router";

import { ToolbarButton } from "./ReaderToolbar";

/**
 * Back-to-home toolbar control. Both readers render `fixed inset-0`, covering
 * the app shell's nav (and the PageNav click-zones would swallow its clicks
 * anyway), so the toolbar is the reader's only reliable way back to the
 * uploader. Format-agnostic — lives in the shared chrome's `leftControls` slot.
 */
export function HomeButton() {
  const navigate = useNavigate();
  return (
    <ToolbarButton label="Back to library" onClick={() => void navigate({ to: "/" })}>
      <HomeIcon />
    </ToolbarButton>
  );
}

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 10.5L12 3l9 7.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 9.5V20a1 1 0 001 1H10v-5.5a2 2 0 014 0V21h3.5a1 1 0 001-1V9.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
