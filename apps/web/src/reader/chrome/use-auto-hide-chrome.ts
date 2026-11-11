import { useCallback, useEffect, useRef } from "react";

import { useReaderStore } from "../../store/reader-store";

/**
 * Reader chrome visibility (wiki/reader.md). Auto-hide, reintroduced
 * (2026-07-16 UI review, track C): the top bar, toolbar, and progress rail
 * fade out after `idleMs` of no activity so the page is the interface —
 * the Kindle / Apple Books / reading-mode convention — and any activity
 * (pointer movement, touch, key press, scroll) brings them back.
 *
 * NOTE: this reverses the earlier "bars always shown" decision; the hook was
 * kept as the single seam for exactly this reintroduction.
 *
 * Activity inside the EPUB iframe never reaches window listeners — the reader
 * forwards rendition events into the returned `reveal` (same pattern as the
 * old forwarder call sites, which kept working unchanged).
 *
 * Holds: the store's `chromeHoldCount` (acquire/releaseChromeHold) pins the
 * chrome while a transient surface (settings popover, search panel, TOC
 * drawer) is open or focus sits inside the toolbar — `useChromeHold(active)`
 * is the per-surface wrapper. The hide timer itself is module-scoped so hold
 * releases (which happen in other component subtrees) can restart it.
 */

const HIDE_DELAY_MS = 3000;

let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide(idleMs: number = HIDE_DELAY_MS) {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    const store = useReaderStore.getState();
    if (store.chromeHoldCount === 0) store.setChromeVisible(false);
  }, idleMs);
}

export function useAutoHideChrome(options: { idleMs?: number; enabled?: boolean } = {}): () => void {
  const { idleMs = HIDE_DELAY_MS, enabled = true } = options;
  const setChromeVisible = useReaderStore((s) => s.setChromeVisible);
  const idleMsRef = useRef(idleMs);
  idleMsRef.current = idleMs;

  const reveal = useCallback(() => {
    useReaderStore.getState().setChromeVisible(true);
    scheduleHide(idleMsRef.current);
  }, []);

  useEffect(() => {
    setChromeVisible(true);
    if (!enabled) return;

    scheduleHide(idleMsRef.current);

    // Which activity reveals the chrome depends on the input class (the
    // Kindle/Kobo tap-zone grammar, option A of the 2026-07-16 follow-up):
    // - Fine pointers: any movement/press/scroll reveals — the user is
    //   reaching for a control.
    // - Touch screens: taps are MEANINGFUL (side zones flip the page, the
    //   center tap toggles the chrome — wired in the readers), so a bare
    //   touch/pointer event must NOT blanket-reveal or every silent page
    //   flip would pop the toolbar. Keyboard/focus still reveals.
    // All passive — reveal never needs to preventDefault.
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const events = coarse
      ? (["keydown", "focusin"] as const)
      : (["pointermove", "pointerdown", "keydown", "wheel", "focusin"] as const);
    for (const type of events) window.addEventListener(type, reveal, { passive: true });

    return () => {
      for (const type of events) window.removeEventListener(type, reveal);
      clearHideTimer();
      setChromeVisible(true); // leaving the reader restores the chrome
    };
  }, [enabled, reveal, setChromeVisible]);

  return reveal;
}

/**
 * Center-tap chrome toggle (the tap-zone grammar's third zone). Hiding also
 * cancels any pending hide timer; revealing arms it, same as `reveal`.
 */
export function useChromeToggle(): () => void {
  return useCallback(() => {
    const store = useReaderStore.getState();
    if (store.chromeVisible) {
      clearHideTimer();
      store.setChromeVisible(false);
    } else {
      store.setChromeVisible(true);
      scheduleHide();
    }
  }, []);
}

/**
 * Pin the chrome open while a surface (popover/drawer/search/toolbar focus) is
 * active so the idle timer can't fade it away mid-interaction. Backed by the
 * store's `chromeHoldCount`; releasing the last hold restarts the timer.
 */
export function useChromeHold(active: boolean): void {
  const acquire = useReaderStore((s) => s.acquireChromeHold);
  const release = useReaderStore((s) => s.releaseChromeHold);

  useEffect(() => {
    if (!active) return;
    acquire();
    clearHideTimer();
    return () => {
      release();
      if (useReaderStore.getState().chromeHoldCount === 0) scheduleHide();
    };
  }, [active, acquire, release]);
}
