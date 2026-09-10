import { expect, it, vi } from "vitest";
import { capturePreviewStill } from "@/components/room-capture/capture-utils";
import { createPanoramaUpload } from "@/components/room-capture/panorama-api";

it("encodes one bounded still and a small thumbnail without full-image pixel reads or base64", async () => {
  const drawImage = vi.fn();
  const pixelRead = vi.fn(() => { throw new Error("Expensive full image read"); });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, getImageData: pixelRead } as unknown as CanvasRenderingContext2D);
  const base64 = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => { throw new Error("Synchronous encoding"); });
  const dimensions: number[][] = [];
  const canvases: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, done) {
    dimensions.push([this.width, this.height]);
    canvases.push(this);
    queueMicrotask(() => done(new Blob(["jpeg"], { type: "image/jpeg" })));
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
  const video = document.createElement("video");
  Object.defineProperties(video, { videoWidth: { value: 3000 }, videoHeight: { value: 4000 } });
  const capture = await capturePreviewStill(video);
  expect(dimensions).toEqual([[1080, 1440], [160, 214]]);
  expect(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1)).toBe(true);
  expect(pixelRead).not.toHaveBeenCalled();
  expect(base64).not.toHaveBeenCalled();
  expect(capture.thumbnailUrl).toBe("blob:thumbnail");

  const upload = createPanoramaUpload([{
    id: "middle-0", band: "middle", column: 0, sequence: 0, yaw: 0,
    capturedAt: 0, zoom: 1, ...capture,
  }], "Quick room", "quick");
  expect(upload.get("capture-mode")).toBe("quick");
  expect(await (upload.get("frame-0") as File).text()).toBe("jpeg");
  expect([...upload.keys()].some((key) => key.startsWith("bracket-"))).toBe(false);
});
