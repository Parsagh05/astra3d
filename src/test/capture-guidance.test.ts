import { describe, expect, it } from "vitest";
import { updateCaptureGuidance, type CaptureGuidanceState } from "@/components/room-capture/capture-guidance";
import { orientationToView } from "@/components/tour/tour-math";
import { getSignedAngleDelta } from "@/lib/capture-plan";

describe("automatic capture guidance", () => {
  it.each([15, 30, 60, 100])("captures through small hand tremors at %i Hz", (hz) => {
    let state: CaptureGuidanceState | null = null;
    let capturedAt = Infinity;
    for (let time = 0; time <= 1000; time += 1000 / hz) {
      const wobble = Math.sin(time / 1000 * Math.PI * 12) * 1.2;
      const result = updateCaptureGuidance(state, { time, yaw: wobble, pitch: -wobble }, { yaw: 0, pitch: 0 });
      state = result.state;
      if (result.ready) { capturedAt = time; break; }
    }
    expect(capturedAt).toBeLessThan(900);
  });

  it("keeps the target locked while a hand tremor crosses the entry boundary", () => {
    let state: CaptureGuidanceState | null = null;
    let ready = false;
    for (let time = 0; time <= 1000; time += 20) {
      const result = updateCaptureGuidance(state, {
        time, yaw: 5.7 + 0.7 * Math.sin(time / 60), pitch: 0,
      }, { yaw: 0, pitch: 0 });
      state = result.state;
      expect(result.guidance.aligned).toBe(true);
      ready ||= result.ready;
    }
    expect(ready).toBe(true);
  });

  it.each([15, 60, 100])("does not capture during a continuous sweep at %i Hz", (hz) => {
    let state: CaptureGuidanceState | null = null;
    for (let time = 0; time <= 1200; time += 1000 / hz) {
      const result = updateCaptureGuidance(state, {
        time, yaw: -12 + time * 0.025, pitch: 0,
      }, { yaw: 0, pitch: 0 });
      state = result.state;
      expect(result.ready).toBe(false);
    }
  });

  it("drops a nearly complete hold immediately when the phone leaves the target", () => {
    let state: CaptureGuidanceState | null = null;
    for (let time = 0; time <= 460; time += 20) {
      state = updateCaptureGuidance(state, { time, yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }).state;
    }
    expect(state!.heldMs).toBeGreaterThan(300);
    const result = updateCaptureGuidance(state, { time: 480, yaw: 10, pitch: 0 }, { yaw: 0, pitch: 0 });
    expect(result.guidance.aligned).toBe(false);
    expect(result.guidance.holdProgress).toBe(0);
    expect(result.ready).toBe(false);
  });

  it("requires a fresh hold after sensor silence or a target change", () => {
    let state: CaptureGuidanceState | null = null;
    for (let time = 0; time <= 700; time += 20) {
      state = updateCaptureGuidance(state, { time, yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }).state;
    }
    expect(state!.heldMs).toBe(450);
    const resumed = updateCaptureGuidance(state, { time: 1500, yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 });
    expect(resumed.ready).toBe(false);
    expect(resumed.guidance.holdProgress).toBe(0);
    const next = updateCaptureGuidance(state, { time: 720, yaw: 30, pitch: 35 }, { yaw: 30, pitch: 35 });
    expect(next.ready).toBe(false);
    expect(next.guidance.holdProgress).toBe(0);
  });

  it("uses the rear-camera direction when upright Euler angles swing together", () => {
    const ahead = orientationToView(0, 90, 0);
    for (const alpha of [25, -40, 70]) {
      // At beta=90, alpha and gamma may counter-rotate without moving the lens.
      const pose = orientationToView(alpha, 90, -alpha);
      expect(getSignedAngleDelta(pose.yaw, ahead.yaw)).toBeCloseTo(0);
      expect(pose.pitch).toBeCloseTo(0);
    }
    const before = orientationToView(359, 90, 0);
    const after = orientationToView(1, 90, 0);
    expect(getSignedAngleDelta(after.yaw, before.yaw)).toBeCloseTo(-2);
    expect(orientationToView(0, 125, 0).pitch).toBeCloseTo(35);
    expect(orientationToView(0, 55, 0).pitch).toBeCloseTo(-35);
  });
});
