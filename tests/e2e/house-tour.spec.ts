import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const TOUR_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const HALL = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KITCHEN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const projects = [
  { id: HALL, name: "Hall", createdAt: "2026-11-20T10:00:00.000Z", photoCount: 36, hasSourceFrames: true, processor: "laptop" },
  { id: KITCHEN, name: "Kitchen", createdAt: "2026-11-20T10:10:00.000Z", photoCount: 36, hasSourceFrames: true, processor: "laptop" },
];

function baseTour() {
  return {
    id: TOUR_ID,
    name: "Our house",
    createdAt: "2026-11-21T09:00:00.000Z",
    updatedAt: "2026-11-21T09:00:00.000Z",
    startSpotId: "hall",
    spots: [
      { id: "hall", projectId: HALL, name: "Hall", startYaw: 0, links: [{ id: "to-kitchen", targetSpotId: "kitchen", yaw: 10, pitch: -20 }] },
      { id: "kitchen", projectId: KITCHEN, name: "Kitchen", startYaw: 0, links: [] as Array<Record<string, unknown>> },
    ],
  };
}

/** A 2:1 panorama with coloured columns so each room looks different. */
async function panorama(hue: number) {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width: 1024, height: 512, channels: 3, background: { r: hue, g: 120, b: 255 - hue } } }).jpeg().toBuffer();
}

async function mockProjects(page: Page) {
  const images = { [HALL]: await panorama(40), [KITCHEN]: await panorama(220) };
  await page.route("**/api/projects", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects }) }));
  await page.route("**/api/projects/*/panorama", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const image = images[id as keyof typeof images];
    return image ? route.fulfill({ contentType: "image/jpeg", body: image }) : route.fulfill({ status: 404, body: "" });
  });
}

test("creates a house tour from studio rooms", async ({ page }) => {
  await mockProjects(page);
  let created: Record<string, unknown> | null = null;
  await page.route("**/api/tours", (route) => {
    if (route.request().method() === "POST") {
      created = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ tour: { ...baseTour(), ...created } }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ tours: [] }) });
  });
  await page.route(`**/api/tours/${TOUR_ID}`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ tour: baseTour() }) }));

  await page.goto("/tours");
  await expect(page.getByRole("heading", { name: "Walk through the house" })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);

  await page.getByRole("textbox", { name: "Tour name" }).fill("Our house");
  await page.getByRole("checkbox", { name: /Kitchen/ }).check();
  await page.getByRole("checkbox", { name: /Hall/ }).check();
  await page.getByRole("button", { name: "Create tour and place arrows" }).click();
  await expect(page).toHaveURL(new RegExp(`/tours/${TOUR_ID}\\?edit=1`));
  // Rooms keep the order they were ticked in.
  expect(created).toMatchObject({ name: "Our house", spots: [{ projectId: KITCHEN, name: "Kitchen" }, { projectId: HALL, name: "Hall" }] });
});

test("walks between rooms with the arrows, then places the arrow back", async ({ page }) => {
  await mockProjects(page);
  let tour = baseTour();
  let saved: ReturnType<typeof baseTour> | null = null;
  await page.route(`**/api/tours/${TOUR_ID}`, (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      tour = { ...tour, ...saved! };
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ tour }) });
  });

  await page.goto(`/tours/${TOUR_ID}`);
  const stage = page.getByRole("application", { name: /360° view of Hall/ });
  await expect(stage).toBeVisible();
  // The doorway arrow sits where it was placed; the compass ring has one too.
  await expect(page.getByRole("button", { name: "Go to Kitchen" })).toBeVisible();
  await page.getByRole("button", { name: "Walk to Kitchen" }).click();
  await expect(page.getByRole("application", { name: /360° view of Kitchen/ })).toBeVisible();
  await expect(page.getByText("No arrows in this room yet.")).toBeVisible();

  // Place the arrow back to the hall by clicking in the view.
  await page.getByRole("button", { name: "Edit arrows" }).click();
  await page.getByRole("combobox", { name: "Room the new arrow leads to" }).selectOption({ label: "Hall" });
  await page.getByRole("button", { name: "Place arrow" }).click();
  await expect(page.getByText(/Click where the way to/)).toBeVisible();
  const box = (await page.getByRole("application", { name: /360° view of Kitchen/ }).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.6);
  await expect(page.getByText("Arrow to Hall placed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove the arrow to Hall" })).toBeVisible();

  await page.getByRole("button", { name: "Save tour" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  expect(saved).not.toBeNull();
  const [back] = saved!.spots[1].links as Array<{ targetSpotId: string; yaw: number; pitch: number }>;
  expect(back.targetSpotId).toBe("hall");
  // Left of centre and below the horizon.
  expect(back.yaw).toBeLessThan(0);
  expect(back.pitch).toBeLessThan(0);

  // Keyboard: W walks to the room ahead (turn to face the new arrow first).
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("application", { name: /360° view of Kitchen/ }).focus();
  for (let turn = 0; turn < 36 && !(await page.getByRole("button", { name: "Go to Hall" }).isVisible()); turn += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.press("w");
  await expect(page.getByRole("application", { name: /360° view of Hall/ })).toBeVisible();
});
