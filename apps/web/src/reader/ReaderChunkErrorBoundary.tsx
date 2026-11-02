import { Component, type ReactNode } from "react";

/**
 * Error boundary for the code-split readers (the reader code-split loads PdfReader/EpubReader
 * via `React.lazy`). A failed chunk download — a stale deploy whose hashed chunk
 * no longer exists, or a flaky network — throws while the lazy component
 * suspends, which without a boundary crashes the whole app. This catches it and
 * renders a recoverable fallback (retry / back to library) instead.
 *
 * `fallback` is a render prop given a `retry` callback. Note: `React.lazy`
 * caches the rejected import promise, so simply re-mounting the same lazy
 * component would re-throw the SAME error — the only reliable re-attempt is a
 * full reload, which also fetches a fresh index.html (new chunk hashes) and is
 * therefore exactly the right recovery for the stale-deploy case. `retry` is
 * wired to that by the caller.
 */
interface Props {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
}

interface State {
  hasError: boolean;
}

export class ReaderChunkErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  private retry = () => {
    // Clear the error so the tree re-mounts, then hard-reload to re-fetch the
    // chunk (the lazy cache holds the rejection, so a soft reset alone can't
    // re-import). Reload is the recovery for a stale deploy.
    this.setState({ hasError: false });
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      return this.props.fallback(this.retry);
    }
    return this.props.children;
  }
}
