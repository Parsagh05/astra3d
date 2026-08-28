import { buildCaptureSlots, TOTAL_CAPTURE_SLOTS } from "@/lib/capture-plan";
import {
  MAX_CAPTURE_BYTES,
  MAX_FRAME_BYTES,
  PANORAMA_HEIGHT,
  PANORAMA_WIDTH,
  PanoramaProcessingError,
  processRoomPanorama,
  type ServerPanoramaFrame,
} from "@/server/panorama-processor";
import { saveCapturedProject } from "@/server/project-store";

export const runtime = "nodejs";
export const maxDuration = 240;

const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
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
      expectedFrames: TOTAL_CAPTURE_SLOTS,
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
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BYTES) {
    return errorResponse("The capture package is too large.", 413, "CAPTURE_TOO_LARGE");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("The capture package could not be read.", 400, "INVALID_FORM_DATA");
  }

  const frames: ServerPanoramaFrame[] = [];
  let totalBytes = 0;
  const roomNameValue = formData.get("room-name");
  const roomName = typeof roomNameValue === "string" ? roomNameValue : "My room";

  for (const slot of buildCaptureSlots()) {
    const value = formData.get(`frame-${slot.sequence}`);
    if (!(value instanceof File)) {
      return errorResponse(
        `Capture frame ${slot.sequence + 1} is missing.`,
        400,
        "MISSING_FRAME",
      );
    }
    if (!acceptedImageTypes.has(value.type) || value.size === 0) {
      return errorResponse(
        `Capture frame ${slot.sequence + 1} is not a supported image.`,
        415,
        "INVALID_FRAME_TYPE",
      );
    }
    if (value.size > MAX_FRAME_BYTES) {
      return errorResponse(
        `Capture frame ${slot.sequence + 1} is too large.`,
        413,
        "FRAME_TOO_LARGE",
      );
    }

    totalBytes += value.size;
    if (totalBytes > MAX_CAPTURE_BYTES) {
      return errorResponse("The capture package is too large.", 413, "CAPTURE_TOO_LARGE");
    }

    const bracketValue = formData.get(`bracket-${slot.sequence}`);
    let bracket: Buffer | undefined;
    if (bracketValue instanceof File) {
      if (!acceptedImageTypes.has(bracketValue.type) || bracketValue.size === 0) {
        return errorResponse(
          `The exposure bracket for frame ${slot.sequence + 1} is not a supported image.`,
          415,
          "INVALID_FRAME_TYPE",
        );
      }
      if (bracketValue.size > MAX_FRAME_BYTES) {
        return errorResponse(
          `The exposure bracket for frame ${slot.sequence + 1} is too large.`,
          413,
          "FRAME_TOO_LARGE",
        );
      }
      totalBytes += bracketValue.size;
      if (totalBytes > MAX_CAPTURE_BYTES) {
        return errorResponse("The capture package is too large.", 413, "CAPTURE_TOO_LARGE");
      }
      bracket = Buffer.from(await bracketValue.arrayBuffer());
    }

    frames.push({
      sequence: slot.sequence,
      band: slot.band,
      column: slot.column,
      image: Buffer.from(await value.arrayBuffer()),
      zoom: parseZoom(formData.get(`zoom-${slot.sequence}`)),
      imu: parseOrientation(formData.get(`imu-${slot.sequence}`)),
      bracket,
      mimeType: value.type as ServerPanoramaFrame["mimeType"],
    });
  }

  try {
    const { panorama, report, width, height } = await processRoomPanorama(frames);
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

function parseZoom(value: FormDataEntryValue | null) {
  const zoom = typeof value === "string" ? Number(value) : 1;
  return Number.isFinite(zoom) && zoom >= 0.5 && zoom <= 2 ? zoom : 1;
}

function parseOrientation(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length > 200) return undefined;
  try {
    const candidate = JSON.parse(value) as { alpha?: unknown; beta?: unknown; gamma?: unknown };
    const alpha = Number(candidate.alpha);
    const beta = Number(candidate.beta);
    const gamma = Number(candidate.gamma);
    return Number.isFinite(alpha) && Number.isFinite(beta) && Number.isFinite(gamma)
      ? { alpha, beta, gamma }
      : undefined;
  } catch {
    return undefined;
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
