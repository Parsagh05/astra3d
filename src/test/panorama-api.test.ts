import { describe, expect, it } from "vitest";

import {
  createPanoramaUpload,
  decodeCaptureDataUrl,
} from "@/components/room-capture/panorama-api";
import type { CapturedFrame } from "@/types/capture";

const jpegDataUrl = "data:image/jpeg;base64,/9j/2Q==";

describe("panorama upload client", () => {
  it("decodes captured JPEG data without browser image processing", async () => {
    const image = decodeCaptureDataUrl(jpegDataUrl);

    expect(image.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([255, 216, 255, 217]);
  });

  it("sorts frame fields by capture sequence for the laptop API", () => {
    const frames: CapturedFrame[] = [
      { id: "middle-1", band: "middle", column: 1, sequence: 1, yaw: 45, capturedAt: 2, dataUrl: jpegDataUrl, zoom: 1.2 },
      { id: "middle-0", band: "middle", column: 0, sequence: 0, yaw: 0, capturedAt: 1, dataUrl: jpegDataUrl, zoom: 1 },
    ];

    const upload = createPanoramaUpload(frames);
    expect(Array.from(upload.keys())).toEqual(["room-name", "frame-0", "zoom-0", "frame-1", "zoom-1"]);
    expect(upload.get("room-name")).toBe("My room");
    expect(upload.get("frame-0")).toBeInstanceOf(File);
    expect(upload.get("zoom-1")).toBe("1.2");
  });

  it("uploads the recorded motion sample beside frames that have one", () => {
    const frames: CapturedFrame[] = [
      {
        id: "middle-0",
        band: "middle",
        column: 0,
        sequence: 0,
        yaw: 0,
        capturedAt: 1,
        dataUrl: jpegDataUrl,
        zoom: 1,
        imu: { alpha: 350.5, beta: 89.2, gamma: -1.4 },
      },
      { id: "middle-1", band: "middle", column: 1, sequence: 1, yaw: 45, capturedAt: 2, dataUrl: jpegDataUrl, zoom: 1 },
    ];

    const upload = createPanoramaUpload(frames);
    expect(JSON.parse(upload.get("imu-0") as string)).toEqual({ alpha: 350.5, beta: 89.2, gamma: -1.4 });
    expect(upload.get("imu-1")).toBeNull();
  });
});
