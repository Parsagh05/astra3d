import sharp, { type OverlayOptions } from "sharp";

import {
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  getBandRow,
  TOTAL_CAPTURE_SLOTS,
} from "@/lib/capture-plan";
import type { CaptureBandId } from "@/types/capture";

export const PANORAMA_WIDTH = 3072;
export const PANORAMA_HEIGHT = 1536;
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 80 * 1024 * 1024;

export type ServerPanoramaFrame = {
  sequence: number;
  band: CaptureBandId;
  column: number;
  image: Buffer;
};

type PanoramaOptions = {
  width?: number;
  height?: number;
  quality?: number;
};

const maskCache = new Map<string, Buffer>();

function createFeatherMask(
  width: number,
  height: number,
  featherX: number,
  featherTop: number,
  featherBottom: number,
) {
  const key = `${width}:${height}:${featherX}:${featherTop}:${featherBottom}`;
  const cached = maskCache.get(key);
  if (cached) return cached;

  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const verticalStart = featherTop > 0 ? Math.min(1, y / featherTop) : 1;
    const verticalEnd = featherBottom > 0
      ? Math.min(1, (height - 1 - y) / featherBottom)
      : 1;
    const verticalAlpha = Math.max(0, Math.min(verticalStart, verticalEnd));

    for (let x = 0; x < width; x += 1) {
      const horizontalStart = Math.min(1, x / featherX);
      const horizontalEnd = Math.min(1, (width - 1 - x) / featherX);
      const alpha = Math.round(
        255 * verticalAlpha * Math.max(0, Math.min(horizontalStart, horizontalEnd)),
      );
      const offset = (y * width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = alpha;
    }
  }

  maskCache.set(key, pixels);
  return pixels;
}

async function prepareTile(
  frame: ServerPanoramaFrame,
  width: number,
  height: number,
  featherX: number,
  featherTop: number,
  featherBottom: number,
) {
  const mask = createFeatherMask(
    width,
    height,
    featherX,
    featherTop,
    featherBottom,
  );

  return sharp(frame.image, {
    failOn: "error",
    limitInputPixels: 24_000_000,
    sequentialRead: true,
  })
    .rotate()
    .resize(width, height, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .composite([
      {
        input: mask,
        raw: { width, height, channels: 4 },
        blend: "dest-in",
      },
    ])
    .png({ compressionLevel: 2 })
    .toBuffer();
}

async function clipTile(
  input: Buffer,
  tileWidth: number,
  tileHeight: number,
  x: number,
  y: number,
  panoramaWidth: number,
  panoramaHeight: number,
): Promise<OverlayOptions | null> {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(panoramaWidth, x + tileWidth);
  const bottom = Math.min(panoramaHeight, y + tileHeight);
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) return null;
  if (width === tileWidth && height === tileHeight) {
    return { input, left, top, blend: "over" };
  }

  const clipped = await sharp(input)
    .extract({
      left: left - x,
      top: top - y,
      width,
      height,
    })
    .png({ compressionLevel: 2 })
    .toBuffer();

  return { input: clipped, left, top, blend: "over" };
}

function assertCapturePlan(frames: readonly ServerPanoramaFrame[]) {
  if (frames.length !== TOTAL_CAPTURE_SLOTS) {
    throw new Error(`Expected ${TOTAL_CAPTURE_SLOTS} capture frames.`);
  }

  const sequences = new Set<number>();
  for (const frame of frames) {
    const expectedBand = CAPTURE_BANDS[Math.floor(frame.sequence / CAPTURE_COLUMNS)]?.id;
    const expectedColumn = frame.sequence % CAPTURE_COLUMNS;
    if (
      !Number.isInteger(frame.sequence) ||
      frame.sequence < 0 ||
      frame.sequence >= TOTAL_CAPTURE_SLOTS ||
      frame.band !== expectedBand ||
      frame.column !== expectedColumn ||
      sequences.has(frame.sequence)
    ) {
      throw new Error("The capture manifest is incomplete or out of order.");
    }
    sequences.add(frame.sequence);
  }
}

export async function composeRoomPanorama(
  frames: readonly ServerPanoramaFrame[],
  options: PanoramaOptions = {},
) {
  assertCapturePlan(frames);

  const width = options.width ?? PANORAMA_WIDTH;
  const height = options.height ?? PANORAMA_HEIGHT;
  const quality = options.quality ?? 88;
  if (width < 640 || height < 320 || width !== height * 2) {
    throw new Error("The panorama output must use a supported 2:1 size.");
  }

  const columnWidth = width / CAPTURE_COLUMNS;
  const rowHeight = height / CAPTURE_BANDS.length;
  const overlapX = Math.round(width * 0.024);
  const overlapY = Math.round(height * 0.055);
  const overlays: OverlayOptions[] = [];
  const ordered = [...frames].sort((a, b) => a.sequence - b.sequence);

  for (const frame of ordered) {
    const row = getBandRow(frame.band);
    const tileWidth = Math.ceil(columnWidth + overlapX);
    const tileHeight = Math.ceil(
      rowHeight + (row === 1 ? overlapY : overlapY / 2),
    );
    const tile = await prepareTile(
      frame,
      tileWidth,
      tileHeight,
      overlapX / 2,
      row === 0 ? 0 : overlapY / 2,
      row === 2 ? 0 : overlapY / 2,
    );
    const x = Math.round(frame.column * columnWidth - overlapX / 2);
    const y = Math.round(row * rowHeight - (row === 0 ? 0 : overlapY / 2));

    for (const wrappedX of [x - width, x, x + width]) {
      const overlay = await clipTile(
        tile,
        tileWidth,
        tileHeight,
        wrappedX,
        y,
        width,
        height,
      );
      if (overlay) overlays.push(overlay);
    }
  }

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 7, g: 16, b: 27 },
    },
  })
    .composite(overlays)
    .jpeg({
      quality,
      chromaSubsampling: "4:4:4",
      mozjpeg: true,
    })
    .toBuffer();
}
