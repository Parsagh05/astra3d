import type { HouseTour, HouseTourInput } from "@/types/house-tour";

const CLIENT_HEADERS = { "X-Astra3D-Client": "room-studio-v1", "Content-Type": "application/json" };

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchTours(signal?: AbortSignal): Promise<HouseTour[]> {
  const response = await fetch("/api/tours", { cache: "no-store", signal });
  if (!response.ok) throw new Error(await errorMessage(response, "Tours could not be loaded."));
  return ((await response.json()) as { tours: HouseTour[] }).tours;
}

export async function fetchTour(id: string, signal?: AbortSignal): Promise<HouseTour | null> {
  const response = await fetch(`/api/tours/${encodeURIComponent(id)}`, { cache: "no-store", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await errorMessage(response, "The tour could not be loaded."));
  return ((await response.json()) as { tour: HouseTour }).tour;
}

export async function createTour(input: HouseTourInput): Promise<HouseTour> {
  const response = await fetch("/api/tours", { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await errorMessage(response, "The tour could not be created."));
  return ((await response.json()) as { tour: HouseTour }).tour;
}

export async function saveTour(id: string, input: HouseTourInput): Promise<HouseTour> {
  const response = await fetch(`/api/tours/${encodeURIComponent(id)}`, { method: "PUT", headers: CLIENT_HEADERS, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await errorMessage(response, "The tour could not be saved."));
  return ((await response.json()) as { tour: HouseTour }).tour;
}

export async function deleteTour(id: string): Promise<void> {
  const response = await fetch(`/api/tours/${encodeURIComponent(id)}`, { method: "DELETE", headers: CLIENT_HEADERS });
  if (!response.ok) throw new Error(await errorMessage(response, "The tour could not be deleted."));
}

/** The 360° panorama of a studio project. */
export function panoramaUrl(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/panorama`;
}
