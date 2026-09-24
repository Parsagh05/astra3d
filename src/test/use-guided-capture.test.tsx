import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOTION_UNAVAILABLE_NOTICE, useGuidedCapture } from "@/components/room-capture/use-guided-capture";
import { CAPTURE_COLUMNS } from "@/lib/capture-plan";

function tilt(alpha: number, beta: number, gamma = 0) {
  const event = new Event("deviceorientation");
  Object.defineProperties(event, {
    alpha: { value: alpha },
    beta: { value: beta },
    gamma: { value: gamma },
  });
  window.dispatchEvent(event);
}

/** Holds the phone still for `ms`, sampling at 50 Hz like a real sensor. */
function hold(alpha: number, beta: number, ms = 700) {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    act(() => {
      tilt(alpha, beta);
      vi.advanceTimersByTime(20);
    });
  }
}

const EYE_LEVEL_ONLY = [{ pitch: 0 }];
const THREE_BANDS = [{ pitch: 0 }, { pitch: 50 }, { pitch: -50 }];

describe("useGuidedCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function startScanning(bands: readonly { pitch: number }[], onAutoCapture = vi.fn()) {
    const hook = renderHook(() => useGuidedCapture({ bands, onAutoCapture }));
    act(() => tilt(0, 90));
    await act(async () => {
      await hook.result.current.startSweep(0);
    });
    expect(hook.result.current.status).toBe("countdown");
    // The sensor keeps reporting through the countdown.
    hold(0, 90, 3000);
    expect(hook.result.current.status).toBe("scanning");
    expect(hook.result.current.mode).toBe("automatic");
    return { hook, onAutoCapture };
  }

  it("captures the first target, then only accepts the next one to the right", async () => {
    const { hook, onAutoCapture } = await startScanning(EYE_LEVEL_ONLY);
    hold(0, 90);
    expect(onAutoCapture).toHaveBeenCalled();
    const pose = hook.result.current.capturePose();
    expect(pose.imu).toEqual({ alpha: 0, beta: 90, gamma: 0 });
    expect(pose.view).toHaveLength(4);

    act(() => hook.result.current.afterCapture(1, CAPTURE_COLUMNS));
    onAutoCapture.mockClear();
    // Turning left 30° reaches the mirror image of target 2: never capture it,
    // the stitcher assembles sweeps in clockwise order.
    hold(30, 90);
    expect(onAutoCapture).not.toHaveBeenCalled();
    expect(hook.result.current.engineRef.current.hint).toBe("turn-right");
    // Turning right 30° (alpha falls to 330) is the real target.
    hold(330, 90);
    expect(onAutoCapture).toHaveBeenCalled();
  });

  it("keeps the heading between bands so column 1 lines up above column 1", async () => {
    const { hook, onAutoCapture } = await startScanning(THREE_BANDS);
    for (let column = 0; column < CAPTURE_COLUMNS; column += 1) {
      onAutoCapture.mockClear();
      hold((360 - column * 30) % 360, 90);
      expect(onAutoCapture).toHaveBeenCalled();
      act(() => hook.result.current.afterCapture(column + 1, CAPTURE_COLUMNS * 3));
    }
    expect(hook.result.current.status).toBe("between");

    // The user drifts 70° left while reading the next instruction.
    hold(70, 90, 200);
    await act(async () => {
      await hook.result.current.startSweep(CAPTURE_COLUMNS);
    });
    hold(70, 90, 3000);
    expect(hook.result.current.status).toBe("scanning");

    onAutoCapture.mockClear();
    // Tilted up but still 70° off the original first direction: no photo.
    hold(70, 140);
    expect(onAutoCapture).not.toHaveBeenCalled();
    // 70° left of the start, so the first upper target is 70° to the right.
    expect(hook.result.current.engineRef.current.target).toEqual({ yaw: 360, pitch: 50 });
    // Back to the sweep's first heading, tilted up 50°: captured.
    hold(0, 140);
    expect(onAutoCapture).toHaveBeenCalled();
  });

  it("falls back to manual capture when the phone reports no motion", async () => {
    const onNotice = vi.fn();
    const hook = renderHook(() => useGuidedCapture({ bands: EYE_LEVEL_ONLY, onAutoCapture: vi.fn(), onNotice }));
    await act(async () => {
      await hook.result.current.startSweep(0);
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(hook.result.current.mode).toBe("manual");
    expect(hook.result.current.status).toBe("scanning");
    expect(onNotice).toHaveBeenCalledWith(MOTION_UNAVAILABLE_NOTICE);
    expect(hook.result.current.capturePose()).toEqual({});
  });

  it("finishes a band with 'between' and the plan with 'complete'", async () => {
    const { hook } = await startScanning(EYE_LEVEL_ONLY);
    act(() => hook.result.current.afterCapture(CAPTURE_COLUMNS, CAPTURE_COLUMNS));
    expect(hook.result.current.status).toBe("complete");
    act(() => hook.result.current.reset());
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.mode).toBe("automatic");
  });
});
