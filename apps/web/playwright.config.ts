import { defineConfig, devices } from "@playwright/test";

/**
 * Browser checks for the web app (focus ring, reduced motion, the 390 px overflow, the theme group, the page-turn
 * swipe) and the screenshot run that compares a build against the board's comps.
 *
 * Nothing here starts a server. Start the API on a scratch library (docs/getting-started.md, "Run against a scratch
 * library") and the web dev server, seed an account with `npm run seed:user -w @ebook-reader/api`, then:
 *
 *   E2E_BASE_URL=http://localhost:5173/ SEED_USERNAME=... SEED_PASSWORD=... npx playwright test --workers=2
 *
 * `E2E_API_URL` overrides the API base (default: the dev server's own `/atrium-api`). Two workers at most: the
 * machine is shared with other builds. `E2E_CHROMIUM` names a Chromium executable when the one Playwright expects is
 * not installed.
 */
export default defineConfig({
  testDir: "e2e",
  workers: 2,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173/",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block",
    launchOptions: { executablePath: process.env.E2E_CHROMIUM || undefined },
  },
});
