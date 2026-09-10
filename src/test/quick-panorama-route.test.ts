// @vitest-environment node
import { expect, it, vi } from "vitest";
import { buildCaptureSlots } from "@/lib/capture-plan";
const processMock = vi.hoisted(() => vi.fn(async () => ({
  panorama: Buffer.from("jpeg"), width: 3072, height: 1536,
  report: { method: "opencv-sift-spherical-v4", alignmentScore: 1, coverage: 1, coverageScope: "eye-level ring", matchedPairs: 12, fallbackPairs: 0, retakeSequences: [], warnings: [] },
})));
vi.mock("@/server/panorama-processor", async (original) => ({
  ...await original<typeof import("@/server/panorama-processor")>(), processRoomPanorama: processMock,
}));
vi.mock("@/server/project-store", () => ({ saveCapturedProject: vi.fn(async () => ({ id: "quick-project" })) }));
import { POST } from "@/app/api/panorama/route";

it("accepts exactly the quick ring, persists it, and labels its coverage", async () => {
  const form = new FormData();
  form.append("capture-mode", "quick");
  for (const slot of buildCaptureSlots("quick")) form.append(`frame-${slot.sequence}`, new Blob(["jpeg"], { type: "image/jpeg" }));
  const response = await POST(new Request("http://localhost/api/panorama", {
    method: "POST", headers: { "X-Astra3D-Client": "room-studio-v1" }, body: form,
  }));
  expect(response.status).toBe(200);
  expect(processMock).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ sequence: 11, band: "middle" })]), { captureExtent: "quick" });
  expect(processMock).toHaveBeenCalledWith(expect.objectContaining({ length: 12 }), { captureExtent: "quick" });
  expect(response.headers.get("X-Astra3D-Coverage-Scope")).toBe("eye-level ring");
  expect(response.headers.get("X-Astra3D-Project-Id")).toBe("quick-project");
});

it("does not silently accept a partial full scan as a quick scan", async () => {
  const form = new FormData();
  form.append("capture-mode", "full");
  for (const slot of buildCaptureSlots("quick")) form.append(`frame-${slot.sequence}`, new Blob(["jpeg"], { type: "image/jpeg" }));
  const response = await POST(new Request("http://localhost/api/panorama", {
    method: "POST", headers: { "X-Astra3D-Client": "room-studio-v1" }, body: form,
  }));
  expect(response.status).toBe(400);
  expect(processMock).not.toHaveBeenCalled();
});
