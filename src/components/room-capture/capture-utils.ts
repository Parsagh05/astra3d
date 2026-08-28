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
  exposureTime?: { min?: number; max?: number; step?: number };
};

export type CaptureLockSettings = MediaTrackSettings & {
  exposureMode?: string;
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

/** Portrait 3:4 crop shared by every capture path. */
const STILL_ASPECT = 3 / 4;
/** Upper bound on saved still height; keeps 24-frame uploads laptop-friendly. */
const MAX_STILL_HEIGHT = 2400;
/** Full-resolution photo requests are clamped to bound decode memory. */
const MAX_PHOTO_DIMENSION = 4096;

/** Source pixels available after the cover crop and software zoom. */
function croppedSourceHeight(sourceWidth: number, sourceHeight: number, zoom: number) {
  const cropHeight = Math.min(sourceHeight, sourceWidth / STILL_ASPECT);
  return cropHeight / Math.max(1, Math.min(1.4, zoom));
}

function finishStill(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): LiveStillCapture {
  let sharpness = 0;
  try {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    // Sample roughly the same 150-wide grid at every resolution so the
    // sharpness scale stays comparable between photo and preview captures.
    const stride = Math.max(1, Math.round(pixels.width / 150));
    sharpness = estimateSharpness(pixels.data, pixels.width, pixels.height, stride);
  } catch {
    // A blocked read only disables the optional steadiness check.
  }
  return { dataUrl: canvasToDataUrl(canvas), sharpness };
}

function drawStill(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
): LiveStillCapture {
  const targetHeight = Math.round(
    Math.min(MAX_STILL_HEIGHT, croppedSourceHeight(sourceWidth, sourceHeight, zoom)),
  );
  const canvas = createCanvas(Math.round(targetHeight * STILL_ASPECT), targetHeight);
  const context = getCanvasContext(canvas);
  drawCover(context, source, sourceWidth, sourceHeight, canvas.width, canvas.height, zoom);
  return finishStill(canvas, context);
}

export function captureLiveStill(video: HTMLVideoElement, zoom = 1): LiveStillCapture {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("The camera is still starting. Try again in a moment.");
  }
  return drawStill(video, video.videoWidth, video.videoHeight, zoom);
}

type PhotoRange = { min?: number; max?: number };
type ImageCaptureLike = {
  takePhoto: (settings?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>;
  getPhotoCapabilities?: () => Promise<{ imageWidth?: PhotoRange; imageHeight?: PhotoRange }>;
};
type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike;

async function capturePhotoStill(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  zoom: number,
): Promise<LiveStillCapture | null> {
  const ImageCaptureCtor = (window as Window & { ImageCapture?: ImageCaptureConstructor }).ImageCapture;
  if (!ImageCaptureCtor) return null;

  const imageCapture = new ImageCaptureCtor(track);
  let photo: Blob | null = null;
  try {
    const capabilities = await imageCapture.getPhotoCapabilities?.();
    const maxWidth = Number(capabilities?.imageWidth?.max);
    const maxHeight = Number(capabilities?.imageHeight?.max);
    if (Number.isFinite(maxWidth) && Number.isFinite(maxHeight)) {
      photo = await imageCapture.takePhoto({
        imageWidth: Math.min(maxWidth, MAX_PHOTO_DIMENSION),
        imageHeight: Math.min(maxHeight, MAX_PHOTO_DIMENSION),
      });
    }
  } catch {
    photo = null;
  }
  if (!photo) photo = await imageCapture.takePhoto();

  const bitmap = await createImageBitmap(photo);
  try {
    // Some cameras answer with a photo smaller than the live preview; the
    // preview grab is the better source in that case.
    if (bitmap.width * bitmap.height <= video.videoWidth * video.videoHeight) return null;
    return drawStill(bitmap, bitmap.width, bitmap.height, zoom);
  } finally {
    bitmap.close();
  }
}

/**
 * Captures one still at the best quality the device offers: a real ISP photo
 * through `ImageCapture.takePhoto()` when available, otherwise the familiar
 * live-preview canvas grab.
 */
export async function captureBestStill(
  video: HTMLVideoElement,
  track: MediaStreamTrack | undefined,
  zoom = 1,
): Promise<LiveStillCapture> {
  if (track) {
    try {
      const photo = await capturePhotoStill(video, track, zoom);
      if (photo) return photo;
    } catch {
      // Unsupported or failed photo pipelines fall back to the preview grab.
    }
  }
  return captureLiveStill(video, zoom);
}

export type BracketExposurePlan = {
  /** The locked exposure time to restore after the dark still. */
  current: number;
  /** The shorter exposure used to recover window highlights. */
  dark: number;
};

/**
 * Decides whether a highlight-recovery bracket is possible: the sweep must be
 * running on a manual exposure lock with enough headroom to shorten it 4×.
 */
export function chooseBracketExposure(
  capabilities: CaptureLockCapabilities | undefined,
  settings: CaptureLockSettings | undefined,
): BracketExposurePlan | null {
  if (settings?.exposureMode !== "manual") return null;
  const current = Number(settings?.exposureTime);
  if (!Number.isFinite(current) || current <= 0) return null;
  const minimum = Number(capabilities?.exposureTime?.min);
  const dark = Math.max(Number.isFinite(minimum) ? minimum : current / 8, current / 4);
  if (dark >= current * 0.7) return null;
  return { current, dark };
}

/**
 * Takes one deliberately under-exposed companion still for Mertens fusion on
 * the laptop, then restores the locked exposure. Returns null whenever the
 * camera cannot bracket, so single-exposure capture continues unchanged.
 */
export async function captureExposureBracket(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  zoom = 1,
): Promise<string | null> {
  const plan = chooseBracketExposure(
    track.getCapabilities?.() as CaptureLockCapabilities | undefined,
    track.getSettings?.() as CaptureLockSettings | undefined,
  );
  if (!plan) return null;
  try {
    await track.applyConstraints({
      advanced: [{ exposureTime: plan.dark } as MediaTrackConstraintSet],
    });
    // Give the camera pipeline a moment to apply the shorter exposure.
    await new Promise((resolve) => window.setTimeout(resolve, 280));
    const dark = await captureBestStill(video, track, zoom);
    return dark.dataUrl;
  } catch {
    return null;
  } finally {
    try {
      await track.applyConstraints({
        advanced: [{ exposureTime: plan.current } as MediaTrackConstraintSet],
      });
    } catch {
      // The sweep continues on the darker lock rather than aborting capture.
    }
  }
}
