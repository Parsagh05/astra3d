import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSharedProjects,
  loadSharedProject,
  syncSavedRoom,
} from "@/components/room-capture/shared-projects-api";
import type { GeneratedRoomRecord, SharedRoomProject } from "@/types/capture";

const project: SharedRoomProject = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Shared room",
  createdAt: "2026-08-15T00:00:00.000Z",
  photoCount: 24,
  hasSourceFrames: true,
  processor: "laptop",
};

afterEach(() => vi.unstubAllGlobals());

describe("shared project client", () => {
  it("lists and opens projects from the common laptop library", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [project] }), {
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { "Content-Type": "image/jpeg" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSharedProjects()).resolves.toEqual([project]);
    const room = await loadSharedProject(project);
    expect(room).toMatchObject({ name: "Shared room", serverProjectId: project.id, processor: "laptop" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/projects/${project.id}/panorama`,
      { cache: "no-store" },
    );
  });

  it("migrates the phone's existing final panorama exactly once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ project }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const room: GeneratedRoomRecord = {
      id: "latest-room",
      name: "Phone room",
      createdAt: "2026-08-14T00:00:00.000Z",
      photoCount: 24,
      panorama: new Blob(["panorama"], { type: "image/jpeg" }),
      processor: "laptop",
    };

    await expect(syncSavedRoom(room)).resolves.toEqual(project);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({ "X-Astra3D-Client": "room-studio-v1" });
    await expect(syncSavedRoom({ ...room, serverProjectId: project.id })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
