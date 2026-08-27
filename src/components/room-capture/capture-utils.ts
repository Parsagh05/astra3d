export {
  buildCaptureSlots,
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  getBandRow,
  getCaptureProgress,
  getPitchDirection,
  getRelativeCameraPitch,
  getSignedAngleDelta,
  TOTAL_CAPTURE_SLOTS,
} from "@/lib/capture-plan";

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getCanvasContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("This browser cannot prepare room images.");
  return context;
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality = 0.84) {
  return canvas.toDataURL("image/jpeg", quality);
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  zoom = 1,
) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let cropX = 0;
  let cropY = 0;

  if (sourceRatio > targetRatio) {
    cropWidth = sourceHeight * targetRatio;
    cropX = (sourceWidth - cropWidth) / 2;
  } else {
    cropHeight = sourceWidth / targetRatio;
    cropY = (sourceHeight - cropHeight) / 2;
  }

  const safeZoom = Math.max(1, Math.min(1.4, zoom));
  cropWidth /= safeZoom;
  cropHeight /= safeZoom;
  cropX = (sourceWidth - cropWidth) / 2;
  cropY = (sourceHeight - cropHeight) / 2;

  context.drawImage(
    source,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
}

/**
 * Variance of a 3×3 Laplacian over a stride-sampled grayscale of the image.
 * High values mean crisp detail; motion blur collapses the response. A fully
 * uniform image also scores near zero, so callers must treat "no detail" as
 * unknown rather than blurry.
 */
export function estimateSharpness(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  stride = 6,
) {
  const sampleWidth = Math.floor(width / stride);
  const sampleHeight = Math.floor(height / stride);
  if (sampleWidth < 3 || sampleHeight < 3) return 0;

  const gray = new Float32Array(sampleWidth * sampleHeight);
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const offset = (y * stride * width + x * stride) * 4;
      gray[y * sampleWidth + x] =
        0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
    }
  }

  let sum = 0;
  let sumSquares = 0;
  const count = (sampleWidth - 2) * (sampleHeight - 2);
  for (let y = 1; y < sampleHeight - 1; y += 1) {
    for (let x = 1; x < sampleWidth - 1; x += 1) {
      const index = y * sampleWidth + x;
      const response =
        gray[index - sampleWidth] +
        gray[index + sampleWidth] +
        gray[index - 1] +
        gray[index + 1] -
        4 * gray[index];
      sum += response;
      sumSquares += response * response;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

export type CaptureLockCapabilities = MediaTrackCapabilities & {
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  focusMode?: string[];
};

export type CaptureLockSettings = MediaTrackSettings & {
  exposureTime?: number;
  iso?: number;
  colorTemperature?: number;
  focusDistance?: number;
};

/**
 * Builds an `advanced` constraint set that freezes exposure, white balance,
 * and focus at their current values so every still in the sweep matches.
 * Returns null when the camera exposes none of the manual modes.
 */
export function buildCaptureLockConstraints(
  capabilities: CaptureLockCapabilities | undefined,
  settings: CaptureLockSettings | undefined,
): MediaTrackConstraintSet | null {
  if (!capabilities) return null;
  const lock: Record<string, unknown> = {};
  if (capabilities.exposureMode?.includes("manual")) {
    lock.exposureMode = "manual";
    if (Number.isFinite(settings?.exposureTime)) lock.exposureTime = settings?.exposureTime;
    if (Number.isFinite(settings?.iso)) lock.iso = settings?.iso;
  }
  if (capabilities.whiteBalanceMode?.includes("manual")) {
    lock.whiteBalanceMode = "manual";
    if (Number.isFinite(settings?.colorTemperature)) lock.colorTemperature = settings?.colorTemperature;
  }
  if (capabilities.focusMode?.includes("manual")) {
    lock.focusMode = "manual";
    if (Number.isFinite(settings?.focusDistance)) lock.focusDistance = settings?.focusDistance;
  }
  return Object.keys(lock).length > 0 ? (lock as MediaTrackConstraintSet) : null;
}

export type LiveStillCapture = {
  dataUrl: string;
  /** Laplacian-variance sharpness of the saved crop; 0 when unmeasurable. */
  sharpness: number;
};

export function captureLiveStill(video: HTMLVideoElement, zoom = 1): LiveStillCapture {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("The camera is still starting. Try again in a moment.");
  }

  const canvas = createCanvas(900, 1200);
  const context = getCanvasContext(canvas);
  drawCover(
    context,
    video,
    video.videoWidth,
    video.videoHeight,
    canvas.width,
    canvas.height,
    zoom,
  );
  let sharpness = 0;
  try {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    sharpness = estimateSharpness(pixels.data, pixels.width, pixels.height);
  } catch {
    // A blocked read only disables the optional steadiness check.
  }
  return { dataUrl: canvasToDataUrl(canvas), sharpness };
}
