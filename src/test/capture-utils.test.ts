import { describe, expect, it } from "vitest";

import {
  buildCaptureLockConstraints,
  buildCaptureSlots,
  CAPTURE_COLUMNS,
  estimateSharpness,
  getSignedAngleDelta,
  getBandRow,
  getCaptureProgress,
  getPitchDirection,
  getRelativeCameraPitch,
  TOTAL_CAPTURE_SLOTS,
} from "@/components/room-capture/capture-utils";

describe("room capture plan", () => {
  it("builds three complete overlapping bands in guided order", () => {
    const slots = buildCaptureSlots();

    expect(slots).toHaveLength(24);
    expect(slots[0]).toMatchObject({ band: "middle", column: 0, yaw: 0 });
    expect(slots[CAPTURE_COLUMNS - 1]).toMatchObject({
      band: "middle",
      column: 7,
      yaw: 315,
    });
    expect(slots[CAPTURE_COLUMNS]).toMatchObject({
      band: "upper",
      column: 0,
      sequence: 8,
    });
    expect(slots.at(-1)).toMatchObject({
      band: "lower",
      column: 7,
      sequence: 23,
    });
    expect(new Set(slots.map((slot) => slot.id)).size).toBe(TOTAL_CAPTURE_SLOTS);
  });

  it("maps capture bands to equirectangular rows and reports progress", () => {
    expect(getBandRow("upper")).toBe(0);
    expect(getBandRow("middle")).toBe(1);
    expect(getBandRow("lower")).toBe(2);
    expect(getCaptureProgress(0)).toBe(0);
    expect(getCaptureProgress(12)).toBe(50);
    expect(getCaptureProgress(24)).toBe(100);
  });

  it("unwraps IMU headings across the compass boundary", () => {
    expect(getSignedAngleDelta(4, 358)).toBe(6);
    expect(getSignedAngleDelta(358, 4)).toBe(-6);
  });

  it("treats rear-camera tilt toward the ceiling as positive pitch", () => {
    expect(getRelativeCameraPitch(55, 90)).toBe(35);
    expect(getRelativeCameraPitch(90, 90)).toBe(0);
    expect(getRelativeCameraPitch(125, 90)).toBe(-35);
    expect(getPitchDirection(55, 90)).toBe(-1);
    expect(getPitchDirection(125, 90)).toBe(1);
    expect(getRelativeCameraPitch(125, 90, getPitchDirection(125, 90))).toBe(35);
  });

  it("scores detailed captures far above flat or smoothly blurred ones", () => {
    const width = 120;
    const height = 120;
    const makeImage = (value: (x: number, y: number) => number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const level = value(x, y);
          data[offset] = level;
          data[offset + 1] = level;
          data[offset + 2] = level;
          data[offset + 3] = 255;
        }
      }
      return data;
    };

    const flat = estimateSharpness(makeImage(() => 128), width, height, 2);
    const gradient = estimateSharpness(makeImage((x) => (x / width) * 255), width, height, 2);
    const checkers = estimateSharpness(
      makeImage((x, y) => ((Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 235 : 20)),
      width,
      height,
      2,
    );

    expect(flat).toBe(0);
    expect(gradient).toBeLessThan(5);
    expect(checkers).toBeGreaterThan(500);
  });

  it("locks only the exposure, color, and focus controls the camera offers", () => {
    expect(buildCaptureLockConstraints(undefined, undefined)).toBeNull();
    expect(buildCaptureLockConstraints({} as MediaTrackCapabilities, {})).toBeNull();

    const full = buildCaptureLockConstraints(
      {
        exposureMode: ["continuous", "manual"],
        whiteBalanceMode: ["continuous", "manual"],
        focusMode: ["continuous", "manual"],
      } as MediaTrackCapabilities,
      { exposureTime: 320, iso: 100, colorTemperature: 4200, focusDistance: 1.8 },
    );
    expect(full).toEqual({
      exposureMode: "manual",
      exposureTime: 320,
      iso: 100,
      whiteBalanceMode: "manual",
      colorTemperature: 4200,
      focusMode: "manual",
      focusDistance: 1.8,
    });

    const exposureOnly = buildCaptureLockConstraints(
      { exposureMode: ["continuous", "manual"] } as MediaTrackCapabilities,
      {},
    );
    expect(exposureOnly).toEqual({ exposureMode: "manual" });
  });
});
