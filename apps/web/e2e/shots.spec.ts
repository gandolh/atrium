import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { apiJson, AREAS, NOW, test, type ThemePick } from "./fixtures";

/**
 * Screenshots of every screen, for comparing a build against the board's comps. Off unless `SHOTS_DIR` names a folder
 * (outside git): `SHOTS_DIR=<dir> npx playwright test shots --workers=2`. One file per screen, theme and width,
 * named `<screen>-<theme>-<width>.png`, with the clock frozen at `NOW`.
 */
const dir = process.env.SHOTS_DIR ?? "";
const THEMES: readonly ThemePick[] = ["light", "sepia", "dark"];
const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

interface Book {
  id: string;
  title: string;
  format: string;
}

for (const theme of THEMES) {
  for (const { width, height } of WIDTHS) {
    test.describe(`${theme} ${width}`, () => {
      test.skip(dir === "", "set SHOTS_DIR to take screenshots");
      test.use({ theme, viewport: { width, height } });

      test.beforeEach(async ({ page }) => {
        await page.clock.install({ time: NOW });
        await page.clock.resume();
      });

      async function shoot(page: import("@playwright/test").Page, screen: string) {
        mkdirSync(dir, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `${screen}-${theme}-${width}.png`), fullPage: true });
      }

      for (const area of AREAS) {
        test(`area ${area.name}`, async ({ page }) => {
          await page.goto(area.path);
          await page.waitForLoadState("networkidle");
          await shoot(page, area.name);
        });
      }

      test("latex editor", async ({ page, baseURL }) => {
        const projects = await apiJson<{ id: string }[]>(page, baseURL ?? "", "/latex");
        await page.goto(`latex?project=${projects[0]?.id}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1500);
        await shoot(page, "latex-editor");
      });

      test("pdf reader", async ({ page, baseURL }) => {
        const books = await apiJson<Book[]>(page, baseURL ?? "", "/library");
        const pdf = books.find((b) => b.format === "pdf");
        if (!pdf) throw new Error("The scratch library has no PDF.");
        await page.goto(`read?format=pdf&book=${pdf.id}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        await shoot(page, "pdf-reader");
      });

      test("profile picker", async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem("ebook-reader.profile"));
        await page.goto("");
        await page.waitForLoadState("networkidle");
        await shoot(page, "profile-picker");
      });

      test("login", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto("");
        await page.waitForLoadState("networkidle");
        await shoot(page, "login");
      });

      test("reader", async ({ page, baseURL }) => {
        const books = await apiJson<Book[]>(page, baseURL ?? "", "/library");
        const tale = books.find((b) => b.title === "A Small Tale");
        if (!tale) throw new Error("The scratch library has no A Small Tale.");
        await page.goto(`read?format=${tale.format}&book=${tale.id}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1500);
        await shoot(page, "reader");
      });
    });
  }
}
