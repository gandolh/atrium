import { apiJson, expect, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** A touch swipe through the browser's own input path, so the page sees real touch events. */
async function swipe(page: import("@playwright/test").Page, from: [number, number], to: [number, number]) {
  const client = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(...from) });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("a swipe on the reader turns the page, and back", async ({ page, baseURL }) => {
  const books = await apiJson<{ id: string; format: string }[]>(page, baseURL ?? "", "/library");
  const tale = books.find((b) => b.format === "epub");
  await page.goto(`read?format=epub&book=${tale?.id}`);
  const pageField = page.getByRole("textbox", { name: /Go to page/ });
  await expect(pageField).toHaveValue("1", { timeout: 15_000 });

  await swipe(page, [320, 400], [80, 405]);
  await expect(pageField).toHaveValue("2");

  await swipe(page, [80, 400], [320, 405]);
  await expect(pageField).toHaveValue("1");
});
