import { expect, test } from "./fixtures";

const THEME_ATTR = (page: import("@playwright/test").Page) => page.locator("html").getAttribute("data-theme");

test.describe("at 1280", () => {
  test("the rail's group chooses light, warm, dark and System", async ({ page }) => {
    await page.goto("");
    const group = page.getByRole("group", { name: "Theme" });
    await expect(group).toBeVisible();

    for (const [label, theme] of [
      ["Warm theme", "sepia"],
      ["Dark theme", "dark"],
      ["Light theme", "light"],
    ] as const) {
      await group.getByRole("button", { name: label }).click();
      await expect.poll(() => THEME_ATTR(page)).toBe(theme);
    }

    // System resolves to light or dark by the operating system, live.
    await page.emulateMedia({ colorScheme: "dark" });
    await group.getByRole("button", { name: "System theme" }).click();
    await expect.poll(() => THEME_ATTR(page)).toBe("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => THEME_ATTR(page)).toBe("light");
  });

  test("arrow keys only move focus; Space chooses", async ({ page }) => {
    await page.goto("");
    const group = page.getByRole("group", { name: "Theme" });
    await group.getByRole("button", { name: "Light theme" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => THEME_ATTR(page)).toBe("light");
    await page.keyboard.press("Space");
    await expect.poll(() => THEME_ATTR(page)).toBe("sepia");
  });
});

test.describe("at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the top bar's button opens the same group in a popover", async ({ page }) => {
    await page.goto("");
    const button = page.getByRole("button", { name: "Theme: Light" });
    await expect(button).toBeVisible();
    await button.click();
    const group = page.getByRole("group", { name: "Theme" });
    await expect(group).toBeVisible();

    await group.getByRole("button", { name: "Dark theme" }).click();
    await expect.poll(() => THEME_ATTR(page)).toBe("dark");
    await expect(page.getByRole("button", { name: "Theme: Dark" })).toBeVisible();

    await group.getByRole("button", { name: "Warm theme" }).click();
    await expect.poll(() => THEME_ATTR(page)).toBe("sepia");
    await expect(page.getByRole("button", { name: "Theme: Warm" })).toBeVisible();
  });
});
