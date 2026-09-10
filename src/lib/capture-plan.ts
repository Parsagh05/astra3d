import type { CaptureBandId, CaptureSlot } from "@/types/capture";

/**
 * Headings photographed per sweep.  Twelve keeps at least 40% overlap between
 * neighbours on every phone we have measured - a narrow 3:4 crop sits near
 * 53 degrees and an ultrawide near 90 - where eight left the narrow cameras
 * under 25% and too thin to align across a plain wall.
 */
export const CAPTURE_COLUMNS = 12;

/**
 * Tilt of the two outer sweeps, in degrees.
 *
 * A frame reaches `pitch + vFOV/2`, so the tilt decides how much ceiling and
 * floor a sweep photographs.  The former 35° left a 21° cap at each pole that
 * no photograph ever covered; it was smoothly filled from the nearest ring,
 * which reads as a smear in any room whose ceiling or floor carries detail.
 *
 * 50° closes that cap entirely on a typical 4:3 phone and an ultrawide, and
 * cuts it to 6° on the narrowest 3:4 crop.  Tilting further would close the
 * last 6° but costs cross-band overlap, which is what the eye-level ring is
 * matched against: measured on a bare-walled room with no learned matcher,
 * 50° already drops aligned pairs from 24/36 to 19/36, and 58° would leave
 * only 14% overlap there.  On a normally textured room 50° still aligns
 * 36/36 with no guided placement at all.
 */
export const BAND_TILT_DEGREES = 50;

export const CAPTURE_BANDS: readonly {
  id: CaptureBandId;
  label: string;
  instruction: string;
  /** Camera pitch for this sweep, in degrees, positive toward the ceiling. */
  pitch: number;
  tilt: string;
}[] = [
  {
    id: "middle",
    label: "Eye level",
    instruction: "Keep the phone upright and point straight ahead.",
    pitch: 0,
    tilt: "0°",
  },
  {
    id: "upper",
    label: "Upper room",
    instruction: `Tilt upward about ${BAND_TILT_DEGREES}° while keeping the same standing point.`,
    pitch: BAND_TILT_DEGREES,
    tilt: `+${BAND_TILT_DEGREES}°`,
  },
  {
    id: "lower",
    label: "Lower room",
    instruction: `Tilt downward about ${BAND_TILT_DEGREES}° without moving from the center.`,
    pitch: -BAND_TILT_DEGREES,
    tilt: `−${BAND_TILT_DEGREES}°`,
  },
] as const;

export const TOTAL_CAPTURE_SLOTS = CAPTURE_COLUMNS * CAPTURE_BANDS.length;
export type CaptureExtent = "quick" | "full";

export function getCaptureBands(extent: CaptureExtent) {
  return extent === "quick" ? CAPTURE_BANDS.slice(0, 1) : CAPTURE_BANDS;
}

export function buildCaptureSlots(extent: CaptureExtent = "full"): CaptureSlot[] {
  return getCaptureBands(extent).flatMap((band, bandIndex) =>
    Array.from({ length: CAPTURE_COLUMNS }, (_, column) => ({
      id: `${band.id}-${column}`,
      band: band.id,
      column,
      sequence: bandIndex * CAPTURE_COLUMNS + column,
      yaw: column * (360 / CAPTURE_COLUMNS),
    })),
  );
}

export function getCaptureProgress(frameCount: number, total = TOTAL_CAPTURE_SLOTS) {
  return Math.round((frameCount / total) * 100);
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
