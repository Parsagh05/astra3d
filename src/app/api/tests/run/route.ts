import { PanoramaProcessingError, processRoomPanorama, type ServerPanoramaFrame } from "@/server/panorama-processor";
import { readProjectSource } from "@/server/project-store";
import { loadTestCase, TestCaseError } from "@/server/test-case-store";
import type { CaptureExtent } from "@/lib/capture-plan";

export const runtime = "nodejs";
export const maxDuration = 240;

const CLIENT_HEADER = "room-studio-v1";
let activeJobs = 0;

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function loadSource(body: { path?: unknown; projectId?: unknown }): Promise<{
  frames: ServerPanoramaFrame[];
  extent: CaptureExtent;
}> {
  if (typeof body.path === "string") return loadTestCase(body.path);
  if (typeof body.projectId === "string") {
    const source = await readProjectSource(body.projectId);
    if (!source) throw new TestCaseError("That project has no saved source photos.", 404);
    return source;
  }
  throw new TestCaseError("Send a test case path or a saved projectId.");
}

/**
 * Re-runs a fixed capture — a test case or a saved studio project — through
 * the current stitcher.  Nothing is saved; the panorama and its quality
 * report come straight back for comparison.
 */
export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== CLIENT_HEADER) {
    return json({ error: "This endpoint only accepts Astra3D requests." }, 403);
  }
  if (activeJobs >= 1) {
    return json({ error: "Another test is still processing. Wait for it to finish." }, 429);
  }
  let body: { path?: unknown; projectId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "Send a JSON body with a test case path or projectId." }, 400);
  }

  activeJobs += 1;
  const started = performance.now();
  try {
    const { frames, extent } = await loadSource(body);
    const result = await processRoomPanorama(frames, { captureExtent: extent });
    const report = result.report;
    return new Response(new Uint8Array(result.panorama), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg",
        "X-Astra3D-Height": String(result.height),
        "X-Astra3D-Width": String(result.width),
        "X-Astra3D-Alignment": String(report.alignmentScore),
        "X-Astra3D-Coverage": String(report.coverage),
        "X-Astra3D-Coverage-Scope": report.coverageScope ?? "three bands",
        "X-Astra3D-Fallback-Pairs": String(report.fallbackPairs),
        "X-Astra3D-Matched-Pairs": String(report.matchedPairs),
        "X-Astra3D-Method": report.method,
        "X-Astra3D-Retakes": report.retakeSequences.join(","),
        "X-Astra3D-Warnings": encodeURIComponent(JSON.stringify(report.warnings)),
        "X-Astra3D-Duration-Ms": String(Math.round(performance.now() - started)),
        "X-Astra3D-Photo-Count": String(frames.length),
      },
    });
  } catch (error) {
    if (error instanceof TestCaseError) return json({ error: error.message }, error.status);
    if (error instanceof PanoramaProcessingError) {
      return json({
        error: error.message,
        code: error.code,
        retakeSequences: error.retakeSequences,
        durationMs: Math.round(performance.now() - started),
      }, error.code === "PROCESSOR_UNAVAILABLE" ? 503 : 422);
    }
    console.error("Astra3D test run failed", error);
    return json({ error: error instanceof Error ? error.message : "Test run failed." }, 500);
  } finally {
    activeJobs -= 1;
  }
}
