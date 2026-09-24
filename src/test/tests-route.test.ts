// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processRoomPanorama: vi.fn(),
  readProjectSource: vi.fn(),
  loadTestCase: vi.fn(),
  discoverTestCases: vi.fn(),
}));

vi.mock("@/server/panorama-processor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/panorama-processor")>()),
  processRoomPanorama: mocks.processRoomPanorama,
}));
vi.mock("@/server/project-store", () => ({ readProjectSource: mocks.readProjectSource }));
vi.mock("@/server/test-case-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/test-case-store")>()),
  loadTestCase: mocks.loadTestCase,
  discoverTestCases: mocks.discoverTestCases,
}));

import { GET as listTests } from "@/app/api/tests/route";
import { POST as runTest } from "@/app/api/tests/run/route";

const report = {
  method: "opencv-sift-spherical-v4" as const,
  alignmentScore: 0.92,
  matchedPairs: 11,
  fallbackPairs: 1,
  coverage: 1,
  coverageScope: "eye-level ring" as const,
  retakeSequences: [4],
  warnings: ["Plain wall"],
};

function runRequest(body: unknown, client = "room-studio-v1") {
  return new Request("http://localhost/api/tests/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Astra3D-Client": client },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.processRoomPanorama.mockResolvedValue({ panorama: Buffer.from("jpeg"), report, width: 3072, height: 1536 });
  mocks.loadTestCase.mockResolvedValue({ name: "Hall", extent: "quick", frames: [{ sequence: 0 }] });
  mocks.readProjectSource.mockResolvedValue({ name: "Saved", extent: "full", frames: [{ sequence: 0 }] });
});

describe("tests API", () => {
  it("lists discovered cases and skipped folders", async () => {
    mocks.discoverTestCases.mockResolvedValue({ cases: [{ path: "12-images/hall" }], invalid: [{ path: "10/x" }], root: "/x" });
    const response = await listTests();
    await expect(response.json()).resolves.toEqual({ testCases: [{ path: "12-images/hall" }], invalid: [{ path: "10/x" }] });
  });

  it("re-runs a test case through the stitcher and returns the report in headers", async () => {
    const response = await runTest(runRequest({ path: "12-images/hall" }));
    expect(response.status).toBe(200);
    expect(mocks.loadTestCase).toHaveBeenCalledWith("12-images/hall");
    expect(mocks.processRoomPanorama).toHaveBeenCalledWith([{ sequence: 0 }], { captureExtent: "quick" });
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("X-Astra3D-Alignment")).toBe("0.92");
    expect(response.headers.get("X-Astra3D-Retakes")).toBe("4");
    expect(JSON.parse(decodeURIComponent(response.headers.get("X-Astra3D-Warnings") ?? ""))).toEqual(["Plain wall"]);
    expect(Number(response.headers.get("X-Astra3D-Duration-Ms"))).toBeGreaterThanOrEqual(0);
  });

  it("re-runs a saved studio project with its own capture plan", async () => {
    const response = await runTest(runRequest({ projectId: "11111111-1111-4111-8111-111111111111" }));
    expect(response.status).toBe(200);
    expect(mocks.processRoomPanorama).toHaveBeenCalledWith([{ sequence: 0 }], { captureExtent: "full" });
  });

  it("rejects foreign clients and unknown projects", async () => {
    expect((await runTest(runRequest({ path: "12-images/hall" }, "other"))).status).toBe(403);
    mocks.readProjectSource.mockResolvedValue(null);
    const missing = await runTest(runRequest({ projectId: "11111111-1111-4111-8111-111111111111" }));
    expect(missing.status).toBe(404);
    const empty = await runTest(runRequest({}));
    expect(empty.status).toBe(400);
  });
});
