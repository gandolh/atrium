import { expect, test as base, type Page } from "@playwright/test";

/**
 * The scratch library the checks run against. The account comes from `SEED_USERNAME` and `SEED_PASSWORD` in the
 * environment (never a file in the repo); the library holds a published LaTeX project `Field notes` (a PDF), an
 * EPUB `A Small Tale` by `Made Up` and a note `Garden plan`. Nothing here touches a real library.
 */

/** The moment the screenshots freeze the clock at, so relative times ("21m ago") read the same on every run. */
export const NOW = new Date("2026-11-13T13:15:00Z");

/** The areas the focus, motion and overflow checks walk: a name and the path (under the base) that opens it. */
export const AREAS: readonly { name: string; path: string }[] = [
  { name: "library", path: "" },
  { name: "notes", path: "notes" },
  { name: "latex", path: "latex" },
  { name: "jukebox", path: "jukebox" },
  { name: "discover", path: "discover" },
  { name: "profiles", path: "profiles" },
  { name: "settings", path: "settings" },
];

function credentials(): { username: string; password: string } {
  const username = process.env.SEED_USERNAME;
  const password = process.env.SEED_PASSWORD;
  if (!username || !password) throw new Error("Set SEED_USERNAME and SEED_PASSWORD to a scratch account's login.");
  return { username, password };
}

function apiBase(baseURL: string): string {
  return process.env.E2E_API_URL ?? new URL("/atrium-api", baseURL).toString();
}

export type ThemePick = "light" | "sepia" | "dark" | "system";

/**
 * Signs the page's context in through the API, so the cookie rides every later request, and remembers the account's
 * profile `Default` on the device (the "Who's reading?" picker only shows when the device has no fresh choice). The
 * theme is saved to the profile, the way the theme switch saves it, and mirrored to the boot cache the app paints from.
 */
export async function signIn(page: Page, baseURL: string, theme: ThemePick = "light"): Promise<void> {
  const request = page.context().request;
  const headers = { Origin: new URL(baseURL).origin };
  const login = await request.post(`${apiBase(baseURL)}/auth/login`, { headers, data: credentials() });
  expect(login.ok(), "the scratch account signs in").toBe(true);
  const profiles = (await (await request.get(`${apiBase(baseURL)}/profiles`)).json()) as { id: string; name: string }[];
  const profile = profiles.find((p) => p.name === "Default") ?? profiles[0];
  const saved = await request.patch(`${apiBase(baseURL)}/profiles/${profile.id}/preferences`, {
    headers,
    data: { theme },
  });
  expect(saved.ok(), "the theme is saved to the profile").toBe(true);
  await page.addInitScript(
    ({ id, pick }) => {
      localStorage.setItem("ebook-reader.profile", id);
      localStorage.setItem("ebook-reader.profile-activity", String(Date.now()));
      localStorage.setItem(`ebook-reader:preferences:${id}`, JSON.stringify({ theme: pick }));
    },
    { id: profile.id, pick: theme },
  );
}

/** The API's JSON for one path, as the signed-in account. */
export async function apiJson<T>(page: Page, baseURL: string, path: string): Promise<T> {
  const response = await page.context().request.get(`${apiBase(baseURL)}${path}`);
  expect(response.ok(), `GET ${path}`).toBe(true);
  return (await response.json()) as T;
}

/**
 * The Gutenberg catalogue, stubbed: no check or screenshot reaches the public catalogue. The books are made up, with
 * no cover (the page then shows its typographic tile).
 */
const CATALOG_STUB = {
  results: Array.from({ length: 12 }, (_, i) => ({
    id: 900_001 + i,
    title:
      ["A Small Tale", "The Lamp", "The Window", "The Door", "The Road", "A Long Road"][i % 6] +
      (i >= 6 ? " (second edition)" : ""),
    authors: ["Made Up"],
    subjects: ["Fiction"],
    languages: ["en"],
    coverUrl: null,
    downloadCount: 1000 - i * 10,
    epubAvailable: true,
  })),
  count: 12,
  nextPage: null,
};

async function stubCatalog(page: Page): Promise<void> {
  await page.route("**/catalog/gutenberg**", (route) => route.fulfill({ json: CATALOG_STUB }));
}

/** `test` with the page already signed in; `test.use({ theme: "dark" })` picks the theme it opens in. */
export const test = base.extend<{ theme: ThemePick }>({
  theme: ["light", { option: true }],
  page: async ({ page, baseURL, theme }, use) => {
    await stubCatalog(page);
    await signIn(page, baseURL ?? "http://localhost:5173/", theme);
    await use(page);
  },
});

export { expect };
