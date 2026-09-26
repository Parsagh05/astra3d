import { describe, expect, it } from "vitest";

import { sampleTour } from "@/components/scan/splat-viewer";
import {
  addCoverageSample,
  coverageFraction,
  coveredCells,
  createScanCoverage,
  FAST_TURN_DEG_PER_S,
  rowForPitch,
  SCAN_HEADINGS,
  scanHint,
  yawPitch,
  type ScanCoverage,
} from "@/lib/scan-coverage";

function forward(yawDeg: number, pitchDeg: number): [number, number, number] {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

/** Turns a full circle at `pitch`, sampling every 50 ms at `degPerSecond`. */
function sweep(start: ScanCoverage, pitch: number, degPerSecond: number, t0 = 0) {
  let coverage = start;
  let time = t0;
  for (let yaw = 0; yaw <= 360; yaw += degPerSecond * 0.05) {
    coverage = addCoverageSample(coverage, forward(yaw, pitch), time);
    time += 50;
  }
  return { coverage, time };
}

describe("scan coverage", () => {
  it("reads heading and pitch in the capture frame", () => {
    expect(yawPitch(forward(90, 0)).yaw).toBeCloseTo(90);
    expect(yawPitch(forward(-30, 40)).pitch).toBeCloseTo(40);
    expect(rowForPitch(-30)).toBe("low");
    expect(rowForPitch(5)).toBe("level");
    expect(rowForPitch(30)).toBe("high");
  });

  it("fills the eye-level row on a slow loop and then asks for the floor", () => {
    const { coverage, time } = sweep(createScanCoverage(), 0, 20);
    const cells = coveredCells(coverage);
    expect(cells[1].filter(Boolean)).toHaveLength(SCAN_HEADINGS);
    expect(cells[0].some(Boolean)).toBe(false);
    expect(coverageFraction(coverage)).toBeCloseTo(1 / 3);
    expect(scanHint(coverage, time).text).toMatch(/tilted down/);
  });

  it("guides through all three loops and ends with good coverage", () => {
    let state = sweep(createScanCoverage(), 0, 20);
    state = sweep(state.coverage, -35, 20, state.time);
    expect(scanHint(state.coverage, state.time).text).toMatch(/tilted up/);
    state = sweep(state.coverage, 35, 20, state.time);
    expect(coverageFraction(state.coverage)).toBe(1);
    expect(scanHint(state.coverage, state.time)).toMatchObject({ tone: "good" });
  });

  it("warns about fast turns and does not count blurred sweeps", () => {
    const { coverage } = sweep(createScanCoverage(), 0, 200);
    expect(coverage.turnRate).toBeGreaterThan(FAST_TURN_DEG_PER_S);
    expect(scanHint(coverage, 5000)).toMatchObject({ tone: "warn" });
    expect(coverageFraction(coverage)).toBe(0);
  });
});

describe("capture path tour", () => {
  const path = [
    { position: [0, 0, 0] as [number, number, number], forward: [0, 0, -1] as [number, number, number] },
    { position: [1, 0, 0] as [number, number, number], forward: [1, 0, 0] as [number, number, number] },
    { position: [1, 0, 1] as [number, number, number], forward: [1, 0, 0] as [number, number, number] },
  ];

  it("walks along the recorded poses and blends the gaze", () => {
    const halfway = sampleTour(path, 0.5);
    expect(halfway.position).toEqual([0.5, 0, 0]);
    expect(Math.hypot(...halfway.forward)).toBeCloseTo(1);
    expect(halfway.forward[0]).toBeCloseTo(Math.SQRT1_2);
    expect(sampleTour(path, 1.5).position).toEqual([1, 0, 0.5]);
  });

  it("turns back at the end instead of jumping to the start", () => {
    expect(sampleTour(path, 2).position).toEqual([1, 0, 1]);
    expect(sampleTour(path, 2.5).position).toEqual([1, 0, 0.5]);
    expect(sampleTour(path, 4).position).toEqual([0, 0, 0]);
  });

  it("handles degenerate paths", () => {
    expect(sampleTour([], 3).forward).toEqual([0, 0, -1]);
    expect(sampleTour([path[1]], 3).position).toEqual([1, 0, 0]);
  });
});
