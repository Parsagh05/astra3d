import { beforeEach, describe, expect, it, vi } from "vitest";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Shared room",
  createdAt: "2026-08-15T00:00:00.000Z",
  photoCount: 24,
  hasSourceFrames: false,
  processor: "laptop" as const,
};

const storeMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  readProjectPanorama: vi.fn(),
  savePanoramaProject: vi.fn(),
}));

vi.mock("@/server/project-store", () => storeMock);

import { GET as listProjects, POST as importProject } from "@/app/api/projects/route";
import { GET as readPanorama } from "@/app/api/projects/[projectId]/panorama/route";

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.listProjects.mockResolvedValue([project]);
  storeMock.savePanoramaProject.mockResolvedValue(project);
  storeMock.readProjectPanorama.mockResolvedValue({ project, panorama: Buffer.from("panorama") });
});

describe("shared project routes", () => {
  it("lists common laptop projects without caching", async () => {
    const response = await listProjects();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ projects: [project] });
  });

  it("migrates an existing phone panorama and serves it back", async () => {
    const formData = new FormData();
    formData.append("name", "Shared room");
    formData.append("photo-count", "24");
    formData.append("panorama", new File(["panorama"], "room.jpg", { type: "image/jpeg" }));
    const imported = await importProject(new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "X-Astra3D-Client": "room-studio-v1" },
      body: formData,
    }));
    expect(imported.status).toBe(201);
    expect(storeMock.savePanoramaProject).toHaveBeenCalledWith(expect.objectContaining({
      name: "Shared room",
      photoCount: 24,
    }));

    const panorama = await readPanorama(new Request("http://localhost"), {
      params: Promise.resolve({ projectId: project.id }),
    });
    expect(panorama.status).toBe(200);
    expect(panorama.headers.get("Content-Type")).toBe("image/jpeg");
    await expect(panorama.text()).resolves.toBe("panorama");
  });

  it("rejects untrusted project imports", async () => {
    const response = await importProject(new Request("http://localhost/api/projects", {
      method: "POST",
      body: new FormData(),
    }));
    expect(response.status).toBe(403);
    expect(storeMock.savePanoramaProject).not.toHaveBeenCalled();
  });
});
