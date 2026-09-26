import { expect, it, vi } from "vitest";
import { captureFullStill, capturePreviewStill } from "@/components/room-capture/capture-utils";
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
  expect(dimensions).toEqual([[1080, 1440], [240, 320]]);
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

function stubCanvas() {
  const drawn: unknown[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: (source: unknown) => drawn.push(source),
  } as unknown as CanvasRenderingContext2D);
  const dimensions: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, done) {
    dimensions.push([this.width, this.height]);
    queueMicrotask(() => done(new Blob(["jpeg"], { type: "image/jpeg" })));
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
  return { drawn, dimensions };
}

function previewVideo(width: number, height: number) {
  const video = document.createElement("video");
  Object.defineProperties(video, { videoWidth: { value: width }, videoHeight: { value: height } });
  return video;
}

it("uses the full camera sensor when the phone can take a real photo", async () => {
  const { drawn, dimensions } = stubCanvas();
  const bitmap = { width: 3024, height: 4032, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  vi.stubGlobal("ImageCapture", class { takePhoto = async () => new Blob(["photo"]); });
  const capture = await captureFullStill(previewVideo(960, 1280), {} as MediaStreamTrack);
  expect(drawn[0]).toBe(bitmap);
  // Bounded at 2400 px tall, 2.5x the pixels of a preview grab.
  expect(dimensions[0]).toEqual([1800, 2400]);
  expect(bitmap.close).toHaveBeenCalled();
  expect(capture.thumbnailUrl).toBe("blob:thumbnail");
  vi.unstubAllGlobals();
});

it("falls back to the preview when the photo is rotated, smaller, or unavailable", async () => {
  const { drawn, dimensions } = stubCanvas();
  const video = previewVideo(960, 1280);
  // A landscape photo from a portrait preview would be cropped sideways.
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4032, height: 3024, close: vi.fn() })));
  vi.stubGlobal("ImageCapture", class { takePhoto = async () => new Blob(["photo"]); });
  await captureFullStill(video, {} as MediaStreamTrack);
  expect(drawn[0]).toBe(video);
  expect(dimensions[0]).toEqual([960, 1280]);

  const previewDraws = () => drawn.filter((source) => source === video).length;
  vi.stubGlobal("ImageCapture", class { takePhoto = async () => { throw new Error("busy"); }; });
  await captureFullStill(video, {} as MediaStreamTrack);
  expect(previewDraws()).toBe(2);

  vi.unstubAllGlobals();
  await captureFullStill(video, undefined);
  expect(previewDraws()).toBe(3);
});
