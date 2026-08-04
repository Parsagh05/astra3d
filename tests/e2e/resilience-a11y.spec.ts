import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("loads the WebGL enhancement after pointer intent", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Desktop WebGL check");

  await page.goto("/");

  const heroCanvas = page.locator(".hero-portal__canvas");
  await expect(heroCanvas.locator("canvas")).toHaveCount(0);

  await heroCanvas.dispatchEvent("pointerenter");

  await expect(heroCanvas.locator("canvas")).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(heroCanvas).toHaveAttribute("data-ready", "true", {
    timeout: 15_000,
  });
});

test.describe("motion and rendering resilience", () => {
  test.describe("with reduced motion", () => {
    test("keeps the static hero environment and skips WebGL", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");

      const heroPortal = page.locator(".hero-portal");
      const heroCanvas = page.locator(".hero-portal__canvas");
      await heroCanvas.dispatchEvent("pointerenter");
      await expect(heroPortal).toBeVisible();
      await expect(heroPortal).toHaveCSS(
        "background-image",
        /experience-retail\.webp/,
      );
      await expect(heroCanvas).toHaveAttribute("data-ready", "false");
      await expect(heroCanvas.locator("canvas")).toHaveCount(0);
    });
  });

  test("gracefully falls back when WebGL context creation fails", async ({ page }) => {
    await page.addInitScript(() => {
      const canvasPrototype = window.HTMLCanvasElement.prototype;
      const originalGetContext = canvasPrototype.getContext;

      canvasPrototype.getContext = function getContext(
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown,
      ) {
        if (contextId === "webgl" || contextId === "webgl2") return null;
        return originalGetContext.call(this, contextId, options);
      } as typeof originalGetContext;
    });

    await page.goto("/");

    const heroPortal = page.locator(".hero-portal");
    const heroCanvas = page.locator(".hero-portal__canvas");
    await heroCanvas.dispatchEvent("pointerenter");
    await expect(heroPortal).toBeVisible();
    await expect(heroPortal).toHaveCSS(
      "background-image",
      /experience-retail\.webp/,
    );
    await expect(heroCanvas).toHaveAttribute("data-ready", "false");
    await expect(heroCanvas.locator("canvas")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Build worlds people can step into.",
      }),
    ).toBeVisible();
  });
});

test("landing page and demo dialog have no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");

  const landingResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const landingViolations = landingResults.violations.filter(({ impact }) =>
    impact === "serious" || impact === "critical",
  );
  expect(landingViolations).toEqual([]);

  await page
    .locator(".hero__actions")
    .getByRole("button", { name: "Book a demo" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const dialogResults = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const dialogViolations = dialogResults.violations.filter(({ impact }) =>
    impact === "serious" || impact === "critical",
  );
  expect(dialogViolations).toEqual([]);
});
