import { isScanActive } from "@/server/scan-runner";
import { deleteScan, getScan, ScanStoreError } from "@/server/scan-store";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await params;
  const scan = await getScan(scanId, { isActive: isScanActive });
  return scan ? json({ scan }) : json({ error: "Scan not found." }, 404);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ scanId: string }> }) {
  if (request.headers.get("x-astra3d-client") !== "room-studio-v1") {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  const { scanId } = await params;
  if (isScanActive(scanId)) {
    return json({ error: "The scan is being processed. Wait for it to finish, then delete it." }, 409);
  }
  try {
    await deleteScan(scanId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ScanStoreError) return json({ error: error.message }, error.status);
    console.error("Astra3D scan delete failed", error);
    return json({ error: "The scan could not be deleted." }, 500);
  }
}
