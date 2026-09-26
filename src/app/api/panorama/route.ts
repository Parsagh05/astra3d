import { buildCaptureSlots, TOTAL_CAPTURE_SLOTS } from "@/lib/capture-plan";
import { CaptureUploadError, parseCaptureUpload } from "@/server/capture-upload";
import {
  PANORAMA_HEIGHT,
  PANORAMA_WIDTH,
  PanoramaProcessingError,
  processRoomPanorama,
} from "@/server/panorama-processor";
import { saveCapturedProject } from "@/server/project-store";

export const runtime = "nodejs";
export const maxDuration = 240;

const PROCESSOR_CLIENT = "room-studio-v1";
let activeJobs = 0;

function errorResponse(
  message: string,
  status: number,
  code: string,
  retakeSequences: number[] = [],
) {
  return Response.json(
    { error: message, code, retakeSequences },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function GET() {
  return Response.json(
    {
      ready: true,
      processor: "opencv-feature-aligned",
      expectedFrames: buildCaptureSlots("quick").length,
      captureModes: { quick: buildCaptureSlots("quick").length, full: TOTAL_CAPTURE_SLOTS },
      output: { width: PANORAMA_WIDTH, height: PANORAMA_HEIGHT },
      pipeline: [
        "quality-check",
        "sift-alignment",
        "cylindrical-warp",
        "exposure-compensation",
        "graph-cut-seams",
        "multiband-blend",
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function processCaptureRequest(request: Request) {
  let upload;
  try {
    upload = await parseCaptureUpload(request);
  } catch (error) {
    if (error instanceof CaptureUploadError) return errorResponse(error.message, error.status, error.code);
    throw error;
  }
  const { frames, extent: captureExtent, name: roomName } = upload;

  try {
    const { panorama, report, width, height } = await processRoomPanorama(frames, { captureExtent });
    let project;
    try {
      project = await saveCapturedProject({
        name: roomName,
        frames,
        panorama,
        quality: report,
      });
    } catch (error) {
      console.error("Astra3D project persistence failed", error);
      return errorResponse(
        "The panorama was processed but could not be saved to the shared laptop library. Check disk access and try again.",
        500,
        "PROJECT_SAVE_FAILED",
      );
    }
    return new Response(new Uint8Array(panorama), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'inline; filename="astra3d-room-360.jpg"',
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "X-Astra3D-Height": String(height),
        "X-Astra3D-Alignment": String(report.alignmentScore),
        "X-Astra3D-Coverage": String(report.coverage),
        "X-Astra3D-Coverage-Scope": report.coverageScope ?? "three bands",
        "X-Astra3D-Fallback-Pairs": String(report.fallbackPairs),
        "X-Astra3D-Matched-Pairs": String(report.matchedPairs),
        "X-Astra3D-Method": report.method,
        "X-Astra3D-Processor": "laptop-opencv",
        "X-Astra3D-Project-Id": project.id,
        "X-Astra3D-Retakes": report.retakeSequences.join(","),
        "X-Astra3D-Warnings": encodeURIComponent(JSON.stringify(report.warnings)),
        "X-Astra3D-Width": String(width),
      },
    });
  } catch (error) {
    console.error("Astra3D panorama processing failed", error);
    if (error instanceof PanoramaProcessingError) {
      const status = error.code === "PROCESSOR_UNAVAILABLE" ? 503 : 422;
      return errorResponse(error.message, status, error.code, error.retakeSequences);
    }
    return errorResponse(
      "The laptop could not process these room photos. Retake any blurred views and try again.",
      422,
      "PROCESSING_FAILED",
    );
  }
}

export async function POST(request: Request) {
  if (request.headers.get("x-astra3d-client") !== PROCESSOR_CLIENT) {
    return errorResponse("This processor only accepts Astra3D room captures.", 403, "INVALID_CLIENT");
  }
  if (activeJobs >= 1) {
    return errorResponse(
      "The laptop is already processing a room. Wait for it to finish and try again.",
      429,
      "PROCESSOR_BUSY",
    );
  }

  activeJobs += 1;
  try {
    return await processCaptureRequest(request);
  } finally {
    activeJobs -= 1;
  }
}
