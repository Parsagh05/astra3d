import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import { LiveCaptureGuide, type LiveCaptureGuideHandle } from "@/components/room-capture/live-capture-guide";

it("coalesces sensor samples and paints only the overlay without rerendering its parent", () => {
  let nextFrame: FrameRequestCallback | undefined;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { nextFrame = callback; return 1; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const ref = createRef<LiveCaptureGuideHandle>();
  let parentRenders = 0;
  function Studio() {
    parentRenders++;
    return <LiveCaptureGuide ref={ref} direction={1} bandLabel="Eye level" tilt="0" />;
  }
  const { unmount } = render(<Studio />);
  act(() => {
    for (let sample = 0; sample < 100; sample++) ref.current!.update({ aligned: true, holdProgress: sample / 100, yawError: 1, pitchError: 1 });
  });
  expect(request).toHaveBeenCalledTimes(1);
  act(() => nextFrame!(100));
  expect(screen.getByText(/Target found/)).toBeInTheDocument();
  expect(parentRenders).toBe(1);
  act(() => ref.current!.update({ aligned: false, holdProgress: 0, yawError: 15, pitchError: 0 }));
  unmount();
  expect(cancel).toHaveBeenCalledWith(1);
});
