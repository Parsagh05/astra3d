import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCaptureSlots, TOTAL_CAPTURE_SLOTS } from "@/lib/capture-plan";
import type { ServerPanoramaFrame } from "@/server/panorama-processor";

let testRoot: string | null = null;

afterEach(async () => {
  delete process.env.ASTRA3D_DATA_DIR;
  vi.resetModules();
  if (testRoot) {
    const resolved = path.resolve(testRoot);
    if (!resolved.startsWith(path.resolve(tmpdir()))) throw new Error("Refusing to clean an unexpected test path.");
    await rm(resolved, { recursive: true, force: true });
    testRoot = null;
  }
});

describe("shared laptop project store", () => {
  it("atomically saves the panorama, manifest, and every original capture", async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "astra3d-project-test-"));
    process.env.ASTRA3D_DATA_DIR = testRoot;
    const store = await import("@/server/project-store");
    const frames: ServerPanoramaFrame[] = buildCaptureSlots().map((slot) => ({
      ...slot,
      image: Buffer.from(`original-${slot.sequence}`),
      zoom: 1,
      mimeType: "image/jpeg",
    }));

    const project = await store.saveCapturedProject({
      name: "Living room",
      createdAt: "2026-08-15T00:00:00.000Z",
      frames,
      panorama: Buffer.from("panorama"),
      quality: {
        method: "opencv-sift-spherical-v3",
        alignmentScore: 0.9,
        matchedPairs: 22,
        fallbackPairs: 2,
        coverage: 0.98,
        retakeSequences: [],
        warnings: [],
      },
    });

    expect(project).toMatchObject({ name: "Living room", photoCount: TOTAL_CAPTURE_SLOTS, hasSourceFrames: true });
    await expect(store.listProjects()).resolves.toEqual([project]);
    const stored = await store.readProjectPanorama(project.id);
    expect(stored?.panorama.toString()).toBe("panorama");
    const frameFiles = await readdir(path.join(store.projectStorePaths.projectsRoot, project.id, "frames"));
    expect(frameFiles).toHaveLength(TOTAL_CAPTURE_SLOTS);
    expect(frameFiles[0]).toMatch(/^01-middle-1\.jpg$/);
  });

  it("migrates an existing panorama without claiming its deleted originals exist", async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "astra3d-project-test-"));
    process.env.ASTRA3D_DATA_DIR = testRoot;
    const store = await import("@/server/project-store");
    const project = await store.savePanoramaProject({
      name: "Legacy room",
      photoCount: TOTAL_CAPTURE_SLOTS,
      panorama: Buffer.from("legacy-panorama"),
    });

    expect(project).toMatchObject({ photoCount: TOTAL_CAPTURE_SLOTS, hasSourceFrames: false });
    const framePath = path.join(store.projectStorePaths.projectsRoot, project.id, "frames");
    await expect(readdir(framePath)).rejects.toThrow();
  });
});
