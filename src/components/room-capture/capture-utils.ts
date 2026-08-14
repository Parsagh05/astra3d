import type {
  CaptureBandId,
  CapturedFrame,
  CaptureSlot,
} from "@/types/capture";

export const CAPTURE_COLUMNS = 8;
export const CAPTURE_BANDS: readonly {
  id: CaptureBandId;
  label: string;
  instruction: string;
  tilt: string;
}[] = [
  {
    id: "middle",
    label: "Eye level",
    instruction: "Keep the phone upright and point straight ahead.",
    tilt: "0°",
  },
  {
    id: "upper",
    label: "Upper room",
    instruction: "Tilt upward about 35° while keeping the same standing point.",
    tilt: "+35°",
  },
  {
    id: "lower",
    label: "Lower room",
    instruction: "Tilt downward about 35° without moving from the center.",
    tilt: "−35°",
  },
] as const;

export const TOTAL_CAPTURE_SLOTS = CAPTURE_COLUMNS * CAPTURE_BANDS.length;

export function buildCaptureSlots(): CaptureSlot[] {
  return CAPTURE_BANDS.flatMap((band, bandIndex) =>
    Array.from({ length: CAPTURE_COLUMNS }, (_, column) => ({
      id: `${band.id}-${column}`,
      band: band.id,
      column,
      sequence: bandIndex * CAPTURE_COLUMNS + column,
      yaw: column * (360 / CAPTURE_COLUMNS),
    })),
  );
}

export function getCaptureProgress(frameCount: number) {
  return Math.round((frameCount / TOTAL_CAPTURE_SLOTS) * 100);
}

/** Returns the shortest signed change between two compass headings. */
export function getSignedAngleDelta(current: number, previous: number) {
  return ((current - previous + 540) % 360) - 180;
}

export function getBandRow(band: CaptureBandId) {
  if (band === "upper") return 0;
  if (band === "middle") return 1;
  return 2;
}

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

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("One of the room photos could not be read."));
    image.src = source;
  });
}

function applyTileMask(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  featherX: number,
  featherTop: number,
  featherBottom: number,
) {
  context.globalCompositeOperation = "destination-in";

  const horizontal = context.createLinearGradient(0, 0, width, 0);
  horizontal.addColorStop(0, "rgba(0,0,0,0)");
  horizontal.addColorStop(featherX / width, "rgba(0,0,0,1)");
  horizontal.addColorStop(1 - featherX / width, "rgba(0,0,0,1)");
  horizontal.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = horizontal;
  context.fillRect(0, 0, width, height);

  if (featherTop > 0 || featherBottom > 0) {
    const vertical = context.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, featherTop > 0 ? "rgba(0,0,0,0)" : "rgba(0,0,0,1)");
    if (featherTop > 0) {
      vertical.addColorStop(featherTop / height, "rgba(0,0,0,1)");
    }
    if (featherBottom > 0) {
      vertical.addColorStop(1 - featherBottom / height, "rgba(0,0,0,1)");
    }
    vertical.addColorStop(1, featherBottom > 0 ? "rgba(0,0,0,0)" : "rgba(0,0,0,1)");
    context.fillStyle = vertical;
    context.fillRect(0, 0, width, height);
  }

  context.globalCompositeOperation = "source-over";
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The panorama could not be exported."))),
      "image/jpeg",
      0.88,
    );
  });
}

export async function stitchRoomPanorama(
  frames: readonly CapturedFrame[],
  onProgress?: (progress: number) => void,
) {
  if (frames.length !== TOTAL_CAPTURE_SLOTS) {
    throw new Error(`Capture all ${TOTAL_CAPTURE_SLOTS} room positions before building the 360.`);
  }

  const width = 4096;
  const height = 2048;
  const columnWidth = width / CAPTURE_COLUMNS;
  const rowHeight = height / CAPTURE_BANDS.length;
  const overlapX = 96;
  const overlapY = 112;
  const panorama = createCanvas(width, height);
  const panoramaContext = getCanvasContext(panorama);
  panoramaContext.fillStyle = "#07101b";
  panoramaContext.fillRect(0, 0, width, height);

  const ordered = [...frames].sort((a, b) => a.sequence - b.sequence);

  for (let index = 0; index < ordered.length; index += 1) {
    const frame = ordered[index];
    const image = await loadImage(frame.dataUrl);
    const row = getBandRow(frame.band);
    const tileWidth = Math.ceil(columnWidth + overlapX);
    const tileHeight = Math.ceil(
      rowHeight + (row === 1 ? overlapY : overlapY / 2),
    );
    const tile = createCanvas(tileWidth, tileHeight);
    const tileContext = getCanvasContext(tile);
    drawCover(
      tileContext,
      image,
      image.naturalWidth,
      image.naturalHeight,
      tileWidth,
      tileHeight,
    );

    applyTileMask(
      tileContext,
      tileWidth,
      tileHeight,
      overlapX / 2,
      row === 0 ? 0 : overlapY / 2,
      row === 2 ? 0 : overlapY / 2,
    );

    const x = frame.column * columnWidth - overlapX / 2;
    const y = row * rowHeight - (row === 0 ? 0 : overlapY / 2);
    panoramaContext.drawImage(tile, x, y);
    if (x < 0) panoramaContext.drawImage(tile, x + width, y);
    if (x + tileWidth > width) panoramaContext.drawImage(tile, x - width, y);

    onProgress?.(Math.round(((index + 1) / ordered.length) * 100));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  return canvasToBlob(panorama);
}
