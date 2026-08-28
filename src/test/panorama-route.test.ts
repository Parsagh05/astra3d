import { describe, expect, it } from "vitest";

import { TOTAL_CAPTURE_SLOTS } from "@/lib/capture-plan";
import { GET, POST } from "@/app/api/panorama/route";

describe("panorama processing route", () => {
  it("reports the laptop processor and its mobile output size", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      processor: "opencv-feature-aligned",
      expectedFrames: TOTAL_CAPTURE_SLOTS,
      output: { width: 3072, height: 1536 },
      pipeline: expect.arrayContaining(["sift-alignment", "graph-cut-seams", "multiband-blend"]),
    });
  });

  it("rejects incomplete uploads without starting image processing", async () => {
    const response = await POST(new Request("http://localhost/api/panorama", {
      method: "POST",
      headers: { "X-Astra3D-Client": "room-studio-v1" },
      body: new FormData(),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "MISSING_FRAME",
    });
  });

  it("rejects requests that did not originate from the room studio client", async () => {
    const response = await POST(new Request("http://localhost/api/panorama", {
      method: "POST",
      body: new FormData(),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_CLIENT" });
  });
});
