import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { CAPTURE_COLUMNS } from "@/lib/capture-plan";

async function orient(page: Page, alpha: number, beta: number) {
  await page.evaluate(({ heading, tilt }) => {
    const event = new Event("deviceorientation");
    Object.defineProperties(event, { alpha: { value: heading }, beta: { value: tilt }, gamma: { value: 0 } });
    window.dispatchEvent(event);
  }, { heading: alpha, tilt: beta });
}

async function hold(page: Page, alpha: number, beta: number, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 60) {
    await orient(page, alpha, beta);
    await page.waitForTimeout(60);
  }
}

test.beforeEach(async ({ page }) => {
  // A real MediaStream from a canvas stands in for the phone's rear camera.
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 960;
    const context = canvas.getContext("2d")!;
    window.setInterval(() => {
      context.fillStyle = `hsl(${(Date.now() / 20) % 360} 55% 45%)`;
      context.fillRect(0, 0, 720, 960);
    }, 40);
    const stream = canvas.captureStream(24);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream, enumerateDevices: async () => [] },
    });
  });
});

test("captures a guided 12-photo test case and saves it for the Tests page", async ({ page }) => {
  test.setTimeout(90_000);
  let uploadedFrames = 0;
  await page.route("**/api/tests", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
    uploadedFrames = (body.match(/name="frame-\d+"/g) ?? []).length;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ testCase: { path: "12-images/e2e-room", name: "e2e room", imageCount: 12 } }),
    });
  });

  await page.goto("/test-maker");
  await expect(page.getByRole("heading", { name: "Create a test case" })).toBeVisible();
  const intro = await new AxeBuilder({ page }).analyze();
  expect(intro.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);

  await page.getByRole("textbox", { name: "Test case name" }).fill("e2e room");
  await page.getByRole("button", { name: /^Quick/ }).click();
  await page.getByRole("button", { name: /Start capture/ }).click();
  await page.getByRole("button", { name: "Begin eye-level capture" }).click();
  await hold(page, 0, 90, 3_300);
  // Facing target 1 through the countdown may already have taken photo 1.
  await expect(page.getByText(new RegExp(`^Target [12] of ${CAPTURE_COLUMNS}$`))).toBeVisible();

  for (let column = 0; column < CAPTURE_COLUMNS; column += 1) {
    await hold(page, (360 - column * 30) % 360, 90, 800);
    await expect(page.getByText(`${column + 1} / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: /Review/ }).click();
  await expect(page.getByRole("heading", { name: "12 photos ready" })).toBeVisible();
  await expect(page.getByText("Quick 12-photo test case with motion data.")).toBeVisible();
  await page.getByRole("button", { name: /Save to test-cases/ }).click();
  await expect(page.getByText("Saved to test-cases/12-images/e2e-room")).toBeVisible();
  expect(uploadedFrames).toBe(CAPTURE_COLUMNS);
});

test("never captures a target reached by turning the wrong way", async ({ page }) => {
  await page.goto("/test-maker");
  await page.getByRole("button", { name: /^Quick/ }).click();
  await page.getByRole("button", { name: /Start capture/ }).click();
  await page.getByRole("button", { name: "Begin eye-level capture" }).click();
  await hold(page, 0, 90, 3_300);
  await hold(page, 0, 90, 800);
  await expect(page.getByText(`1 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  // Turning left by one step lands on the mirror image of target 2.
  await hold(page, 30, 90, 1_200);
  await expect(page.getByText(`1 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  await expect(page.getByText("Turn right toward the dot")).toBeVisible();
});

test("re-runs a test case and shows its quality report", async ({ page }) => {
  const panorama = await sharp({
    create: { width: 128, height: 64, channels: 3, background: { r: 40, g: 90, b: 140 } },
  }).jpeg().toBuffer();
  await page.route("**/api/tests", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      testCases: [{ path: "12-images/hall", name: "hall", group: "12-images", extent: "quick", imageCount: 12, hasImu: true }],
      invalid: [{ path: "10/partial", imageCount: 10, reason: "Found 10 photos; a case needs 12 (quick) or 36 (full)." }],
    }),
  }));
  await page.route("**/api/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ projects: [] }),
  }));
  await page.route("**/api/tests/run", (route) => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    headers: {
      "X-Astra3D-Alignment": "0.95",
      "X-Astra3D-Coverage": "1",
      "X-Astra3D-Matched-Pairs": "12",
      "X-Astra3D-Fallback-Pairs": "0",
      "X-Astra3D-Method": "opencv-sift-spherical-v4",
      "X-Astra3D-Retakes": "",
      "X-Astra3D-Warnings": encodeURIComponent("[]"),
      "X-Astra3D-Width": "3072",
      "X-Astra3D-Height": "1536",
      "X-Astra3D-Duration-Ms": "4200",
    },
    body: panorama,
  }));

  await page.goto("/tests");
  await expect(page.getByRole("heading", { name: "Tests", exact: true })).toBeVisible();
  await expect(page.getByText("1 folder skipped")).toBeVisible();
  await page.getByRole("button", { name: "Run hall" }).click();
  await expect(page.getByText("Matched pairs")).toBeVisible();
  await expect(page.getByText("3072×1536")).toBeVisible();
  await expect(page.getByText("4.2 s", { exact: true })).toBeVisible();
  await expect(page.getByText("1 clean")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});
