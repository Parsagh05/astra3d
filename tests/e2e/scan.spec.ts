import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SCAN_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const baseScan = {
  id: SCAN_ID,
  name: "Living room",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:05:00.000Z",
  error: null,
  video: { bytes: 48_000_000, mimeType: "video/mp4" },
};

const doneScan = {
  ...baseScan,
  status: "done",
  stage: "done",
  progress: 1,
  message: "Preview ready. Add a GPU worker for the photoreal scene.",
  result: { kind: "preview", gaussians: 2400, frames: 120, placed: 118, sceneBytes: 76_800 },
};

/** A small box room in the .splat format: 32 bytes per splat (xyz, scale, rgba, quaternion). */
function boxRoomSplat() {
  const splats: number[][] = [];
  for (let a = -2; a <= 2; a += 0.2) {
    for (let h = 0; h <= 2.4; h += 0.2) {
      splats.push([a, h - 1.2, -2.5, 220, 120, 60], [a, h - 1.2, 2.5, 60, 140, 220], [-2.5, h - 1.2, a, 90, 200, 120], [2.5, h - 1.2, a, 230, 210, 90]);
    }
  }
  const buffer = Buffer.alloc(splats.length * 32);
  splats.forEach(([x, y, z, r, g, b], index) => {
    const offset = index * 32;
    buffer.writeFloatLE(x, offset);
    buffer.writeFloatLE(y, offset + 4);
    buffer.writeFloatLE(z, offset + 8);
    for (let axis = 0; axis < 3; axis += 1) buffer.writeFloatLE(0.09, offset + 12 + axis * 4);
    buffer.set([r, g, b, 240, 255, 128, 128, 128], offset + 24);
  });
  return buffer;
}

const scene = {
  version: 1,
  kind: "preview",
  gaussians: 2400,
  frames: { used: 120, placed: 118 },
  up: [0, 1, 0],
  bounds: { min: [-2.5, -1.2, -2.5], max: [2.5, 1.2, 2.5] },
  path: Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return {
      position: [Math.sin(angle) * 0.8, 0, -Math.cos(angle) * 0.8],
      forward: [Math.sin(angle + 0.3), 0, -Math.cos(angle + 0.3)],
    };
  }),
};

async function mockScanFiles(page: Page) {
  const splat = boxRoomSplat();
  await page.route(`**/api/scans/${SCAN_ID}/files/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/scene.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(scene) });
    if (url.pathname.endsWith("/scene.splat")) return route.fulfill({ contentType: "application/octet-stream", body: splat });
    return route.fulfill({ status: 404, body: "" });
  });
}

test("uploads a walk-through video and follows the scan until it is ready", async ({ page }) => {
  let uploaded: { type?: string; name?: string | null; bytes: number } | null = null;
  let scans: unknown[] = [];
  await page.route(/\/api\/scans(\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      uploaded = {
        type: request.headers()["content-type"],
        name: new URL(request.url()).searchParams.get("name"),
        bytes: request.postDataBuffer()?.length ?? 0,
      };
      scans = [{ ...baseScan, status: "running", stage: "poses", progress: 0.2, message: "Solving camera positions… 40 frames placed" }];
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ scan: scans[0] }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ scans, worker: "local", maxBytes: 1_610_612_736 }) });
  });

  await page.goto("/scan");
  await expect(page.getByRole("heading", { name: "Scan a room in 3D" })).toBeVisible();
  await expect(page.getByText("No scans yet.")).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);

  await page.getByRole("textbox", { name: "Scan name" }).fill("Living room");
  await page.getByLabel("Choose a video of the room").setInputFiles({
    name: "walk.mov",
    mimeType: "video/quicktime",
    buffer: Buffer.alloc(300 * 1024, 1),
  });
  await expect(page.getByRole("link", { name: /Living room.*Solving camera positions/ })).toBeVisible();
  expect(uploaded).toEqual({ type: "video/quicktime", name: "Living room", bytes: 300 * 1024 });

  // The list polls while a scan is processing.
  scans = [doneScan];
  await expect(page.getByText(/Preview · 2,400 splats · 118\/120 frames/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Re-process Living room" })).toBeVisible();
});

test("shows processing progress, then the walkable 3D scene", async ({ page }) => {
  test.setTimeout(60_000);
  let scan: Record<string, unknown> = { ...baseScan, status: "running", stage: "training", progress: 0.5, message: "Building a preview…", worker: { host: "gpu-box", trainer: "preview" } };
  await page.route(`**/api/scans/${SCAN_ID}`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ scan }) }));
  await mockScanFiles(page);

  await page.goto(`/scan/${SCAN_ID}`);
  await expect(page.getByRole("heading", { name: "Building the 3D scene" })).toBeVisible();
  await expect(page.getByText("50% · preview on gpu-box")).toBeVisible();

  scan = doneScan;
  await expect(page.getByText("Preview.", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("application", { name: "3D scene of Living room" })).toBeVisible();
  // The walk button enables once Spark has decoded and uploaded the splats.
  const walk = page.getByRole("button", { name: "Walk the capture path" });
  await expect(walk).toBeEnabled({ timeout: 30_000 });
  await walk.click();
  await expect(page.getByRole("button", { name: "Stop walking" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(walk).toHaveAttribute("aria-pressed", "false");

  // The canvas shows the room, not an empty background.
  const canvas = page.getByRole("application", { name: "3D scene of Living room" });
  await page.waitForTimeout(500);
  const shot = await canvas.screenshot();
  const { default: sharp } = await import("sharp");
  const { channels } = await sharp(shot).stats();
  expect(Math.max(...channels.slice(0, 3).map((channel) => channel.mean))).toBeGreaterThan(25);
});

test("explains a failed scan and queues it again", async ({ page }) => {
  let scan: Record<string, unknown> = { ...baseScan, status: "failed", stage: "poses", progress: 0.2, message: "x", error: "Only 8 of 120 frames could be placed. Move more slowly." };
  await page.route(`**/api/scans/${SCAN_ID}`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ scan }) }));
  await page.route(`**/api/scans/${SCAN_ID}/retry`, (route) => {
    scan = { ...baseScan, status: "queued", stage: "queued", progress: 0, message: "Waiting for a worker…" };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ scan }) });
  });

  await page.goto(`/scan/${SCAN_ID}`);
  await expect(page.getByText("Only 8 of 120 frames could be placed. Move more slowly.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Waiting" })).toBeVisible();
});

test("films the room with coverage guidance and uploads the recording", async ({ page }) => {
  test.setTimeout(60_000);
  // A canvas stream stands in for the rear camera; MediaRecorder is real.
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d")!;
    window.setInterval(() => {
      context.fillStyle = `hsl(${(Date.now() / 20) % 360} 55% 45%)`;
      context.fillRect(0, 0, 640, 360);
    }, 40);
    const stream = canvas.captureStream(24);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream, enumerateDevices: async () => [] },
    });
  });
  let uploaded: { type?: string; bytes: number } | null = null;
  const queued = { ...baseScan, status: "queued", stage: "queued", progress: 0, message: "Waiting for a worker…" };
  await page.route(/\/api\/scans(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      uploaded = { type: route.request().headers()["content-type"], bytes: route.request().postDataBuffer()?.length ?? 0 };
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ scan: queued }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ scans: uploaded ? [queued] : [], worker: "external", maxBytes: 1_610_612_736 }) });
  });

  await page.goto("/scan");
  await page.getByRole("button", { name: "Film the room" }).click();
  await page.getByRole("button", { name: "Start recording" }).click();
  // Turn slowly through a full circle at eye level.
  for (let heading = 0; heading <= 360; heading += 6) {
    await page.evaluate((alpha) => {
      const event = new Event("deviceorientation");
      Object.defineProperties(event, { alpha: { value: alpha }, beta: { value: 90 }, gamma: { value: 0 } });
      window.dispatchEvent(event);
    }, (360 - heading) % 360);
    await page.waitForTimeout(170);
  }
  await expect(page.getByRole("img", { name: /3[0-9]% of the room filmed/ })).toBeVisible();
  await expect(page.getByText("Now walk another loop tilted down to film the floor and furniture")).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop recording" });
  await expect(stop).toBeEnabled({ timeout: 5_000 });
  await stop.click();
  await expect(page.getByRole("dialog", { name: "Film the room" })).toBeHidden();
  await expect(page.getByRole("link", { name: /Living room/ })).toBeVisible();
  expect(uploaded).not.toBeNull();
  expect(uploaded!.type).toMatch(/^video\/(webm|mp4)$/);
  expect(uploaded!.bytes).toBeGreaterThan(1000);
});
