export {
  buildCaptureSlots,
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  getBandRow,
  getCaptureProgress,
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

export function captureLiveStill(video: HTMLVideoElement, zoom = 1) {
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
  return canvasToDataUrl(canvas);
}
