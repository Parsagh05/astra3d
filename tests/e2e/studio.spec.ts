import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";

import { CAPTURE_COLUMNS, TOTAL_CAPTURE_SLOTS } from "@/lib/capture-plan";

async function dispatchOrientation(page: Page, alpha: number, beta: number, gamma = 0) {
  await page.evaluate(({ heading, tilt, roll }) => {
    const event = new Event("deviceorientation");
    Object.defineProperties(event, {
      alpha: { value: heading },
      beta: { value: tilt },
      gamma: { value: roll },
    });
    window.dispatchEvent(event);
  }, { heading: alpha, tilt: beta, roll: gamma });
}

async function beginGuidedBand(page: Page, buttonName: string, beta: number) {
  await page.getByRole("button", { name: buttonName }).click();
  await page.waitForTimeout(2_150);
  await dispatchOrientation(page, 0, beta);
  await expect(page.getByText(`Target 1 of ${CAPTURE_COLUMNS}`)).toBeVisible({ timeout: 3_500 });
}

async function holdTarget(page: Page, alpha: number, beta: number) {
  for (let sample = 0; sample < 9; sample += 1) {
    await dispatchOrientation(page, alpha, beta);
    await page.waitForTimeout(90);
  }
}

async function completeGuidedBand(page: Page, beta: number, startingTotal: number, total = TOTAL_CAPTURE_SLOTS) {
  for (let index = 0; index < CAPTURE_COLUMNS; index += 1) {
    await holdTarget(page, index * (360 / CAPTURE_COLUMNS), beta);
    // The per-band counter renders "N / 12 views", so match the room progress exactly.
    await expect(
      page.getByText(`${startingTotal + index + 1} / ${total}`, { exact: true }),
    ).toBeVisible();
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

test("opens the same laptop project library from phone and desktop", async ({ page }) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const panorama = await sharp({
    create: { width: 64, height: 32, channels: 3, background: { r: 22, g: 88, b: 122 } },
  }).jpeg().toBuffer();
  await page.route("**/api/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        projects: [{
          id: projectId,
          name: "Common living room",
          createdAt: "2026-08-15T00:00:00.000Z",
          photoCount: TOTAL_CAPTURE_SLOTS,
          hasSourceFrames: true,
          processor: "laptop",
        }],
      }),
    });
  });
  await page.route(`**/api/projects/${projectId}/panorama`, async (route) => {
    await route.fulfill({ status: 200, contentType: "image/jpeg", body: panorama });
  });

  await page.goto("/studio/");
  await expect(page.getByRole("heading", { name: "Phone and laptop projects" })).toBeVisible();
  await expect(page.getByText(`${TOTAL_CAPTURE_SLOTS} source photos saved`)).toBeVisible();
  await page.getByRole("button", { name: /Common living room/ }).click();
  await expect(page.getByRole("heading", { name: "Common living room" })).toBeVisible();
  await expect(page.getByText(`Shared on laptop · ${TOTAL_CAPTURE_SLOTS} source photos saved`)).toBeVisible();
});

test("offers a secure guided phone capture route without horizontal overflow", async ({ page }) => {
  await page.goto("/studio/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Scan once. Look around forever.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Private shared laptop projects")).toBeVisible();

  const captureAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    captureAccessibility.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByText("Secure live camera required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Secure connection required" })).toBeDisabled();
  await expect(page.getByText(`0 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();

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

  expect(dialGeometry.nodeCount).toBe(CAPTURE_COLUMNS);
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

test("keeps a generated room interactive when WebGL is unavailable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Canvas fallback behavior is shared across viewport sizes.");

  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ) {
      if (contextId === "webgl" || contextId === "webgl2") return null;
      return originalGetContext.call(this, contextId, options);
    } as typeof originalGetContext;
  });

  await page.goto("/");
  await page.evaluate(async (photoCount) => {
    const panorama = await fetch("/images/tours/flagship/arrival-2048.webp").then((response) => response.blob());
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("astra3d-room-studio", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("rooms")) {
          request.result.createObjectStore("rooms", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("rooms", "readwrite");
      transaction.objectStore("rooms").put({
        id: "latest-room",
        name: "Compatibility room",
        createdAt: new Date().toISOString(),
        photoCount,
        panorama,
        processor: "laptop",
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, TOTAL_CAPTURE_SLOTS);

  await page.goto("/studio/");
  await page.getByRole("button", { name: /Open saved room Compatibility room/ }).click();
  await expect(page.getByRole("heading", { name: "Compatibility room" })).toBeVisible();
  await expect(page.getByText("Compatible 360°", { exact: true })).toBeVisible();
  await expect(page.getByText(/WebGL is unavailable in this browser session/)).toBeVisible();
  const viewport = page.getByRole("application", { name: /Interactive 360 degree view/ });
  const fallbackCanvas = viewport.getByRole("img", { name: /Flat panorama preview/ });
  await expect(fallbackCanvas).toBeVisible();
  await expect(viewport.locator('[data-panorama-ready="true"]')).toBeVisible();

  const beforeDrag = await fallbackCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const bounds = await viewport.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.25, bounds!.y + bounds!.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => fallbackCanvas.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(beforeDrag);
});

test("captures live still targets and requires all three tilt bands", async ({ page }) => {
  test.setTimeout(90_000);
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
  await page.getByRole("button", { name: /^Full/ }).click();
  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByRole("button", { name: "Begin eye-level capture" })).toBeVisible();

  await beginGuidedBand(page, "Begin eye-level capture", 90);
  await completeGuidedBand(page, 90, 0);
  await expect(page.getByRole("button", { name: "Begin +35° capture" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Build my 360/i })).toHaveCount(0);

  await beginGuidedBand(page, "Begin +35° capture", 125);
  await completeGuidedBand(page, 125, CAPTURE_COLUMNS);
  await expect(page.getByRole("button", { name: "Begin −35° capture" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Build my 360/i })).toHaveCount(0);

  await beginGuidedBand(page, "Begin −35° capture", 55);
  await completeGuidedBand(page, 55, CAPTURE_COLUMNS * 2);
  await expect(page.getByRole("button", { name: /Build my 360/i })).toBeVisible();
  await expect(page.getByText("All three room sweeps are captured.")).toBeVisible();
});

test("automatically captures with hand tremor but waits during a moving sweep", async ({ page }) => {
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
  await page.getByRole("button", { name: /Start room scan/i }).click();
  await expect(page.getByRole("button", { name: "Begin eye-level capture" })).toBeVisible();
  await beginGuidedBand(page, "Begin eye-level capture", 90);

  await page.evaluate(async () => {
    for (let sample = 0; sample < 35; sample++) {
      window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", {
        alpha: sample * 0.6, beta: 90, gamma: 0,
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  await expect(page.getByText(`0 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();

  // Near upright, alpha and gamma can swing in opposite directions even when
  // the rear lens barely moves. Add real small hand tremors on top of that.
  await page.evaluate(async () => {
    for (let sample = 0; sample < 55; sample++) {
      const swing = 30 * Math.sin(sample * 0.4);
      const tremor = 1.2 * Math.sin(sample * 0.8);
      window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", {
        alpha: (swing + tremor + 360) % 360, beta: 90, gamma: -swing,
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  await expect(page.getByText(`1 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
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
        if (args[0] instanceof HTMLVideoElement) (window as unknown as { __captureSourceWidth: number }).__captureSourceWidth = Number(args[3]);
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
  await expect(page.getByText(`1 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __captureSourceWidth: number }).__captureSourceWidth)).toBeCloseTo(750, 0);

  await page.getByRole("button", { name: "Capture target 2" }).click();
  await expect(page.getByText(`2 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retake Eye level direction 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retake direction 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retake direction 1", exact: true }).click();

  await expect(page.getByText(`2 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture target 3" })).toBeVisible();
  await page.getByRole("button", { name: "Retake previous captured view" }).click();
  await expect(page.getByRole("button", { name: "Retake direction 2", exact: true })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
});

test("uses real 0.6x hardware zoom and exposes an available ultrawide lens", async ({ page }) => {
  await page.addInitScript(() => {
    const cameraState = { deviceId: "main", appliedZoom: 1 };
    const videoTrack = {
      getCapabilities: () => ({ zoom: { min: 0.6, max: 4, step: 0.1 } }),
      getSettings: () => ({ deviceId: cameraState.deviceId, zoom: 1 }),
      applyConstraints: async (constraints: MediaTrackConstraints) => {
        const requested = constraints.advanced?.[0] as { zoom?: number } | undefined;
        cameraState.appliedZoom = requested?.zoom ?? cameraState.appliedZoom;
        (window as unknown as { __appliedHardwareZoom: number }).__appliedHardwareZoom = cameraState.appliedZoom;
      },
    };
    Object.defineProperty(MediaStream.prototype, "getVideoTracks", {
      configurable: true,
      value: () => [videoTrack],
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1200 });
    HTMLMediaElement.prototype.play = async () => undefined;
    CanvasRenderingContext2D.prototype.drawImage = () => undefined;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          const video = constraints.video as MediaTrackConstraints;
          const requestedId = video.deviceId as { exact?: string } | undefined;
          cameraState.deviceId = requestedId?.exact ?? cameraState.deviceId;
          return new MediaStream();
        },
        enumerateDevices: async () => [
          { deviceId: "main", groupId: "rear", kind: "videoinput", label: "Back Main Camera", toJSON: () => ({}) },
          { deviceId: "ultra", groupId: "rear", kind: "videoinput", label: "Ultra Wide Camera", toJSON: () => ({}) },
          { deviceId: "front", groupId: "front", kind: "videoinput", label: "Front Camera", toJSON: () => ({}) },
        ],
      },
    });
  });

  await page.goto("/studio/");
  await page.getByRole("button", { name: /Start room scan/i }).click();

  const lensPicker = page.getByLabel("Camera lens");
  await expect(lensPicker).toBeVisible();
  await expect(lensPicker.locator("option")).toHaveCount(2);
  await expect(lensPicker.locator("option").first()).toHaveText("Back Main Camera");
  await expect(lensPicker.locator("option").last()).toContainText("Ultra");
  await lensPicker.selectOption("ultra");
  await expect(lensPicker).toHaveValue("ultra");

  for (let step = 0; step < 4; step += 1) {
    await page.getByRole("button", { name: "Zoom out" }).click();
  }
  await expect(page.locator('[aria-label="Capture zoom"] output')).toContainText("0.6");
  expect(await page.evaluate(() => (window as unknown as { __appliedHardwareZoom: number }).__appliedHardwareZoom)).toBe(0.6);
  await expect(page.getByLabel("Rear camera preview")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

  await page.getByRole("button", { name: /^Manual/ }).click();
  await page.getByRole("button", { name: "Begin eye-level capture" }).click();
  await page.getByRole("button", { name: "Capture target 1" }).click();
  await expect(lensPicker).toBeDisabled();
});

test("finishes a quick room after exactly 12 photos without extra exposures", async ({ page }) => {
  test.setTimeout(95_000);

  await page.addInitScript(() => {
    const created: string[] = [];
    const revoked: string[] = [];
    const createUrl = URL.createObjectURL.bind(URL);
    const revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = createUrl(blob); created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); revokeUrl(url); };
    Object.assign(window, { __captureUrls: { created, revoked } });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1200 });
    HTMLMediaElement.prototype.play = async () => undefined;
    CanvasRenderingContext2D.prototype.drawImage = () => undefined;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() },
    });
  });

  let uploadedFields: string[] = [];
  let uploadedMode: FormDataEntryValue | null = null;
  const mockedPanorama = await sharp({
    create: {
      width: 64,
      height: 32,
      channels: 3,
      background: { r: 30, g: 90, b: 130 },
    },
  }).jpeg().toBuffer();
  await page.route("**/api/panorama", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const form = await new Request("http://localhost/api/panorama", {
      method: "POST",
      headers: { "content-type": route.request().headers()["content-type"] },
      body: new Uint8Array(route.request().postDataBuffer()!),
    }).formData();
    uploadedFields = [...form.keys()];
    uploadedMode = form.get("capture-mode");
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: mockedPanorama,
      headers: {
        "X-Astra3D-Alignment": "0.875",
        "X-Astra3D-Coverage": "0.98",
        "X-Astra3D-Coverage-Scope": "eye-level ring",
        "X-Astra3D-Fallback-Pairs": "0",
        "X-Astra3D-Matched-Pairs": "12",
        "X-Astra3D-Method": "opencv-sift-spherical-v3",
        "X-Astra3D-Processor": "laptop-opencv",
        "X-Astra3D-Project-Id": "11111111-1111-4111-8111-111111111111",
        "X-Astra3D-Retakes": "",
        "X-Astra3D-Warnings": encodeURIComponent(JSON.stringify(["Quick scan: ceiling and floor are soft-filled, not photographed."])),
      },
    });
  });

  await page.goto("/studio/");
  await page.getByRole("textbox", { name: "Room name" }).fill("Test living room");
  await page.getByRole("button", { name: /Start room scan/i }).click();

  await beginGuidedBand(page, "Begin eye-level capture", 90);
  await completeGuidedBand(page, 90, 0, CAPTURE_COLUMNS);
  await expect(page.getByText("All 12 room photos are captured.")).toBeVisible();
  const thumbnailUrls = await page.evaluate(() => (window as unknown as { __captureUrls: { created: string[] } }).__captureUrls.created);
  expect(thumbnailUrls).toHaveLength(12);

  const processingResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/panorama") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Build my 360/i }).click();
  const response = await processingResponse;
  expect(response.status()).toBe(200);
  expect(uploadedMode).toBe("quick");
  expect(uploadedFields.filter((key) => key.startsWith("frame-"))).toHaveLength(12);
  expect(uploadedFields.some((key) => key.startsWith("bracket-"))).toBe(false);
  expect(response.headers()["x-astra3d-processor"]).toBe("laptop-opencv");
  await expect(page.getByRole("heading", { name: "Test living room" })).toBeVisible({ timeout: 30_000 });
  const revokedUrls = await page.evaluate(() => (window as unknown as { __captureUrls: { revoked: string[] } }).__captureUrls.revoked);
  expect(revokedUrls).toEqual(expect.arrayContaining(thumbnailUrls));
  await expect(page.locator('[data-panorama-ready="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Download 360 JPG/i })).toBeEnabled();
  await expect(page.getByText("Feature-aligned result")).toBeVisible();
  await expect(page.getByText("Eye-level coverage", { exact: true })).toBeVisible();
  await expect(page.getByText(`12 / ${CAPTURE_COLUMNS}`, { exact: true })).toBeVisible();
  await expect(page.getByText("88%")).toBeVisible();
  await expect(page.getByText("98%")).toBeVisible();
  await expect(page.getByText(`Shared on laptop · ${CAPTURE_COLUMNS} source photos saved`)).toBeVisible();
});
