import { expect, test } from "@playwright/test";

test("renders a semantic landing page with stable navigation anchors", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Build worlds people can step into.",
    }),
  ).toBeVisible();
  await expect(page.locator("main#main-content")).toBeVisible();

  const primaryNavigation = page.locator(
    'nav[aria-label="Primary navigation"]',
  );
  const expectedAnchors = [
    ["Platform", "#platform"],
    ["Experiences", "#experiences"],
    ["Workflow", "#workflow"],
    ["Contact", "#contact"],
  ] as const;

  for (const [name, href] of expectedAnchors) {
    await expect(
      primaryNavigation.getByRole("link", {
        name,
        exact: true,
        includeHidden: true,
      }),
    ).toHaveAttribute("href", href);
    await expect(page.locator(href)).toBeAttached();
  }

  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(5);

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
});

test("skip link moves keyboard focus to the main experience", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");

  await expect(page).toHaveURL(/#main-content$/);
});
