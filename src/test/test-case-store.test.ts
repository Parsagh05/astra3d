// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCaptureSlots, CAPTURE_COLUMNS } from "@/lib/capture-plan";
import type { ServerPanoramaFrame } from "@/server/panorama-processor";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "astra3d-test-cases-"));
  process.env.ASTRA3D_TEST_CASES_DIR = path.join(root, "test-cases");
  process.env.ASTRA3D_DATA_DIR = path.join(root, "data");
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.ASTRA3D_TEST_CASES_DIR;
  delete process.env.ASTRA3D_DATA_DIR;
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()))) throw new Error("Refusing to clean an unexpected path.");
  await rm(root, { recursive: true, force: true });
});

async function writeImages(directory: string, names: string[]) {
  await mkdir(directory, { recursive: true });
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), `image:${name}`)));
}

function quickFrames(): ServerPanoramaFrame[] {
  return buildCaptureSlots("quick").map((slot) => ({
    ...slot,
    image: Buffer.from(`still-${slot.sequence}`),
    zoom: 1,
    imu: { alpha: (360 - slot.column * 30) % 360, beta: 90, gamma: 0 },
    mimeType: "image/jpeg",
  }));
}

describe("test case store", () => {
  it("discovers cases by photo count in any folder and explains the ones it skips", async () => {
    const store = await import("@/server/test-case-store");
    const cases = path.join(root, "test-cases");
    await writeImages(path.join(cases, "12", "hallway"), Array.from({ length: 12 }, (_, i) => `${i + 1}.jpg`));
    await writeImages(path.join(cases, "36-images", "loft"), Array.from({ length: 36 }, (_, i) => `${String(i + 1).padStart(2, "0")}.jpg`));
    await writeImages(path.join(cases, "10", "partial"), Array.from({ length: 10 }, (_, i) => `${i + 1}.jpg`));

    const result = await store.discoverTestCases();
    expect(result.cases.map((item) => [item.path, item.extent, item.imageCount])).toEqual([
      ["12/hallway", "quick", 12],
      ["36-images/loft", "full", 36],
    ]);
    expect(result.invalid).toEqual([
      expect.objectContaining({ path: "10/partial", imageCount: 10 }),
    ]);
  });

  it("orders the older <pitch>-<column> names into plan sequence", async () => {
    const store = await import("@/server/test-case-store");
    const names = [0, 50, -50].flatMap((pitch) =>
      Array.from({ length: CAPTURE_COLUMNS }, (_, column) => `${pitch}-${column + 1}.jpg`));
    const ordered = store.orderCaseImages([...names].reverse(), "full");
    expect(ordered.slice(0, 2)).toEqual(["0-1.jpg", "0-2.jpg"]);
    expect(ordered[CAPTURE_COLUMNS]).toBe("50-1.jpg");
    expect(ordered[CAPTURE_COLUMNS * 2]).toBe("-50-1.jpg");
    expect(store.orderCaseImages(["10.jpg", "2.jpg", "1.jpg"], "quick")).toEqual(["1.jpg", "2.jpg", "10.jpg"]);
  });

  it("saves a capture with its motion data and loads it back as identical frames", async () => {
    const store = await import("@/server/test-case-store");
    const saved = await store.saveTestCase({ name: "Living Room / window", extent: "quick", frames: quickFrames() });
    expect(saved).toMatchObject({ path: "12-images/living-room-window", extent: "quick", imageCount: 12, hasImu: true });
    const again = await store.saveTestCase({ name: "Living Room / window", extent: "quick", frames: quickFrames() });
    expect(again.path).toBe("12-images/living-room-window-2");

    const loaded = await store.loadTestCase(saved.path);
    expect(loaded.extent).toBe("quick");
    expect(loaded.frames.map((frame) => frame.image.toString())).toEqual(quickFrames().map((frame) => frame.image.toString()));
    expect(loaded.frames[1].imu).toEqual({ alpha: 330, beta: 90, gamma: 0 });
    const files = await readdir(path.join(root, "test-cases", "12-images", "living-room-window"));
    expect(files).toContain("metadata.json");
    expect(files.filter((file) => file.endsWith(".jpg"))).toHaveLength(12);
  });

  it("refuses paths that leave the test-cases folder", async () => {
    const store = await import("@/server/test-case-store");
    await expect(store.loadTestCase("../../etc")).rejects.toThrow("Invalid test case path.");
    await expect(store.loadTestCase("12-images/..")).rejects.toThrow("Invalid test case path.");
    await expect(store.loadTestCase("12-images/missing")).rejects.toThrow("Test case not found.");
  });

  it("keeps a saved studio project as a permanent test case", async () => {
    const projects = await import("@/server/project-store");
    const store = await import("@/server/test-case-store");
    const project = await projects.saveCapturedProject({
      name: "Docker capture",
      frames: quickFrames(),
      panorama: Buffer.from("panorama"),
      quality: {
        method: "opencv-sift-spherical-v4",
        alignmentScore: 1,
        matchedPairs: 12,
        fallbackPairs: 0,
        coverage: 1,
        retakeSequences: [],
        warnings: [],
      },
    });

    const source = await projects.readProjectSource(project.id);
    expect(source?.extent).toBe("quick");
    expect(source?.frames[3].imu).toEqual({ alpha: 270, beta: 90, gamma: 0 });

    const kept = await store.promoteProjectToTestCase(project.id);
    expect(kept).toMatchObject({ path: "12-images/docker-capture", source: `project:${project.id}` });
    const metadata = JSON.parse(await readFile(path.join(root, "test-cases", "12-images", "docker-capture", "metadata.json"), "utf8"));
    expect(metadata.frames).toHaveLength(12);
    await expect(store.promoteProjectToTestCase("11111111-1111-4111-8111-111111111111")).rejects.toThrow("no saved source photos");
  });
});
