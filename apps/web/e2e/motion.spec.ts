import { AREAS, expect, test } from "./fixtures";

test.use({ contextOptions: { reducedMotion: "reduce" } });

for (const area of AREAS) {
  test(`${area.name}: nothing animates or transitions under reduced motion`, async ({ page }) => {
    await page.goto(area.path);
    await page.waitForLoadState("networkidle");
    // Let a page's own entrance settle: a running animation at rest is what the check is for.
    await page.waitForTimeout(800);

    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .map((a) => {
          const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
          const name =
            a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : "script";
          return `${name} on ${target instanceof Element ? target.tagName.toLowerCase() : "?"}`;
        }),
    );
    expect(running, "running animations or transitions").toEqual([]);
  });
}
