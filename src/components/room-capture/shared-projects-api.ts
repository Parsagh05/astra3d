import type { GeneratedRoomRecord, SharedRoomProject } from "@/types/capture";

type ProjectListResponse = { projects?: SharedRoomProject[]; error?: string };
type ProjectWriteResponse = { project?: SharedRoomProject; error?: string };

async function readJson<T>(response: Response) {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}

export async function fetchSharedProjects() {
  const response = await fetch("/api/projects", { cache: "no-store" });
  const payload = await readJson<ProjectListResponse>(response);
  if (!response.ok || !Array.isArray(payload.projects)) {
    throw new Error(payload.error || "The shared laptop project library could not be loaded.");
  }
  return payload.projects;
}

export async function loadSharedProject(project: SharedRoomProject): Promise<GeneratedRoomRecord> {
  const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/panorama`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("This project panorama is no longer available on the laptop.");
  const panorama = await response.blob();
  if (panorama.type !== "image/jpeg" || panorama.size === 0) {
    throw new Error("The laptop returned an invalid project panorama.");
  }
  return {
    id: "latest-room",
    name: project.name,
    createdAt: project.createdAt,
    photoCount: project.photoCount,
    panorama,
    processor: "laptop",
    quality: project.quality,
    serverProjectId: project.id,
    hasSourceFrames: project.hasSourceFrames,
  };
}

export async function syncSavedRoom(room: GeneratedRoomRecord) {
  if (room.serverProjectId) return null;
  const formData = new FormData();
  formData.append("name", room.name);
  formData.append("created-at", room.createdAt);
  formData.append("photo-count", String(room.photoCount));
  formData.append("panorama", room.panorama, "legacy-panorama.jpg");
  if (room.quality) formData.append("quality", JSON.stringify(room.quality));
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "X-Astra3D-Client": "room-studio-v1" },
    body: formData,
  });
  const payload = await readJson<ProjectWriteResponse>(response);
  if (!response.ok || !payload.project) {
    throw new Error(payload.error || "The saved phone panorama could not be synchronized.");
  }
  return payload.project;
}
