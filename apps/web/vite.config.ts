import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The single .env lives at the repo root (shared with the API), so point Vite's
// env loading there instead of the default per-app dir.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Prefix "" loads every var (VITE_* and BASE_PATH) from the root .env.
  const env = loadEnv(mode, REPO_ROOT, "");

  // Required var: fail the dev server / build fast rather than baking in an
  // undefined API base URL. Mirrors the API's config.ts contract.
  if (!env.VITE_API_URL) {
    throw new Error(
      "Missing required env var VITE_API_URL. Copy .env.example to .env at the repo root and set it.",
    );
  }

  // Served under a sub-path in production (e.g. /ebook-reader/). Everything the
  // PWA emits — manifest scope/start_url, the service-worker registration
  // scope, precache URLs — must respect this, so derive it once and reuse it
  // rather than hardcoding "/". scope/start_url/navigateFallback all assume a
  // trailing slash, so normalize one on (BASE_PATH may be set without it).
  const rawBase = env.BASE_PATH ?? "/";
  const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

  // Runtime-cache match for cover thumbnails ONLY (brief 19). Covers are the
  // one API surface we cache: immutable-per-book images fetched by
  // `<img src="<api-base>/library/:id/cover?token=…">`. `coverUrl` builds those
  // via `apiUrl()`, which PRESERVES any path prefix on VITE_API_URL (e.g. a
  // reverse-proxy prefix like /atrium-api) — so derive the pattern from the
  // full base, not just the origin (and nothing else — no general API caching;
  // auth + freshness stay server-driven). Regex-escaped; unanchored tail lets
  // the `?token=…` query ride along.
  const apiUrl = new URL(env.VITE_API_URL);
  const apiBase = (apiUrl.origin + apiUrl.pathname.replace(/\/+$/, "")).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const coverUrlPattern = new RegExp(`^${apiBase}/library/[^/]+/cover`);

  return {
    base,
    envDir: REPO_ROOT,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // "prompt": never silently swap the running app out from under the
        // reader. A waiting worker surfaces the reload toast (see
        // src/pwa/UpdateToast.tsx) and only activates on the user's click.
        registerType: "prompt",
        // We register the SW ourselves via `useRegisterSW` in the toast, so the
        // plugin must NOT also inject its own registration script (that would
        // double-register).
        injectRegister: false,
        // The four icon PNGs (apple-touch + 3 manifest icons) live in `public/`
        // and are copied to dist root, where the widened `png` glob below already
        // precaches them. Disable the plugin's own icon inclusion so each is
        // precached ONCE, not twice: `includeManifestIcons: false` drops the
        // auto-added manifest icons, and no `includeAssets` keeps apple-touch
        // single (its <link> is hand-written in index.html, not injected here).
        includeManifestIcons: false,
        manifest: {
          name: "Atrium",
          short_name: "Atrium",
          description:
            "Your personal library of books, music, and video — open and enjoy anywhere.",
          // Standalone so the installed app drops the browser chrome and feels
          // like a native reader.
          display: "standalone",
          // Scope + start_url follow the deploy sub-path (see `base` above), so
          // installs work under a non-root BASE_PATH, not just "/".
          scope: base,
          start_url: base,
          orientation: "portrait",
          // Raw hex is sanctioned in manifest JSON only (design.md / D33) — the
          // manifest is emitted before any stylesheet exists, so it cannot read
          // a token. Both are Reading Room's `--paper` ground: the app is
          // paper-first and light by default, so browser UI + the splash ground
          // stay seamless with the page, never glowing. Keep in step with
          // `--paper` in globals.css, the <meta name="theme-color"> in
          // index.html, and the icon grounds in public/.
          theme_color: "#f7f5f2",
          background_color: "#f7f5f2",
          // Icon `src`s are relative, so they resolve against the manifest URL
          // (itself emitted under `base`) — base-correct without hardcoding it.
          icons: [
            { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
            {
              src: "pwa-maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Precache the built shell. Extend the default globs: `mjs` catches
          // the pdf.js worker chunk (emitted as ESM) and `woff`/`woff2` the
          // self-hosted @fontsource files — otherwise both are silently left
          // out of the shell.
          // `woff` is deliberately absent: @fontsource ships a .woff fallback
          // beside every .woff2, and precaching both doubled the font payload
          // for a format no browser that can run this app (React 19, Base UI,
          // service workers) will ever request. The files are still built and
          // served — they're just not worth a precache slot.
          globPatterns: ["**/*.{js,mjs,css,html,ico,png,svg,woff2}"],
          // The pdf.js worker chunk is large; lift the precache size ceiling
          // (default 2 MiB) so the shell caches whole rather than partially.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          // SPA fallback: unknown navigations resolve to the app shell (index),
          // base-aware so deep links work under a sub-path.
          navigateFallback: `${base}index.html`,
          runtimeCaching: [
            {
              // Cover thumbnails only (cross-origin API). Stale-while-revalidate
              // = instant paint from cache, refresh in the background.
              //
              // Covers used to be immutable per book, which made staleness
              // harmless outright. Brief 42 ended that: `POST /library/:id/cover`
              // is a last-write-wins setter (D40), so a book's cover CAN change
              // under a URL that never does — `coverUrl` carries no content
              // version, only the auth token. SWR is still the right handler
              // (the stale paint is one view old and the refresh lands right
              // behind it), and acquiring a FIRST cover is unaffected: the card
              // was drawing the typographic tile, and the library refetch that
              // flips `hasCover` requests the image fresh. What is no longer
              // true is that staleness cannot happen at all. If a "pick a
              // different frame" affordance ever makes replacement routine, the
              // cure is a content version in the cover URL, not a handler swap.
              urlPattern: coverUrlPattern,
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "cover-thumbnails",
                expiration: { maxEntries: 200 },
                // `<img>` requests are cross-origin without CORS, so responses
                // are opaque (status 0); cache those as well as 200s.
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
  };
});
