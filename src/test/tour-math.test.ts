import { describe, expect, it } from "vitest";

import {
  MAX_PANORAMA_FOV,
  MAX_PANORAMA_PITCH,
  MIN_PANORAMA_FOV,
  clampFov,
  clampPanoramaView,
  clampPitch,
  orientationToView,
  projectHotspot,
  shortestAngleDelta,
  wrapDegrees,
} from "@/components/tour/tour-math";

describe("tour panorama math", () => {
  it("wraps yaw and clamps pitch and field of view to safe limits", () => {
    expect(wrapDegrees(180)).toBe(-180);
    expect(wrapDegrees(-181)).toBe(179);
    expect(shortestAngleDelta(170, -170)).toBe(20);
    expect(shortestAngleDelta(-170, 170)).toBe(-20);

    expect(clampPitch(120)).toBe(MAX_PANORAMA_PITCH);
    expect(clampPitch(-120)).toBe(-MAX_PANORAMA_PITCH);
    expect(clampFov(10)).toBe(MIN_PANORAMA_FOV);
    expect(clampFov(120)).toBe(MAX_PANORAMA_FOV);
    expect(
      clampPanoramaView({
        yaw: 541,
        pitch: 120,
        fieldOfView: 10,
      }),
    ).toEqual({
      yaw: -179,
      pitch: MAX_PANORAMA_PITCH,
      fov: MIN_PANORAMA_FOV,
    });
  });

  it("accepts the renderer fov shape and preserves in-range values", () => {
    expect(
      clampPanoramaView({ yaw: -42, pitch: 18, fov: 62 }),
    ).toEqual({ yaw: -42, pitch: 18, fov: 62 });
  });

  it("projects the current look direction to the viewport center", () => {
    const center = projectHotspot(
      { yaw: 0, pitch: 0 },
      { yaw: 0, pitch: 0, fov: 90 },
      800,
      400,
    );

    expect(center.visible).toBe(true);
    expect(center.depth).toBeCloseTo(1);
    expect(center.x).toBeCloseTo(400);
    expect(center.y).toBeCloseTo(200);

    const turnedCenter = projectHotspot(
      { yaw: 35, pitch: 18 },
      { yaw: 35, pitch: 18, fov: 70 },
      1024,
      640,
    );

    expect(turnedCenter.visible).toBe(true);
    expect(turnedCenter.x).toBeCloseTo(512);
    expect(turnedCenter.y).toBeCloseTo(320);
  });

  it("projects points laterally with perspective and rejects offscreen points", () => {
    const right = projectHotspot(
      { yaw: 30, pitch: 0 },
      { yaw: 0, pitch: 0, fov: 90 },
      800,
      400,
    );

    expect(right.visible).toBe(true);
    expect(right.x).toBeCloseTo(515.47, 1);
    expect(right.y).toBeCloseTo(200);

    const outside = projectHotspot(
      { yaw: 80, pitch: 0 },
      { yaw: 0, pitch: 0, fov: 90 },
      800,
      400,
    );

    expect(outside.depth).toBeGreaterThan(0);
    expect(outside.visible).toBe(false);
    expect(outside.x).toBeGreaterThan(800);
  });

  it("marks points behind the camera and invalid viewports as hidden", () => {
    expect(
      projectHotspot(
        { yaw: 180, pitch: 0 },
        { yaw: 0, pitch: 0, fov: 75 },
        800,
        400,
      ),
    ).toMatchObject({ x: 400, y: 200, visible: false });

    expect(
      projectHotspot(
        { yaw: 0, pitch: 0 },
        { yaw: 0, pitch: 0, fov: 75 },
        0,
        400,
      ),
    ).toEqual({ x: 0, y: 0, depth: -1, visible: false });
  });

  it("converts device orientation into the rear camera look direction", () => {
    // Phone flat on a table, screen up: the rear camera faces the floor.
    const flat = orientationToView(0, 0, 0);
    expect(flat.pitch).toBeCloseTo(-90);

    // Phone upright in portrait: level view straight ahead.
    const upright = orientationToView(0, 90, 0);
    expect(upright.yaw).toBeCloseTo(0);
    expect(upright.pitch).toBeCloseTo(0);

    // Turning the phone 90° to the right decreases alpha, so yaw turns right.
    const turnedRight = orientationToView(270, 90, 0);
    expect(turnedRight.yaw).toBeCloseTo(90);
    expect(turnedRight.pitch).toBeCloseTo(0);

    // Tilting the top edge back by 35° looks up by 35°.
    const tiltedUp = orientationToView(0, 125, 0);
    expect(tiltedUp.yaw).toBeCloseTo(0);
    expect(tiltedUp.pitch).toBeCloseTo(35);

    // Rolling about the vertical axis while upright turns the camera left.
    const rolledLeft = orientationToView(0, 90, 10);
    expect(rolledLeft.yaw).toBeCloseTo(-10);
    expect(rolledLeft.pitch).toBeCloseTo(0);
  });
});
