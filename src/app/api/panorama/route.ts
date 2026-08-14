import { buildCaptureSlots, TOTAL_CAPTURE_SLOTS } from "@/lib/capture-plan";
import {
  composeRoomPanorama,
  MAX_CAPTURE_BYTES,
  MAX_FRAME_BYTES,
  PANORAMA_HEIGHT,
  PANORAMA_WIDTH,
  type ServerPanoramaFrame,
} from "@/server/panorama-processor";

export const runtime = "nodejs";
export const maxDuration = 120;

const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const PROCESSOR_CLIENT = "room-studio-v1";
let activeJobs = 0;

function errorResponse(message: string, status: number, code: string) {
  return Response.json(
    { error: message, code },
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
      processor: "sharp",
      expectedFrames: TOTAL_CAPTURE_SLOTS,
      output: { width: PANORAMA_WIDTH, height: PANORAMA_HEIGHT },
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

    frames.push({
      sequence: slot.sequence,
      band: slot.band,
      column: slot.column,
      image: Buffer.from(await value.arrayBuffer()),
    });
  }

  try {
    const panorama = await composeRoomPanorama(frames);
    return new Response(new Uint8Array(panorama), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'inline; filename="astra3d-room-360.jpg"',
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "X-Astra3D-Height": String(PANORAMA_HEIGHT),
        "X-Astra3D-Processor": "laptop-sharp",
        "X-Astra3D-Width": String(PANORAMA_WIDTH),
      },
    });
  } catch (error) {
    console.error("Astra3D panorama processing failed", error);
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
