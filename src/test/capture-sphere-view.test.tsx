import { act, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { expect, it, vi } from "vitest";

import { CaptureSphereView } from "@/components/room-capture/capture-sphere-view";
import { viewQuaternion } from "@/components/room-capture/device-pose";
import { createCaptureEngineState, type CaptureEngineState } from "@/components/room-capture/use-guided-capture";

it("paints the target dot, arrow and hold ring from sensor data without rerendering the page", () => {
  let nextFrame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame = callback;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 400, height: 700, top: 0, left: 0, right: 400, bottom: 700, x: 0, y: 0, toJSON: () => ({}),
  });

  const engineRef = { current: createCaptureEngineState() } as RefObject<CaptureEngineState>;
  let pageRenders = 0;
  function Page() {
    pageRenders += 1;
    return (
      <CaptureSphereView
        videoRef={createRef<HTMLVideoElement>()}
        videoLabel="Rear camera preview"
        engineRef={engineRef}
        sphere={false}
        guiding
        reticle
        shots={[]}
        targetLabel="Target 2 of 12"
      />
    );
  }
  const { container } = render(<Page />);
  expect(screen.getByText("Target 2 of 12")).toBeInTheDocument();
  expect(screen.getByLabelText("Rear camera preview")).toBeInTheDocument();
  const dot = container.querySelector('[class*="guideDot"]') as HTMLElement;
  const arrow = container.querySelector('[class*="guideArrow"]') as HTMLElement;
  const ring = container.querySelector('[class*="reticle"]') as HTMLElement;
  expect(dot.dataset.visible).toBe("false");

  // Facing the start, target 2 sits 30° to the right.
  Object.assign(engineRef.current, {
    pose: viewQuaternion(0, 0),
    target: { yaw: 30, pitch: 0 },
    aligned: false,
    holdProgress: 0,
    yawError: 30,
    pitchError: 0,
    hint: "turn-right",
  });
  act(() => nextFrame!(16));
  expect(dot.dataset.visible).toBe("true");
  expect(dot.style.transform).toMatch(/translate3d\((\d+)/);
  expect(Number(/translate3d\(([\d.]+)px/.exec(dot.style.transform)?.[1])).toBeGreaterThan(200);
  expect(arrow.dataset.visible).toBe("true");
  expect(screen.getByText("Turn right toward the dot")).toBeInTheDocument();

  // On target and holding: the arrow goes away and the ring fills.
  Object.assign(engineRef.current, { pose: viewQuaternion(30, 0), aligned: true, holdProgress: 0.5, hint: "hold" });
  act(() => nextFrame!(32));
  expect(arrow.dataset.visible).toBe("false");
  expect(ring.dataset.aligned).toBe("true");
  expect(ring.style.getPropertyValue("--hold")).toBe("180deg");
  expect(screen.getByText("Hold still — capturing")).toBeInTheDocument();
  expect(pageRenders).toBe(1);
});
