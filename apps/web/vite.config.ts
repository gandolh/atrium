import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The single .env lives at the repo root (shared with the API), so point Vite's
// env loading there instead of the default per-app dir.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Local dev on one origin, the way Caddy serves the deploy (D54, revising D14):
 * `/atrium-api` is the API with the prefix stripped, and `/ward` + `/ward-api`
 * are the Ward the API trusts (WARD_PUBLIC_ORIGIN; locally the container in
 * wzd_auth/infrastructure/local). With VITE_API_URL pointed at this server's
 * own /atrium-api, the cookie, Ward's redirect back to /atrium/ and signing out
 * behave as they do in the deploy, and CORS never comes into it.
 *
 * Ward refuses /refresh and /logout unless the request's Origin is its own. A
 * request from a page on this dev server would be same-origin in the deploy, so
 * its Origin is rewritten to say so. Anything else keeps its Origin and its
 * Sec-Fetch-Site, and Ward still refuses it.
 */
function devProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {
    "/atrium-api": {
      target: `http://localhost:${env.PORT}`,
      rewrite: (url) => url.replace(/^\/atrium-api/, ""),
    },
  };
  if (!env.WARD_PUBLIC_ORIGIN) return proxy;

  const ward = new URL(env.WARD_PUBLIC_ORIGIN).origin;
  proxy["^/ward(-api)?(/|$)"] = {
    target: ward,
    configure: (server) => {
      server.on("proxyReq", (proxyReq, req) => {
        const origin = req.headers.origin;
        if (origin && URL.canParse(origin) && new URL(origin).host === req.headers.host) {
          proxyReq.setHeader("origin", ward);
        }
      });
    },
  };
  return proxy;
}

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
    server: { proxy: devProxy(env) },
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
              // Cover thumbnails only. Stale-while-revalidate = instant paint
              // from cache, refresh in the background.
              //
              // A cover can change in place (a re-publish regenerates it; D40's
              // `POST /library/:id/cover` is last-write-wins), and since brief 62
              // `coverUrl` carries the cover's version (`?v=<mtime>`), so a
              // changed cover is a new URL and a new cache entry rather than a
              // stale paint. The pattern is a prefix, so versioned URLs match.
              urlPattern: coverUrlPattern,
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "cover-thumbnails",
                expiration: { maxEntries: 200 },
                // Opaque responses (status 0) were the norm while the API was
                // cross-origin (before D54); kept so a cross-origin build
                // still caches.
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
  };
});
