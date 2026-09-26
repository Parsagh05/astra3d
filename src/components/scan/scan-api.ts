import type { ScanJob, ScanScene } from "@/types/scan";

const CLIENT_HEADER = { "X-Astra3D-Client": "room-studio-v1" };

export type ScansListing = { scans: ScanJob[]; worker: "local" | "external"; maxBytes: number };

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchScans(signal?: AbortSignal): Promise<ScansListing> {
  const response = await fetch("/api/scans", { cache: "no-store", signal });
  if (!response.ok) throw new Error(await errorMessage(response, "Scans could not be loaded."));
  return (await response.json()) as ScansListing;
}

export async function fetchScan(id: string, signal?: AbortSignal): Promise<ScanJob | null> {
  const response = await fetch(`/api/scans/${encodeURIComponent(id)}`, { cache: "no-store", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await errorMessage(response, "The scan could not be loaded."));
  return ((await response.json()) as { scan: ScanJob }).scan;
}

export async function fetchScene(id: string, signal?: AbortSignal): Promise<ScanScene> {
  const response = await fetch(scanFileUrl(id, "scene.json"), { cache: "no-store", signal });
  if (!response.ok) throw new Error("The scene description could not be loaded.");
  return (await response.json()) as ScanScene;
}

export async function retryScan(id: string): Promise<ScanJob> {
  const response = await fetch(`/api/scans/${encodeURIComponent(id)}/retry`, { method: "POST", headers: CLIENT_HEADER });
  if (!response.ok) throw new Error(await errorMessage(response, "The scan could not be queued again."));
  return ((await response.json()) as { scan: ScanJob }).scan;
}

export async function deleteScan(id: string): Promise<void> {
  const response = await fetch(`/api/scans/${encodeURIComponent(id)}`, { method: "DELETE", headers: CLIENT_HEADER });
  if (!response.ok) throw new Error(await errorMessage(response, "The scan could not be deleted."));
}

export function scanFileUrl(id: string, file: string, version?: string) {
  const url = `/api/scans/${encodeURIComponent(id)}/files/${file}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

/** Normalises a picked or recorded video's type to one the server accepts. */
export function uploadType(file: Blob & { name?: string }) {
  const type = file.type.split(";")[0].toLowerCase();
  if (["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"].includes(type)) return type;
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mkv")) return "video/x-matroska";
  if (name.endsWith(".mp4") || name.endsWith(".m4v")) return "video/mp4";
  return type || "application/octet-stream";
}

export type UploadHandle = { promise: Promise<ScanJob>; abort: () => void };

/**
 * Sends the video as the raw request body.  XHR (not fetch) because only XHR
 * reports upload progress, which matters for a 500 MB file on a phone.
 */
export function uploadScan(file: Blob & { name?: string }, name: string, onProgress: (fraction: number) => void): UploadHandle {
  const request = new XMLHttpRequest();
  const promise = new Promise<ScanJob>((resolve, reject) => {
    request.open("POST", `/api/scans?name=${encodeURIComponent(name)}`);
    request.setRequestHeader("Content-Type", uploadType(file));
    request.setRequestHeader("X-Astra3D-Client", CLIENT_HEADER["X-Astra3D-Client"]);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      const body = request.response as { scan?: ScanJob; error?: string } | null;
      if (request.status === 201 && body?.scan) resolve(body.scan);
      else reject(new Error(body?.error ?? `The upload failed (${request.status}).`));
    };
    request.onerror = () => reject(new Error("The upload failed. Check the connection and try again."));
    request.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    request.send(file);
  });
  return { promise, abort: () => request.abort() };
}

export const STAGE_LABELS: Record<ScanJob["stage"], string> = {
  queued: "Waiting",
  frames: "Picking sharp frames",
  poses: "Solving camera positions",
  training: "Building the 3D scene",
  export: "Finishing",
  done: "Ready",
};

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString("en-US");
}
