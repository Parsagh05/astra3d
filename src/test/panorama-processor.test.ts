import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { buildCaptureSlots } from "@/lib/capture-plan";
import {
  composeRoomPanorama,
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
    const output = await composeRoomPanorama(await createFrames(), {
      width: 640,
      height: 320,
      quality: 90,
    });
    const metadata = await sharp(output).metadata();
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });

    expect(metadata).toMatchObject({ format: "jpeg", width: 640, height: 320 });

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

  it("rejects incomplete capture plans before decoding images", async () => {
    await expect(composeRoomPanorama([], { width: 640, height: 320 })).rejects.toThrow(
      "Expected 24 capture frames",
    );
  });
});
