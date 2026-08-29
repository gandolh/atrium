# Task 18 — Stand up a repeatable live performance benchmark (CWV / trace)

## Context (2026-07-13)
The 2026-07-13 performance pass (see [log.md](../../log.md)) measured what's
cheap to measure without a browser: **production bundle sizes** (1.42 MB entry
JS, 1.05 MB pdf worker, 920 KB fonts) and **code-level hot paths** (EPUB
double-parse). What it could **not** produce is *live field-shaped* numbers —
Core Web Vitals (LCP/CLS/INP), main-thread traces, and the real
click-cover→page-visible timing on a throttled connection — because:
- the `performance-analysis` personal skill needs the **Chrome DevTools MCP**
  server, which is **not registered** in this environment, and
- the app is auth-gated (per-user accounts), so a trace run needs a logged-in,
  stateful session.

Without live measurement, the improvement briefs (15/16/17) are ranked by
*payload* and *code reasoning*, not by *measured user time*. This brief closes
that gap so future perf work is measured, not guessed.

## Files you OWN
- A perf-measurement entry in the Playwright hub (`playwright/`, gitignored) or a
  small script — bring up a **production-like build** (`vite build && vite
  preview` + the API), log in (seeded account), open a PDF and an EPUB, and
  capture navigation + resource timing and the cover→page-visible duration.
- Optionally `.mcp.json` to register `chrome-devtools-mcp@<pin> --isolated` for
  Lighthouse/CWV/trace runs (see the `performance-analysis` skill).
- A results doc under `corpus/test-plans/` (retired 2026-08-29) or a `wiki/performance.md` page for the baseline numbers.

## Files you must NOT touch
- App source — this brief only *measures*; fixes live in briefs 15–17.

## What to do
1. Decide the driver: **chrome-devtools MCP** (best — Lighthouse + traces + CWV; register it, interactive session) or **agent-browser** (fallback for the auth-gated flow — navigation/resource timing via `performance.getEntriesByType`, network HAR).
2. Script a repeatable run against a **preview/production build** (not dev): login → library load → open the 24 MB EPUB → open a PDF, on a throttled profile (mid-tier CPU + Slow-4G). Take the median of 2–3 runs.
3. Record a **baseline**: LCP/CLS/INP (if MCP), initial JS transfer, cover→first-page-visible for each format, EPUB open-time phases.
4. File the baseline into the corpus (`wiki/performance.md`) so briefs 15–17 can be re-measured against it and cite real deltas.

## Acceptance
- A documented, repeatable way to produce live perf numbers for this app.
- A recorded baseline (at least: initial JS transfer, cover→page-visible per format, EPUB open phases; CWV if MCP is available).
- The measurement targets a production-like build, on a stated throttle profile, with the build + profile named.

## Outcome (2026-07-13) — done

Shipped. Stood up a repeatable live perf benchmark: `playwright/perf/` (README + `instrument.js` agent-browser eval snippets) and a new `corpus/wiki/performance.md` baseline (linked from index.md). Chrome DevTools MCP is unavailable here, so the driver is agent-browser against a production-like `vite preview` build, logged in as a seeded user. **Live baseline: initial JS 123 kB gz (code-split verified — reader chunks/worker absent until a book opens); PDF cover→first-page 513 ms cold / 85 ms warm; EPUB (24 MB) cover→reader 880 ms cold / 601 ms warm, of which ~450–700 ms is client-side epub.js parse/render (the 24 MB transfer is only ~150 ms on loopback).** Also found `/file` is served no-cache so the 24 MB re-downloads every open — noted for a future caching brief. This measurement directly fed brief 16.
