import { AREAS, expect, test } from "./fixtures";

/** A tab stop is any focusable element; the walk ends when focus returns to the page body. */
const MAX_STOPS = 80;

for (const area of AREAS) {
  test(`${area.name}: every tab stop shows a focus ring`, async ({ page }) => {
    await page.goto(area.path);
    await page.waitForLoadState("networkidle");

    const stops: string[] = [];
    const bare: string[] = [];
    for (let i = 0; i < MAX_STOPS; i++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
        const shadow = style.boxShadow !== "none";
        const name =
          el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40) ?? el.tagName.toLowerCase();
        return { name: `${el.tagName.toLowerCase()} ${name}`, ring: outline || shadow };
      });
      if (!stop) break;
      stops.push(stop.name);
      if (!stop.ring) bare.push(stop.name);
    }

    expect(stops.length, "the page has tab stops").toBeGreaterThan(0);
    expect(bare, "tab stops with no outline or ring").toEqual([]);
  });
}
