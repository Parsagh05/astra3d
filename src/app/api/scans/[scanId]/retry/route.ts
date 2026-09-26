import { isScanActive, kickScanQueue } from "@/server/scan-runner";
import { retryScan, ScanStoreError } from "@/server/scan-store";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Queues the scan again: after a failure, or to re-train it once a GPU worker is available. */
export async function POST(request: Request, { params }: { params: Promise<{ scanId: string }> }) {
  if (request.headers.get("x-astra3d-client") !== "room-studio-v1") {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  const { scanId } = await params;
  if (isScanActive(scanId)) return json({ error: "The scan is already being processed." }, 409);
  try {
    const scan = await retryScan(scanId);
    kickScanQueue();
    return json({ scan });
  } catch (error) {
    if (error instanceof ScanStoreError) return json({ error: error.message }, error.status);
    console.error("Astra3D scan retry failed", error);
    return json({ error: "The scan could not be queued again." }, 500);
  }
}
