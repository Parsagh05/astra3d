import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function dispatchOrientation(page: Page, alpha: number, beta: number) {
  await page.evaluate(({ heading, tilt }) => {
    const event = new Event("deviceorientation");
    Object.defineProperties(event, {
      alpha: { value: heading },
      beta: { value: tilt },
    });
    window.dispatchEvent(event);
  }, { heading: alpha, tilt: beta });
}

async function beginGuidedBand(page: Page, buttonName: string, beta: number) {
  await page.getByRole("button", { name: buttonName }).click();
  await page.waitForTimeout(2_150);
  await dispatchOrientation(page, 0, beta);
  await expect(page.getByText("Target 1 of 8")).toBeVisible({ timeout: 3_500 });
}

async function holdTarget(page: Page, alpha: number, beta: number) {
  for (let sample = 0; sample < 9; sample += 1) {
    await dispatchOrientation(page, alpha, beta);
    await page.waitForTimeout(90);
  }
}

async function completeGuidedBand(page: Page, beta: number, startingTotal: number) {
  for (let index = 0; index < 8; index += 1) {
    await holdTarget(page, index * 45, beta);
    await expect(page.getByText(`${startingTotal + index + 1} / 24`)).toBeVisible();
  }
}

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

test("offers a secure guided phone capture route without horizontal overflow", async ({ page }) => {
  await page.goto("/studio/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Scan once. Look around forever.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Your scan stays on this device")).toBeVisible();

  const captureAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    captureAccessibility.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByText("Secure live camera required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Secure connection required" })).toBeDisabled();
  await expect(page.getByText("0 / 24")).toBeVisible();

  const dialGeometry = await page
    .locator('[aria-label="Current rotation coverage"] > div')
    .evaluate((dial) => {
      const bounds = dial.getBoundingClientRect();
      const center = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
      const nodes = Array.from(dial.querySelectorAll(":scope > i")).map((node) => {
        const nodeBounds = node.getBoundingClientRect();
        return {
          x: nodeBounds.left + nodeBounds.width / 2,
          y: nodeBounds.top + nodeBounds.height / 2,
        };
      });
      return {
        center,
        centroid: {
          x: nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length,
          y: nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length,
        },
        radii: nodes.map((node) => Math.hypot(node.x - center.x, node.y - center.y)),
        nodeCount: nodes.length,
      };
    });

  expect(dialGeometry.nodeCount).toBe(8);
  expect(Math.max(...dialGeometry.radii) - Math.min(...dialGeometry.radii)).toBeLessThan(2);
  expect(Math.abs(dialGeometry.centroid.x - dialGeometry.center.x)).toBeLessThan(1);
  expect(Math.abs(dialGeometry.centroid.y - dialGeometry.center.y)).toBeLessThan(1);

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
});

test("captures live still targets and requires all three tilt bands", async ({ page }) => {
  test.setTimeout(50_000);
  await page.addInitScript(() => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
      configurable: true,
      get: () => 900,
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      configurable: true,
      get: () => 1200,
    });
    HTMLMediaElement.prototype.play = async () => undefined;
    CanvasRenderingContext2D.prototype.drawImage = () => undefined;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => new MediaStream(),
      },
    });
  });

  await page.goto("/studio/");
  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByRole("button", { name: "Begin eye-level capture" })).toBeVisible();

  await beginGuidedBand(page, "Begin eye-level capture", 90);
  await completeGuidedBand(page, 90, 0);
  await expect(page.getByRole("button", { name: "Begin +35° capture" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Build my 360/i })).toHaveCount(0);

  await beginGuidedBand(page, "Begin +35° capture", 55);
  await completeGuidedBand(page, 55, 8);
  await expect(page.getByRole("button", { name: "Begin −35° capture" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Build my 360/i })).toHaveCount(0);

  await beginGuidedBand(page, "Begin −35° capture", 125);
  await completeGuidedBand(page, 125, 16);
  await expect(page.getByRole("button", { name: /Build my 360/i })).toBeVisible();
  await expect(page.getByText("All three room sweeps are captured.")).toBeVisible();
});

test("switches to manual capture, zooms the saved crop, and retakes any captured angle", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
      configurable: true,
      get: () => 900,
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      configurable: true,
      get: () => 1200,
    });
    HTMLMediaElement.prototype.play = async () => undefined;
    Object.defineProperty(CanvasRenderingContext2D.prototype, "drawImage", {
      configurable: true,
      value: (...args: unknown[]) => {
        (window as unknown as { __captureSourceWidth: number }).__captureSourceWidth = Number(args[3]);
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() },
    });
  });

  await page.goto("/studio/");
  await page.getByRole("button", { name: /Start room scan/i }).click();
  await page.getByRole("button", { name: /^Manual/ }).click();
  await expect(page.getByRole("button", { name: /^Manual/ })).toHaveAttribute("data-active", "true");

  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText(/^1\.2/)).toBeVisible();
  await expect(page.getByLabel("Rear camera preview")).toHaveCSS("transform", /matrix\(1\.2/);

  await page.getByRole("button", { name: "Begin eye-level capture" }).click();
  await page.getByRole("button", { name: "Capture target 1" }).click();
  await expect(page.getByText("1 / 24")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __captureSourceWidth: number }).__captureSourceWidth)).toBeCloseTo(750, 0);

  await page.getByRole("button", { name: "Capture target 2" }).click();
  await expect(page.getByText("2 / 24")).toBeVisible();
  await page.getByRole("button", { name: "Retake Eye level direction 1" }).click();
  await expect(page.getByRole("button", { name: "Retake direction 1" })).toBeVisible();
  await page.getByRole("button", { name: "Retake direction 1" }).click();

  await expect(page.getByText("2 / 24")).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture target 3" })).toBeVisible();
  await page.getByRole("button", { name: "Retake previous captured view" }).click();
  await expect(page.getByRole("button", { name: "Retake direction 2" })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
});

test("assembles the 24 guided stills into a locally generated room", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Full assembly is covered once to keep the mobile suite fast.");
  test.setTimeout(55_000);

  await page.addInitScript(() => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1200 });
    HTMLMediaElement.prototype.play = async () => undefined;
    CanvasRenderingContext2D.prototype.drawImage = () => undefined;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() },
    });
  });

  await page.goto("/studio/");
  await page.getByRole("textbox", { name: "Room name" }).fill("Test living room");
  await page.getByRole("button", { name: /Start room scan/i }).click();

  await beginGuidedBand(page, "Begin eye-level capture", 90);
  await completeGuidedBand(page, 90, 0);
  await beginGuidedBand(page, "Begin +35° capture", 55);
  await completeGuidedBand(page, 55, 8);
  await beginGuidedBand(page, "Begin −35° capture", 125);
  await completeGuidedBand(page, 125, 16);

  await page.getByRole("button", { name: /Build my 360/i }).click();
  await expect(page.getByRole("heading", { name: "Test living room" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Download 360 JPG/i })).toBeEnabled();
  await expect(page.getByText("Private · on device")).toBeVisible();
});
