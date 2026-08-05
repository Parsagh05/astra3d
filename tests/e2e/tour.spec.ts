import { expect, test, type Locator, type Page } from "@playwright/test";

const tourDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Astra Atelier" });

const tourViewport = (page: Page) =>
  tourDialog(page).locator("[data-view-yaw]");

const tourControls = (page: Page) =>
  tourDialog(page).getByRole("navigation", { name: "Tour controls" });

async function rememberTourTips(page: Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("astra3d-tour-tips", "seen");
    } catch {
      // Storage can be unavailable in hardened browser contexts.
    }
  });
}

async function launchTour(page: Page, dismissTips = true) {
  await page.goto("/");

  const trigger = page.getByRole("button", {
    name: "Enter live tour",
    exact: true,
  });
  await trigger.click();

  const dialog = tourDialog(page);
  await expect(dialog).toBeVisible();

  if (dismissTips) {
    const start = dialog.getByRole("button", { name: /Start exploring/ });
    if (await start.isVisible()) await start.click();
  }

  return { dialog, trigger, viewport: tourViewport(page) };
}

async function expectLivePanorama(viewport: ReturnType<typeof tourViewport>) {
  await expect(viewport).toHaveAttribute("data-fallback", "false", {
    timeout: 20_000,
  });
  await expect(viewport).toHaveAttribute("data-panorama-ready", "true", {
    timeout: 20_000,
  });
  await expect(viewport.locator("canvas")).toHaveCount(1);
}

async function numericAttribute(
  locator: ReturnType<typeof tourViewport>,
  name:
    | "data-view-yaw"
    | "data-view-pitch"
    | "data-view-fov"
    | "data-product-rotation"
    | "data-product-zoom",
) {
  const value = await locator.getAttribute(name);
  expect(value, `${name} should expose a numeric tour state`).not.toBeNull();
  return Number(value);
}

async function expectUnoccludedTouchTarget(
  locator: Locator,
  label: string,
) {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a rendered box`).not.toBeNull();
  if (!box) return;

  expect(box.width, `${label} should be at least 44px wide`).toBeGreaterThanOrEqual(
    44,
  );
  expect(
    box.height,
    `${label} should be at least 44px high`,
  ).toBeGreaterThanOrEqual(44);

  const ownsCenterPoint = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return topmost === element || (topmost ? element.contains(topmost) : false);
  });
  expect(ownsCenterPoint, `${label} should not be covered`).toBe(true);
}

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

test.describe("flagship immersive tour", () => {
  test("launches with managed focus, looks freely, zooms, navigates by map, and restores focus", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chrome", "Desktop interaction audit");

    await page.goto("/");
    const trigger = page.getByRole("button", {
      name: "Enter live tour",
      exact: true,
    });
    await trigger.focus();
    await trigger.click();

    const dialog = tourDialog(page);
    const start = dialog.getByRole("button", { name: /Start exploring/ });
    await expect(dialog).toBeVisible();
    await expect(start).toBeFocused();
    await expect(page.locator(".site-frame")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.locator("body")).toHaveAttribute("data-tour-open", "true");

    await page.keyboard.press("Tab");
    await expect(start).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(start).toBeFocused();

    await start.click();
    const viewport = tourViewport(page);
    await expect(viewport).toBeFocused();
    await expectLivePanorama(viewport);

    const initialYaw = await numericAttribute(viewport, "data-view-yaw");
    const initialPitch = await numericAttribute(viewport, "data-view-pitch");
    const initialFov = await numericAttribute(viewport, "data-view-fov");

    await viewport.press("ArrowRight");
    await expect
      .poll(() => numericAttribute(viewport, "data-view-yaw"))
      .toBeGreaterThan(initialYaw);
    await viewport.press("ArrowUp");
    await expect
      .poll(() => numericAttribute(viewport, "data-view-pitch"))
      .toBeGreaterThan(initialPitch);

    const bounds = await viewport.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const yawBeforeDrag = await numericAttribute(viewport, "data-view-yaw");
    await page.mouse.move(bounds.x + bounds.width * 0.42, bounds.y + 145);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.58,
      bounds.y + 95,
      { steps: 6 },
    );
    await page.mouse.up();
    await expect
      .poll(() => numericAttribute(viewport, "data-view-yaw"))
      .toBeGreaterThan(yawBeforeDrag);

    const fovBeforeWheel = await numericAttribute(viewport, "data-view-fov");
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + 125);
    await page.mouse.wheel(0, -240);
    await expect
      .poll(() => numericAttribute(viewport, "data-view-fov"))
      .toBeLessThan(fovBeforeWheel);

    await viewport.press("Home");
    await expect
      .poll(() => numericAttribute(viewport, "data-view-yaw"))
      .toBe(initialYaw);
    await expect
      .poll(() => numericAttribute(viewport, "data-view-fov"))
      .toBe(initialFov);

    await tourControls(page)
      .getByRole("button", { name: "Open floor plan", exact: true })
      .click();
    const mapPanel = dialog
      .getByRole("heading", { name: "Tour floor plan", exact: true })
      .locator("xpath=..");
    await expect(mapPanel).toBeVisible();
    await mapPanel
      .getByRole("button", { name: "Jump to Collection", exact: true })
      .click();
    await expect(dialog).toHaveAttribute("data-scene-id", "collection");
    await expect(
      dialog.getByText("Now exploring").locator("..").getByText("Collection"),
    ).toBeVisible();
    await expectLivePanorama(viewport);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeAttached();
    await expect(trigger).toBeFocused();
    await expect(page.locator(".site-frame")).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.locator("body")).not.toHaveAttribute(
      "data-tour-open",
      "true",
    );

    await trigger.click();
    const reopenedDialog = tourDialog(page);
    const reopenedViewport = tourViewport(page);
    await expect(reopenedDialog).toBeVisible();
    await expect(
      reopenedDialog.getByRole("button", { name: /Start exploring/ }),
    ).toHaveCount(0);
    await expect(reopenedViewport).toBeFocused();
  });

  test("opens story and 3D product hotspots, changes finishes, rotates, zooms, and uses the local demo bag", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chrome", "Desktop product audit");
    await rememberTourTips(page);

    const { dialog, viewport } = await launchTour(page);
    await expectLivePanorama(viewport);

    const roomRail = dialog.getByRole("complementary", {
      name: "Current room and interactive points",
    });
    await roomRail
      .getByRole("button", { name: /About the installation/ })
      .click();
    await expect(
      dialog.getByRole("heading", { name: "Material in motion" }),
    ).toBeVisible();
    await expect(dialog.getByText("Fictional concept")).toBeVisible();
    await dialog.getByRole("button", { name: "Close information" }).click();

    await tourControls(page)
      .getByRole("button", { name: "Open floor plan", exact: true })
      .click();
    const mapPanel = dialog
      .getByRole("heading", { name: "Tour floor plan", exact: true })
      .locator("xpath=..");
    await mapPanel
      .getByRole("button", { name: "Jump to Collection", exact: true })
      .click();

    const productPoint = roomRail.getByRole("button", {
      name: /Orbit mini bag/,
    });
    await productPoint.click();
    await expect(dialog).toHaveAttribute("data-active-product", "orbit-mini-bag");
    await expect(
      dialog.getByRole("heading", { name: "Orbit mini bag" }),
    ).toBeVisible();
    await expect(dialog.getByText("$680", { exact: true })).toBeVisible();

    const productStage = dialog.getByRole("group", {
      name: "Interactive 3D view of Orbit mini bag",
    });
    const productCanvas = productStage.locator("canvas");
    await expect(productCanvas).toHaveCount(1, { timeout: 15_000 });
    const initialRotation = await numericAttribute(
      productStage,
      "data-product-rotation",
    );
    const initialZoom = await numericAttribute(productStage, "data-product-zoom");
    await productStage.focus();
    await productStage.press("ArrowRight");
    await expect
      .poll(() => numericAttribute(productStage, "data-product-rotation"))
      .toBeGreaterThan(initialRotation);

    await productStage.press("+");
    await expect
      .poll(() => numericAttribute(productStage, "data-product-zoom"))
      .toBeGreaterThan(initialZoom);

    const mineralFinish = dialog.getByRole("radio", { name: /Mineral/ });
    await mineralFinish.check();
    await expect(mineralFinish).toBeChecked();
    await expect(dialog.getByText("Fine-grain plant-based leather")).toBeVisible();
    const productPanel = dialog
      .getByRole("heading", { name: "Orbit mini bag" })
      .locator("xpath=ancestor::section[1]");
    await expect(productPanel).toHaveAttribute("data-product-finish", "mineral");

    const addButton = dialog.getByRole("button", { name: "Add to demo bag" });
    await addButton.click();
    await expect(
      dialog.getByRole("button", { name: "Added to demo bag" }),
    ).toHaveAttribute("data-added", "true");
    await expect(productPanel).toHaveAttribute("data-product-added", "true");
    await expect(dialog.getByText(/No order, payment, or inventory request/)).toBeVisible();

    const shareTrigger = tourControls(page).getByRole("button", {
      name: "Share tour",
      exact: true,
    });
    await shareTrigger.click();
    const shareDialog = dialog.getByRole("dialog", { name: "Share tour" });
    const closeShare = shareDialog.getByRole("button", {
      name: "Close share",
    });
    const copyEmbed = shareDialog.getByRole("button", {
      name: "Copy embed code",
    });
    await expect(closeShare).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(copyEmbed).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeShare).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(shareDialog).not.toBeAttached();
    await expect(shareTrigger).toBeFocused();
    await expect(
      dialog.getByRole("heading", { name: "Orbit mini bag" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(
      dialog.getByRole("heading", { name: "Orbit mini bag" }),
    ).not.toBeAttached();
    await expect(
      dialog.locator('[data-hotspot-id="collection-bag"]:focus'),
    ).toHaveCount(1);
  });

  test("copies room links and iframe embed code and reopens a deep-linked hotspot", async ({
    context,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chrome", "Desktop sharing audit");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://127.0.0.1:4173",
    });
    await rememberTourTips(page);

    const { dialog } = await launchTour(page);
    await tourControls(page)
      .getByRole("button", { name: "Open floor plan", exact: true })
      .click();
    const mapPanel = dialog
      .getByRole("heading", { name: "Tour floor plan", exact: true })
      .locator("xpath=..");
    await mapPanel
      .getByRole("button", { name: "Jump to Private Lounge", exact: true })
      .click();

    await tourControls(page)
      .getByRole("button", { name: "Share tour", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Copy tour link" }).click();
    await expect(
      dialog.getByRole("button", { name: "Tour link copied" }),
    ).toBeVisible();

    const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
    const sharedUrl = new URL(copiedLink);
    expect(sharedUrl.searchParams.get("tour")).toBe("flagship");
    expect(sharedUrl.searchParams.get("room")).toBe("lounge");

    await dialog.getByRole("button", { name: "Copy embed code" }).click();
    await expect(
      dialog.getByRole("button", { name: "Embed code copied" }),
    ).toBeVisible();
    const embed = await page.evaluate(() => navigator.clipboard.readText());
    expect(embed).toContain(`<iframe src="${copiedLink}"`);
    expect(embed).toContain('allow="fullscreen"');
    expect(embed).not.toMatch(/(?:xr-spatial-tracking|webxr)/i);

    await page.goto(
      "/?tour=flagship&room=lounge&point=lounge-service",
    );
    const deepLinkedDialog = tourDialog(page);
    await expect(deepLinkedDialog).toHaveAttribute("data-scene-id", "lounge");
    await expect(
      deepLinkedDialog.getByRole("heading", {
        name: "Continue with a specialist",
      }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(
      deepLinkedDialog.getByRole("heading", {
        name: "Continue with a specialist",
      }),
    ).not.toBeAttached();
    await expect(deepLinkedDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(deepLinkedDialog).not.toBeAttached();
    await expect(page).not.toHaveURL(/(?:tour|room|point)=/);
  });

  test("supports touch swiping and the complete room/product flow without mobile overflow", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chrome", "Mobile-only tour audit");
    await rememberTourTips(page);

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const { dialog, viewport } = await launchTour(page);
    await expectLivePanorama(viewport);

    const dimensions = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);

    for (const controlName of [
      "Open floor plan",
      "Share tour",
      "Exit tour",
    ] as const) {
      const control = tourControls(page).getByRole("button", {
        name: controlName,
        exact: true,
      });
      const box = await control.boundingBox();
      expect(box, `${controlName} should be visible on mobile`).not.toBeNull();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    const bounds = await viewport.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const yawBeforeSwipe = await numericAttribute(viewport, "data-view-yaw");
    const session = await page.context().newCDPSession(page);
    const y = bounds.y + 115;
    const startX = bounds.x + bounds.width * 0.72;
    const endX = bounds.x + bounds.width * 0.28;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: startX, y, id: 1 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: (startX + endX) / 2, y: y - 25, id: 1 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: endX, y: y - 45, id: 1 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => numericAttribute(viewport, "data-view-yaw"))
      .not.toBe(yawBeforeSwipe);

    await tourControls(page)
      .getByRole("button", { name: "Open floor plan", exact: true })
      .click();
    const mapPanel = dialog
      .getByRole("heading", { name: "Tour floor plan", exact: true })
      .locator("xpath=..");
    await expect(mapPanel).toBeVisible();
    await mapPanel
      .getByRole("button", { name: "Jump to Private Lounge", exact: true })
      .click();
    await expect(dialog).toHaveAttribute("data-scene-id", "lounge");
    await expectLivePanorama(viewport);

    const roomRail = dialog.getByRole("complementary", {
      name: "Current room and interactive points",
    });
    await roomRail.getByRole("button", { name: /Orbit mini bag/ }).click();
    await expect(
      dialog.getByRole("heading", { name: "Orbit mini bag" }),
    ).toBeVisible();

    const productStage = dialog.getByRole("group", {
      name: "Interactive 3D view of Orbit mini bag",
    });
    const productPanel = dialog
      .getByRole("heading", { name: "Orbit mini bag" })
      .locator("xpath=ancestor::section[1]");
    await expect(productStage.locator("canvas")).toHaveCount(1, {
      timeout: 15_000,
    });
    const rotationBefore = await numericAttribute(
      productStage,
      "data-product-rotation",
    );
    const zoomBefore = await numericAttribute(productStage, "data-product-zoom");
    await productPanel.getByRole("button", { name: "Rotate right" }).click();
    await productPanel.getByRole("button", { name: "Zoom in" }).click();
    await expect
      .poll(() => numericAttribute(productStage, "data-product-rotation"))
      .toBeGreaterThan(rotationBefore);
    await expect
      .poll(() => numericAttribute(productStage, "data-product-zoom"))
      .toBeGreaterThan(zoomBefore);
    await productPanel.getByRole("radio", { name: /Oxide/ }).check();
    await expect(productPanel.getByRole("radio", { name: /Oxide/ })).toBeChecked();
    await productPanel.getByRole("button", { name: "Add to demo bag" }).click();
    await expect(
      dialog.getByRole("button", { name: "Added to demo bag" }),
    ).toBeVisible();

    const productDimensions = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(productDimensions.pageWidth).toBeLessThanOrEqual(
      productDimensions.viewportWidth + 1,
    );
    expect(errors).toEqual([]);
  });

  test("keeps 430px and 768px controls reachable, unoccluded, and room-aware", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chrome", "Responsive layout audit");
    await rememberTourTips(page);

    for (const size of [
      { width: 430, height: 844 },
      { width: 768, height: 900 },
    ]) {
      await page.setViewportSize(size);
      const { dialog, viewport } = await launchTour(page);
      await expectLivePanorama(viewport);

      const currentRoom = dialog
        .locator("span")
        .filter({ hasText: /live/i })
        .filter({ hasText: "Arrival" });
      await expect(currentRoom).toBeVisible();

      const actionButtons = await tourControls(page).getByRole("button").all();
      for (const button of actionButtons) {
        if (!(await button.isVisible())) continue;
        await expectUnoccludedTouchTarget(
          button,
          `${size.width}px ${await button.getAttribute("aria-label")}`,
        );
      }

      const lookControls = dialog.getByRole("group", {
        name: "Look and zoom controls",
      });
      const lookButtons = await lookControls.getByRole("button").all();
      for (const button of lookButtons) {
        if (!(await button.isVisible())) continue;
        await expectUnoccludedTouchTarget(
          button,
          `${size.width}px ${await button.getAttribute("aria-label")}`,
        );
      }

      const roomRail = dialog.getByRole("complementary", {
        name: "Current room and interactive points",
      });
      const railBox = await roomRail.boundingBox();
      const lookBox = await lookControls.boundingBox();
      expect(railBox).not.toBeNull();
      expect(lookBox).not.toBeNull();
      if (railBox && lookBox) {
        expect(
          rectanglesOverlap(railBox, lookBox),
          `${size.width}px look controls should not overlap room controls`,
        ).toBe(false);
      }

      const headingBox = await dialog
        .getByRole("heading", { name: "Astra Atelier" })
        .boundingBox();
      const actionsBox = await tourControls(page).boundingBox();
      expect(headingBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      if (headingBox && actionsBox) {
        expect(
          rectanglesOverlap(headingBox, actionsBox),
          `${size.width}px tour title should not overlap header controls`,
        ).toBe(false);
      }

      await tourControls(page)
        .getByRole("button", { name: "Exit tour", exact: true })
        .click();
      await expect(dialog).not.toBeAttached();
    }
  });

  test("preserves every room and story point when WebGL is unavailable", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await rememberTourTips(page);
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

    const { dialog, viewport } = await launchTour(page);
    await expect(viewport).toHaveAttribute("data-fallback", "true", {
      timeout: 10_000,
    });
    await expect(viewport).toHaveAttribute(
      "aria-label",
      "Static room view: Arrival",
    );
    await expect(viewport.locator("canvas")).toHaveCount(0);
    await expect(
      dialog.getByRole("group", { name: "Look and zoom controls" }),
    ).toHaveCount(0);
    await expect(dialog.getByText("Static browsing mode")).toBeVisible();
    await expect(
      dialog.getByText(/every room and item remains accessible/i),
    ).toBeVisible();

    const roomRail = dialog.getByRole("complementary", {
      name: "Current room and interactive points",
    });
    await roomRail
      .getByRole("button", { name: /Enter Collection/ })
      .click();
    await expect(dialog).toHaveAttribute("data-scene-id", "collection");
    await expect(viewport).toHaveAttribute("data-fallback", "true");

    await roomRail.getByRole("button", { name: /Tailoring notes/ }).click();
    await expect(
      dialog.getByRole("heading", { name: "A study in proportion" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close information" }).click();
    await tourControls(page)
      .getByRole("button", { name: "Open floor plan", exact: true })
      .click();
    const mapPanel = dialog
      .getByRole("heading", { name: "Tour floor plan", exact: true })
      .locator("xpath=..");
    await expect(
      mapPanel.getByRole("button", { name: "Jump to Private Lounge" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close map" }).click();
    await roomRail.getByRole("button", { name: /Orbit mini bag/ }).click();

    const staticProduct = dialog.getByRole("img", {
      name: "Static product preview of Orbit mini bag",
    });
    await expect(staticProduct).toBeVisible();
    await expect(staticProduct).toHaveAccessibleDescription(
      "3D rendering is unavailable. Finish choices and product details remain accessible.",
    );
    await expect(staticProduct.locator("canvas")).toHaveCount(0);
    await expect(
      dialog.getByRole("group", { name: "Product view controls" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Rotate left" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Rotate right" }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
