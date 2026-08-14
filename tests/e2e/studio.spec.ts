import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2oV0AAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Camera unavailable in automated test", "NotAllowedError");
        },
      },
    });
  });
});

test("offers a guided phone capture route without horizontal overflow", async ({ page }) => {
  await page.goto("/studio/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Turn phone photos into your first 360° room.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Photos stay on this device")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByText("Camera preview blocked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture 1" })).toBeVisible();
  await expect(page.getByText("0 / 24")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
});

test("assembles 24 guided images into a locally generated room", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Full assembly is covered once to keep the mobile suite fast.");
  test.setTimeout(45_000);

  await page.goto("/studio/");
  await page.getByRole("textbox", { name: "Room name" }).fill("Test living room");
  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByText("Camera preview blocked")).toBeVisible();

  const input = page.locator('input[type="file"]');
  for (let index = 0; index < 24; index += 1) {
    await input.setInputFiles({
      name: `room-${index + 1}.png`,
      mimeType: "image/png",
      buffer: pixelPng,
    });
    await expect(page.getByText(`${index + 1} / 24`)).toBeVisible();
  }

  await page.getByRole("button", { name: /Build my 360/i }).click();
  await expect(page.getByRole("heading", { name: "Test living room" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Download 360 JPG/i })).toBeEnabled();
  await expect(page.getByText("Private · on device")).toBeVisible();
});
