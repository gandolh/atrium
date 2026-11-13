import { apiJson, AREAS, expect, test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 } });

interface Book {
  id: string;
  title: string;
  format: string;
}

async function expectNoOverflow(page: import("@playwright/test").Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

for (const area of AREAS) {
  test(`${area.name}: no horizontal overflow at 390`, async ({ page }) => {
    await page.goto(area.path);
    await page.waitForLoadState("networkidle");
    await expectNoOverflow(page);
  });
}

test("the LaTeX editor: no horizontal overflow at 390", async ({ page, baseURL }) => {
  const projects = await apiJson<{ id: string }[]>(page, baseURL ?? "", "/latex");
  await page.goto(`latex?project=${projects[0]?.id}`);
  await page.waitForLoadState("networkidle");
  await expectNoOverflow(page);
});

test("the reader: no horizontal overflow at 390", async ({ page, baseURL }) => {
  const books = await apiJson<Book[]>(page, baseURL ?? "", "/library");
  const tale = books.find((b) => b.format === "epub");
  await page.goto(`read?format=epub&book=${tale?.id}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await expectNoOverflow(page);
});
