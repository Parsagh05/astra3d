import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import {
  cameraRoll,
  captureViewLayout,
  deviceQuaternion,
  directionForView,
  projectDirection,
  viewQuaternion,
} from "@/components/room-capture/device-pose";
import { orientationToView } from "@/components/tour/tour-math";
import {
  advanceHeading,
  createHeadingTracker,
  guidanceHint,
  nearestTargetYaw,
} from "@/lib/guided-capture";

function lookDirection(quaternion: Quaternion) {
  return new Vector3(0, 0, -1).applyQuaternion(quaternion);
}

describe("heading tracker", () => {
  it("keeps one continuous clockwise heading through a full turn and beyond", () => {
    const tracker = createHeadingTracker();
    expect(advanceHeading(tracker, 170)).toBe(0);
    // Turning right past the ±180 seam keeps counting instead of jumping.
    for (let step = 1; step <= 40; step += 1) advanceHeading(tracker, ((170 + step * 10 + 180) % 360) - 180);
    expect(tracker.heading).toBeCloseTo(400);
    advanceHeading(tracker, 170 + 400 - 360 - 25);
    expect(tracker.heading).toBeCloseTo(375);
  });

  it("resolves each column to the nearest equivalent turn", () => {
    expect(nearestTargetYaw(0, 0)).toBe(0);
    expect(nearestTargetYaw(1, 4)).toBe(30);
    // After a full eye-level sweep the next band starts by continuing right.
    expect(nearestTargetYaw(0, 330)).toBe(360);
    expect(nearestTargetYaw(1, 350)).toBe(390);
    expect(nearestTargetYaw(11, 20)).toBe(-30);
  });

  it("names the correction the user should make", () => {
    expect(guidanceHint(25, 0, false)).toBe("turn-right");
    expect(guidanceHint(-25, 3, false)).toBe("turn-left");
    expect(guidanceHint(2, 45, false)).toBe("tilt-up");
    expect(guidanceHint(8, -30, false)).toBe("tilt-down");
    expect(guidanceHint(20, 30, true)).toBe("hold");
  });
});

describe("device pose", () => {
  it("points the camera exactly where orientationToView says", () => {
    for (const [alpha, beta, gamma] of [[0, 90, 0], [330, 90, 0], [45, 120, 20], [200, 70, -35]]) {
      const view = orientationToView(alpha, beta, gamma);
      const direction = lookDirection(deviceQuaternion(alpha, beta, gamma));
      const expected = directionForView(view.yaw, view.pitch);
      expect(direction.distanceTo(expected)).toBeLessThan(1e-6);
    }
  });

  it("measures sideways tilt from gravity, even at the upright gimbal lock", () => {
    expect(cameraRoll(deviceQuaternion(0, 90, 0))).toBeCloseTo(0, 5);
    expect(Math.abs(cameraRoll(deviceQuaternion(90, 75, -90)))).toBeCloseTo(15, 3);
    expect(Math.abs(cameraRoll(deviceQuaternion(60, 102, -90)))).toBeCloseTo(12, 3);
    // Heading and pitch alone never read as tilt.
    expect(cameraRoll(deviceQuaternion(210, 125, 0))).toBeCloseTo(0, 5);
  });

  it("rebases the heading so the sweep's start direction is yaw zero", () => {
    // alpha 330 means the phone turned 30° right of north.
    const pose = deviceQuaternion(330, 90, 0, 0, 30);
    expect(lookDirection(pose).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-6);
  });

  it("places a target to the right and above when the user must turn right and tilt up", () => {
    const layout = captureViewLayout(400, 700, false);
    const camera = viewQuaternion(0, 0);
    const point = projectDirection(directionForView(12, 10), camera, layout.focal, layout.width, layout.height);
    expect(point.onScreen).toBe(true);
    expect(point.x).toBeGreaterThan(200);
    expect(point.y).toBeLessThan(350);
  });

  it("pins off-screen and behind-the-back targets to the edge along their bearing", () => {
    const layout = captureViewLayout(400, 700, true);
    const camera = viewQuaternion(0, 0);
    const right = projectDirection(directionForView(100, 0), camera, layout.focal, 400, 700);
    expect(right.onScreen).toBe(false);
    expect(right.x).toBeCloseTo(400 - 28);
    expect(right.y).toBeCloseTo(350);
    const behindLeft = projectDirection(directionForView(-170, 0), camera, layout.focal, 400, 700);
    expect(behindLeft.x).toBeLessThan(200);
  });

  it("zooms out in sphere mode so the live window leaves room around it", () => {
    const sphere = captureViewLayout(390, 640, true);
    expect(sphere.windowHeight / 640).toBeLessThanOrEqual(0.721);
    expect(sphere.windowWidth / sphere.windowHeight).toBeCloseTo(0.75, 1);
    expect(sphere.fov).toBeGreaterThan(captureViewLayout(390, 640, false).fov);
  });
});
