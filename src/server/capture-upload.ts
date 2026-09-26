import { buildCaptureSlots, type CaptureExtent } from "@/lib/capture-plan";
import {
  MAX_CAPTURE_BYTES,
  MAX_FRAME_BYTES,
  type ServerPanoramaFrame,
} from "@/server/panorama-processor";

const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ParsedCaptureUpload = {
  name: string;
  extent: CaptureExtent;
  frames: ServerPanoramaFrame[];
};

export class CaptureUploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "CaptureUploadError";
    this.status = status;
    this.code = code;
  }
}

function parseZoom(value: FormDataEntryValue | null) {
  const zoom = typeof value === "string" ? Number(value) : 1;
  return Number.isFinite(zoom) && zoom >= 0.5 && zoom <= 2 ? zoom : 1;
}

type OrientationCandidate = { alpha?: unknown; beta?: unknown; gamma?: unknown };

export function parseOrientation(value: unknown) {
  let candidate: OrientationCandidate | null = null;
  if (typeof value === "string") {
    if (value.length > 200) return undefined;
    try {
      candidate = JSON.parse(value) as OrientationCandidate;
    } catch {
      return undefined;
    }
  } else if (value && typeof value === "object") {
    candidate = value as OrientationCandidate;
  }
  if (!candidate) return undefined;
  const alpha = Number(candidate.alpha);
  const beta = Number(candidate.beta);
  const gamma = Number(candidate.gamma);
  return Number.isFinite(alpha) && Number.isFinite(beta) && Number.isFinite(gamma)
    ? { alpha, beta, gamma }
    : undefined;
}

/**
 * Reads the multipart capture package the studio (and the test maker) send:
 * `frame-N` stills, optional `bracket-N`, `zoom-N` and `imu-N` per slot.
 */
export async function parseCaptureUpload(request: Request, nameField = "room-name"): Promise<ParsedCaptureUpload> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BYTES) {
    throw new CaptureUploadError("The capture package is too large.", 413, "CAPTURE_TOO_LARGE");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new CaptureUploadError("The capture package could not be read.", 400, "INVALID_FORM_DATA");
  }

  // Older clients omit the mode and still submit all three bands.
  const extent = formData.get("capture-mode") ?? "full";
  if (extent !== "quick" && extent !== "full") {
    throw new CaptureUploadError("Choose quick or full room capture.", 400, "INVALID_CAPTURE_MODE");
  }
  const nameValue = formData.get(nameField);
  const name = typeof nameValue === "string" ? nameValue : "My room";

  const frames: ServerPanoramaFrame[] = [];
  let totalBytes = 0;
  for (const slot of buildCaptureSlots(extent)) {
    const value = formData.get(`frame-${slot.sequence}`);
    if (!(value instanceof File)) {
      throw new CaptureUploadError(`Capture frame ${slot.sequence + 1} is missing.`, 400, "MISSING_FRAME");
    }
    if (!acceptedImageTypes.has(value.type) || value.size === 0) {
      throw new CaptureUploadError(
        `Capture frame ${slot.sequence + 1} is not a supported image.`,
        415,
        "INVALID_FRAME_TYPE",
      );
    }
    if (value.size > MAX_FRAME_BYTES) {
      throw new CaptureUploadError(`Capture frame ${slot.sequence + 1} is too large.`, 413, "FRAME_TOO_LARGE");
    }
    totalBytes += value.size;
    if (totalBytes > MAX_CAPTURE_BYTES) {
      throw new CaptureUploadError("The capture package is too large.", 413, "CAPTURE_TOO_LARGE");
    }

    const bracketValue = formData.get(`bracket-${slot.sequence}`);
    let bracket: Buffer | undefined;
    if (bracketValue instanceof File) {
      if (!acceptedImageTypes.has(bracketValue.type) || bracketValue.size === 0) {
        throw new CaptureUploadError(
          `The exposure bracket for frame ${slot.sequence + 1} is not a supported image.`,
          415,
          "INVALID_FRAME_TYPE",
        );
      }
      if (bracketValue.size > MAX_FRAME_BYTES) {
        throw new CaptureUploadError(
          `The exposure bracket for frame ${slot.sequence + 1} is too large.`,
          413,
          "FRAME_TOO_LARGE",
        );
      }
      totalBytes += bracketValue.size;
      if (totalBytes > MAX_CAPTURE_BYTES) {
        throw new CaptureUploadError("The capture package is too large.", 413, "CAPTURE_TOO_LARGE");
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

  return { name, extent, frames };
}
