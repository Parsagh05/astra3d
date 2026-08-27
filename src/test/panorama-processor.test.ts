import sharp from "sharp";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildCaptureSlots } from "@/lib/capture-plan";
import {
  composeRoomPanorama,
  processRoomPanorama,
  type ServerPanoramaFrame,
} from "@/server/panorama-processor";

async function createFrames() {
  const colors = {
    upper: { r: 24, g: 80, b: 220 },
    middle: { r: 30, g: 190, b: 95 },
    lower: { r: 220, g: 65, b: 35 },
  };

  return Promise.all(
    buildCaptureSlots().map(async (slot): Promise<ServerPanoramaFrame> => ({
      ...slot,
      ...(slot.sequence < 2
        ? { imu: { alpha: 360 - slot.column * 45, beta: 90, gamma: 0 } }
        : {}),
      image: await sharp({
        create: {
          width: 90,
          height: 120,
          channels: 3,
          background: colors[slot.band],
        },
      }).jpeg().toBuffer(),
    })),
  );
}

describe("laptop panorama processor", () => {
  it("creates a mobile-safe 2:1 JPEG with correctly ordered room bands", async () => {
    const { panorama: output, report } = await processRoomPanorama(await createFrames(), {
      width: 640,
      height: 320,
      quality: 90,
      pythonCommand: process.execPath,
      scriptPath: path.join(process.cwd(), "src", "test", "fixtures", "panorama-worker.mjs"),
    });
    const metadata = await sharp(output).metadata();
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });

    expect(metadata).toMatchObject({ format: "jpeg", width: 640, height: 320 });
    expect(report).toMatchObject({
      method: "opencv-sift-spherical-v3",
      alignmentScore: 0.875,
      matchedPairs: 21,
      fallbackPairs: 3,
      coverage: 0.98,
      // The worker fixture echoes how many imu.json entries reached it.
      imuFrames: 2,
    });

    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const upper = pixel(40, 48);
    const middle = pixel(40, 160);
    const lower = pixel(40, 272);

    expect(upper[2]).toBeGreaterThan(upper[0]);
    expect(middle[1]).toBeGreaterThan(middle[0]);
    expect(lower[0]).toBeGreaterThan(lower[2]);
  });

  it("returns actionable retake directions from failed quality analysis", async () => {
    await expect(processRoomPanorama(await createFrames(), {
      width: 640,
      height: 320,
      pythonCommand: process.execPath,
      scriptPath: path.join(process.cwd(), "src", "test", "fixtures", "panorama-quality-error.mjs"),
    })).rejects.toMatchObject({
      code: "QUALITY_CHECK_FAILED",
      retakeSequences: [4, 5],
    });
  });

  it("rejects incomplete capture plans before decoding images", async () => {
    await expect(composeRoomPanorama([], { width: 640, height: 320 })).rejects.toThrow(
      "Expected 24 capture frames",
    );
  });
});
