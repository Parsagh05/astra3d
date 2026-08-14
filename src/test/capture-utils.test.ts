import { describe, expect, it } from "vitest";

import {
  buildCaptureSlots,
  CAPTURE_COLUMNS,
  getBandRow,
  getCaptureProgress,
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
});
