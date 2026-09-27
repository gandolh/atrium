/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /**
   * Base URL of the Fastify API: `/atrium-api` on the page's own origin, which
   * the dev server proxies in development (decisions.md D54, revising D14).
   * Required: `vite.config.ts` throws if it's unset, so it is always defined at
   * build/runtime.
   */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
