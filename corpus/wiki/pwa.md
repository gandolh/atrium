---
summary: The PWA layer (briefs 19–20) — installable shell via vite-plugin-pwa/generateSW with prompt-mode updates, cover-only runtime caching, and offline reading via a three-store IndexedDB (metadata/blobs/progress) with explicit per-book downloads and last-write-wins progress sync.
updated: 2026-08-24
---

# PWA & offline reading

Shipped 2026-07-16 (briefs 19–20). The app is installable, the shell loads from
a service-worker cache, and explicitly-downloaded books are fully readable with
zero connectivity.

## Shell (brief 19)

- `vite-plugin-pwa` (**generateSW** — declarative Workbox, no source `sw.ts`),
  configured entirely in [vite.config.ts](../../apps/web/vite.config.ts).
  Anything needing custom SW fetch logic later must migrate to `injectManifest`;
  offline books deliberately did NOT need that (they're read app-side from
  IndexedDB, not intercepted in the SW).
- Manifest colors are the one allowed raw-hex site (`#fcf9f8` = `--paper`).
  Icons in `apps/web/public/` (192/512/maskable/apple-touch).
- Precache includes the pdf.js worker (`mjs` in globPatterns — the reader must
  work offline). **35 entries / ~3047 KiB** as of the Reading Room rework.
- **`woff` is deliberately absent from `globPatterns`** (D33 work): `@fontsource`
  ships a `.woff` fallback beside every `.woff2`, and precaching both spent
  ~299 KiB on a format no browser that can run this app will request. The files
  are still built and served, just not precached.
- **Updates are prompt-mode**: `registerType: "prompt"`, `injectRegister:
  false`, [UpdateToast.tsx](../../apps/web/src/pwa/UpdateToast.tsx)
  (`useRegisterSW`) mounted in the root layout outside the auth gate. Never add
  `skipWaiting`/`clientsClaim` — no silent swap mid-read.
- Runtime caching: **cover thumbnails only** (stale-while-revalidate, 200
  entries), pattern derived from the `VITE_API_URL` **origin** (cover URLs drop
  any base path — see `coverUrl`). No other API caching; auth/freshness stay
  server-driven.
- `scope`/`start_url`/`navigateFallback` all derive from `BASE_PATH`
  (normalized to a trailing slash). Verified against a non-root base.

## Offline reading (brief 20)

Locked product decisions: explicit per-book download (no auto-cache), IndexedDB
storage, last-write-wins progress sync (no mutation queue), cached content
readable offline without re-auth, upload/delete online-only.

- [offline-store.ts](../../apps/web/src/lib/offline-store.ts): typed IndexedDB
  wrapper, DB `ebook-reader:offline` **v2**, three stores — `books` (metadata
  snapshot, no blob), `files` (id → blob), `progress`
  (`{fraction, locator, updatedAt, syncedAt}`). The blob/metadata split is
  load-bearing: snapshot refreshes and listings must never deserialize or
  rewrite blobs (a v1 single-store design thrashed ~100s of MB per Home visit).
  v1→v2 upgrade migrates blobs in the versionchange transaction.
- Open path: `useHydrateBook` checks the offline store first (even online);
  miss → network as before. Reader renderers unchanged — they still consume an
  in-memory `File`.
- Library: `useLibraryList` serves cached rows + `isOffline` when `GET /library`
  fails; `useOfflineDownload` powers the cover toggle
  ([OfflineToggle.tsx](../../apps/web/src/library/OfflineToggle.tsx), top-left
  on the card), the storage caption in `LibraryHeader`, and remove.
- Progress: every debounced sync tick also writes the local row;
  `useReconnectProgressSync` (mounted once on Home) flushes pending rows
  (`updatedAt > syncedAt`) **once** on start/`online` — guarded by an in-flight
  latch and identity-stable row arrays (review caught a live 3×-duplicate-PATCH
  bug from unstable references; fixed and re-verified at exactly 1 PATCH).
  Resume prefers a pending local row so a snapshot refresh can't shadow an
  offline reading position. The wire `LibraryBook` has no per-user progress
  timestamp, so pending-ness is local-only — revisit if the API ever returns
  `updated_at`.

## Known edges

- With zero downloads, going offline shows the plain error state (there's
  nothing cached to fall back to) — `isOffline` only flips when cached rows
  exist.
- Deploy prerequisite: service workers require HTTPS in production.
- E2E evidence (2026-07-16, real browser): download → offline reload → banner +
  downloaded covers → EPUB opens/pages/resumes at exact CFI → PDF opens →
  reconnect PATCHes exactly once; v1→v2 migration exercised against a live
  profile; update toast exercised across a real rebuild.
