import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PanoramaFallbackCanvas } from "@/components/tour/panorama-fallback-canvas";

describe("PanoramaFallbackCanvas", () => {
  it("draws and redraws a wrapped 360 view without WebGL", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      fillRect: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 390,
      top: 0,
      width: 390,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    class TestImage {
      decoding = "auto";
      naturalHeight = 1024;
      naturalWidth = 2048;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      private source = "";

      get src() {
        return this.source;
      }

      set src(value: string) {
        this.source = value;
        if (value) queueMicrotask(() => this.onload?.());
      }
    }

    const imageDescriptor = Object.getOwnPropertyDescriptor(window, "Image");
    Object.defineProperty(window, "Image", {
      configurable: true,
      value: TestImage,
    });

    try {
      const onReady = vi.fn();
      const { rerender } = render(
        <PanoramaFallbackCanvas
          alt="Compatible room panorama"
          fov={72}
          onReady={onReady}
          pitch={0}
          src="blob:room"
          yaw={0}
        />,
      );

      await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
      expect(drawImage).toHaveBeenCalled();
      const initialDrawCount = drawImage.mock.calls.length;

      rerender(
        <PanoramaFallbackCanvas
          alt="Compatible room panorama"
          fov={62}
          onReady={onReady}
          pitch={12}
          src="blob:room"
          yaw={135}
        />,
      );

      await waitFor(() => expect(drawImage.mock.calls.length).toBeGreaterThan(initialDrawCount));
    } finally {
      if (imageDescriptor) Object.defineProperty(window, "Image", imageDescriptor);
    }
  });
});
