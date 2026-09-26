import { kickScanQueue, isScanActive, scanWorkerMode } from "@/server/scan-runner";
import { createScan, listScans, maxScanBytes, ScanStoreError } from "@/server/scan-store";
import type { ScanJob } from "@/types/scan";

export const runtime = "nodejs";

const CLIENT_HEADER = "room-studio-v1";

export type ScansResponse = {
  scans: ScanJob[];
  worker: "local" | "external";
  maxBytes: number;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    const scans = await listScans({ isActive: isScanActive });
    if (scans.some((scan) => scan.status === "queued")) kickScanQueue();
    return json({ scans, worker: scanWorkerMode(), maxBytes: maxScanBytes() } satisfies ScansResponse);
  } catch (error) {
    console.error("Astra3D scan listing failed", error);
    return json({ error: "Scans could not be listed.", scans: [] }, 500);
  }
}

/**
 * Uploads a walk-through video as the raw request body (not multipart), so
 * a 1 GB video streams straight to disk.  The scan name is `?name=`.
 */
export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D uploads." }, 403);
  }
  if (!request.body) return json({ error: "Attach a video." }, 400);
  const declared = Number(request.headers.get("content-length"));
  try {
    const scan = await createScan({
      name: new URL(request.url).searchParams.get("name") ?? "",
      mimeType: request.headers.get("content-type") ?? "",
      body: request.body,
      declaredBytes: Number.isFinite(declared) && declared > 0 ? declared : undefined,
    });
    kickScanQueue();
    return json({ scan }, 201);
  } catch (error) {
    if (error instanceof ScanStoreError) return json({ error: error.message }, error.status);
    console.error("Astra3D scan upload failed", error);
    return json({ error: "The video could not be saved. Check the server's free disk space." }, 500);
  }
}
