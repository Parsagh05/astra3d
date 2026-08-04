import { expect, test } from "@playwright/test";

test("industry tabs and spatial hotspots are keyboard operable", async ({
  page,
}) => {
  await page.goto("/");

  const retailTab = page.getByRole("tab", { name: "Retail" });
  const realEstateTab = page.getByRole("tab", { name: "Real Estate" });
  await expect(retailTab).toHaveAttribute("aria-selected", "true");

  await retailTab.focus();
  await page.keyboard.press("ArrowRight");

  await expect(realEstateTab).toBeFocused();
  await expect(realEstateTab).toHaveAttribute("aria-selected", "true");

  const experiencePanel = page.getByRole("tabpanel", { name: "Real Estate" });
  await expect(experiencePanel).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Walk the property from anywhere.",
    }),
  ).toBeVisible();

  const viewHotspot = experiencePanel.getByRole("button", {
    name: "2 View corridor — explore hotspot",
  });
  await viewHotspot.focus();
  await page.keyboard.press("Enter");

  await expect(viewHotspot).toHaveAttribute("aria-pressed", "true");
  await expect(
    experiencePanel.getByRole("heading", {
      name: "Frame the view that sells the room.",
    }),
  ).toBeVisible();
});

test("demo request validates locally, succeeds, and restores focus on Escape", async ({
  page,
}) => {
  await page.goto("/");

  const trigger = page
    .locator(".hero__actions")
    .getByRole("button", { name: "Book a demo" });
  await trigger.click();

  const dialog = page.getByRole("dialog");
  const fullName = dialog.getByRole("textbox", { name: "Full name" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", {
      name: "Tell us where you want to take people.",
    }),
  ).toBeVisible();
  await expect(fullName).toBeFocused();

  await dialog.getByRole("button", { name: "Prepare my brief" }).click();
  await expect(fullName).toBeFocused();
  await expect(dialog.getByText("Enter your full name.")).toBeVisible();
  await expect(dialog.getByText("Enter a valid work email.")).toBeVisible();
  await expect(
    dialog.getByText("Enter your company or studio name."),
  ).toBeVisible();
  await expect(
    dialog.getByText("Choose the experience you want to build."),
  ).toBeVisible();

  await fullName.fill("Avery Chen");
  await dialog.getByRole("textbox", { name: "Work email" }).fill("avery@example.com");
  await dialog.getByRole("textbox", { name: "Company or studio" }).fill("Northstar Studio");
  await dialog.getByRole("combobox", { name: "Industry" }).selectOption("Retail");
  await dialog
    .getByRole("textbox", { name: "What should the experience achieve? Optional" })
    .fill("Launch an interactive seasonal flagship.");
  await dialog.getByRole("button", { name: "Prepare my brief" }).click();

  await expect(
    dialog.getByRole("heading", {
      name: "Your next world has a starting point.",
    }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    "This front-end preview keeps your details in this browser and has not transmitted them.",
  );

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeAttached();
  await expect(trigger).toBeFocused();
});

test("mobile navigation supports touch and opens the demo flow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "Mobile-only interaction");

  await page.goto("/");

  const menuButton = page.locator('button[aria-controls="mobile-navigation"]');
  const menuBounds = await menuButton.boundingBox();
  expect(menuBounds?.width).toBeGreaterThanOrEqual(44);
  expect(menuBounds?.height).toBeGreaterThanOrEqual(44);

  await menuButton.tap();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await expect(menuButton).toHaveAccessibleName("Close navigation");

  const mobileNavigation = page.getByRole("navigation", {
    name: "Mobile navigation",
  });
  await expect(mobileNavigation).toBeVisible();
  await mobileNavigation.getByRole("link", { name: "Experiences" }).tap();
  await expect(page).toHaveURL(/#experiences$/);
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(menuButton).toHaveAccessibleName("Open navigation");

  await menuButton.tap();
  const demoButton = mobileNavigation.getByRole("button", { name: "Book a demo" });
  const demoBounds = await demoButton.boundingBox();
  expect(demoBounds?.height).toBeGreaterThanOrEqual(44);
  await demoButton.tap();

  await expect(
    page.getByRole("dialog", {
      name: "Tell us where you want to take people.",
    }),
  ).toBeVisible();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
});
