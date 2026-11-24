import { describe, expect, it } from "vitest";

import { projectSphericalPoint } from "@/components/tour/tour-math";
import {
  arrivalYaw,
  linkAhead,
  MAX_TOUR_SPOTS,
  placeLink,
  removeLink,
  removeSpot,
  sanitizeTourInput,
  unprojectViewportPoint,
  unreachableSpots,
} from "@/lib/house-tour";
import type { HouseTourInput } from "@/types/house-tour";

const PROJECT_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PROJECT_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PROJECT_C = "16fd2706-8baf-433b-82eb-8c7fada847da";

function tour(): HouseTourInput {
  return {
    name: "Our house",
    startSpotId: "hall",
    spots: [
      { id: "hall", projectId: PROJECT_A, name: "Hall", startYaw: 0, links: [] },
      { id: "kitchen", projectId: PROJECT_B, name: "Kitchen", startYaw: 90, links: [] },
      { id: "garden", projectId: PROJECT_C, name: "Garden", startYaw: -45, links: [] },
    ],
  };
}

describe("house tour", () => {
  it("places, moves and removes arrows between spots", () => {
    let next = placeLink(tour(), "hall", "kitchen", { yaw: 30, pitch: -20 });
    const [arrow] = next.spots[0].links;
    expect(arrow).toMatchObject({ targetSpotId: "kitchen", yaw: 30, pitch: -20 });
    // Placing again moves the same arrow rather than adding a second one.
    next = placeLink(next, "hall", "kitchen", { yaw: 200, pitch: -90 });
    expect(next.spots[0].links).toEqual([{ id: arrow.id, targetSpotId: "kitchen", yaw: -160, pitch: -70 }]);
    // No arrow from a room to itself.
    expect(placeLink(next, "hall", "hall", { yaw: 0, pitch: 0 })).toBe(next);
    expect(removeLink(next, "hall", arrow.id).spots[0].links).toEqual([]);
  });

  it("keeps walking forward: arrives facing away from the arrow back", () => {
    let next = placeLink(tour(), "hall", "kitchen", { yaw: 30, pitch: -20 });
    // Without an arrow back, the kitchen's start view is used.
    expect(arrivalYaw(next, "hall", "kitchen")).toBe(90);
    next = placeLink(next, "kitchen", "hall", { yaw: -120, pitch: -20 });
    expect(arrivalYaw(next, "hall", "kitchen")).toBe(60);
  });

  it("finds the arrow ahead of the view for W / up arrow", () => {
    let next = placeLink(tour(), "hall", "kitchen", { yaw: 170, pitch: -20 });
    next = placeLink(next, "hall", "garden", { yaw: -100, pitch: -20 });
    const hall = next.spots[0];
    expect(linkAhead(hall, -170)?.targetSpotId).toBe("kitchen");
    expect(linkAhead(hall, -60)?.targetSpotId).toBe("garden");
    expect(linkAhead(hall, 60)).toBeNull();
  });

  it("lists rooms no arrow leads to, and removing a room removes arrows to it", () => {
    let next = placeLink(tour(), "hall", "kitchen", { yaw: 0, pitch: -20 });
    expect(unreachableSpots(next).map((spot) => spot.id)).toEqual(["garden"]);
    next = placeLink(next, "kitchen", "garden", { yaw: 0, pitch: -20 });
    expect(unreachableSpots(next)).toEqual([]);
    next = removeSpot(next, "kitchen");
    expect(next.spots.map((spot) => spot.id)).toEqual(["hall", "garden"]);
    expect(next.spots[0].links).toEqual([]);
    expect(removeSpot(next, "hall").startSpotId).toBe("garden");
  });

  it("clicking a pixel and projecting it back lands on the same pixel", () => {
    const view = { yaw: 40, pitch: -15, fov: 70 };
    for (const [x, y] of [[400, 300], [120, 80], [700, 520], [10, 590]]) {
      const point = unprojectViewportPoint(x, y, view, 800, 600);
      const back = projectSphericalPoint(point, view, 800, 600);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
    expect(unprojectViewportPoint(400, 300, view, 800, 600)).toMatchObject({ yaw: expect.closeTo(40, 6), pitch: expect.closeTo(-15, 6) });
  });

  it("cleans tours sent by the editor", () => {
    const dirty = {
      name: "  Our\u0000 house  ",
      startSpotId: "missing",
      extra: "dropped",
      spots: [
        {
          id: "hall",
          projectId: PROJECT_A.toUpperCase(),
          name: "",
          startYaw: 540,
          links: [
            { id: "a1", targetSpotId: "kitchen", yaw: 370, pitch: 50 },
            { id: "a1", targetSpotId: "kitchen", yaw: 10, pitch: 0 },
            { id: "a2", targetSpotId: "hall", yaw: 0, pitch: 0 },
            { id: "a3", targetSpotId: "nowhere", yaw: 0, pitch: 0 },
            "junk",
          ],
        },
        { id: "kitchen", projectId: PROJECT_B, name: "Kitchen", startYaw: "x", links: "x" },
      ],
    };
    const clean = sanitizeTourInput(dirty);
    expect(clean).toEqual({
      name: "Our house",
      startSpotId: "hall",
      spots: [
        { id: "hall", projectId: PROJECT_A, name: "Room 1", startYaw: -180, links: [{ id: "a1", targetSpotId: "kitchen", yaw: 10, pitch: 20 }] },
        { id: "kitchen", projectId: PROJECT_B, name: "Kitchen", startYaw: 0, links: [] },
      ],
    });

    expect(sanitizeTourInput(null)).toMatch(/missing/);
    expect(sanitizeTourInput({ spots: [] })).toMatch(/at least one room/);
    expect(sanitizeTourInput({ spots: [{ id: "a", projectId: "../../etc", name: "x" }] })).toMatch(/saved 360/);
    expect(sanitizeTourInput({ spots: [{ id: "a b", projectId: PROJECT_A }] })).toMatch(/invalid id/);
    const many = Array.from({ length: MAX_TOUR_SPOTS + 1 }, (_, index) => ({ id: `s${index}`, projectId: PROJECT_A }));
    expect(sanitizeTourInput({ spots: many })).toMatch(/up to/);
  });
});
