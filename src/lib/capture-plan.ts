import type { CaptureBandId, CaptureSlot } from "@/types/capture";

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

export type PitchDirection = -1 | 1;

/** Learns which beta direction the current phone reports while tilting up. */
export function getPitchDirection(currentBeta: number, baselineBeta: number): PitchDirection {
  return currentBeta >= baselineBeta ? 1 : -1;
}

/** Converts device beta rotation into rear-camera pitch after sign calibration. */
export function getRelativeCameraPitch(
  currentBeta: number,
  baselineBeta: number,
  direction: PitchDirection = -1,
) {
  const pitch = (currentBeta - baselineBeta) * direction;
  return pitch === 0 ? 0 : pitch;
}

export function getBandRow(band: CaptureBandId) {
  if (band === "upper") return 0;
  if (band === "middle") return 1;
  return 2;
}
