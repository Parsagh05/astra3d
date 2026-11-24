/**
 * Guidance while taking photos for a 3D scan.
 *
 * A 3D reconstruction needs every surface photographed from several
 * *positions*: standing still and turning only gives a panorama.  So the
 * person takes a small step between photos, and each photo should overlap
 * the previous one by about two thirds, which means turning no more than
 * ~30 degrees between shots.  The phone's motion sensors tell us which way
 * each photo looked (12 headings x 3 heights, like the video recorder) and
 * how far the camera turned since the last photo; they cannot measure the
 * steps themselves, so the hints keep reminding.
 */

import { rowForPitch, SCAN_HEADINGS, SCAN_ROWS, yawPitch, type ScanRow } from "@/lib/scan-coverage";

export const MIN_SCAN_PHOTOS = 20;
export const RECOMMENDED_SCAN_PHOTOS = 60;
/** Matches the pipeline's default frame budget (ASTRA3D_SPLAT_MAX_FRAMES). */
export const MAX_SCAN_PHOTOS = 180;
/** Turning further than this between photos leaves too little overlap. */
export const MAX_TURN_BETWEEN_PHOTOS = 35;
/** A direction counts as covered once photographed from this many spots. */
const PHOTOS_PER_CELL = 2;

export type PhotoGuide = {
  /** Photos per [row][heading]. */
  counts: number[][];
  /** Heading of the first photo, so heading 0 is where capture began. */
  origin: number | null;
  lastForward: [number, number, number] | null;
  /** Degrees turned between the last two photos with sensor data. */
  lastTurn: number | null;
  photos: number;
};

export function createPhotoGuide(): PhotoGuide {
  return {
    counts: SCAN_ROWS.map(() => Array.from({ length: SCAN_HEADINGS }, () => 0)),
    origin: null,
    lastForward: null,
    lastTurn: null,
    photos: 0,
  };
}

function headingIndex(yaw: number, origin: number) {
  const relative = (((yaw - origin) % 360) + 360 + 180 / SCAN_HEADINGS) % 360;
  return Math.floor(relative / (360 / SCAN_HEADINGS)) % SCAN_HEADINGS;
}

function angleBetween(a: readonly number[], b: readonly number[]) {
  const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

/** Records one photo; `forward` is the camera direction, or null without motion sensors. */
export function addPhoto(guide: PhotoGuide, forward: [number, number, number] | null): PhotoGuide {
  if (!forward) return { ...guide, photos: guide.photos + 1, lastTurn: null };
  const { yaw, pitch } = yawPitch(forward);
  const origin = guide.origin ?? yaw;
  const counts = guide.counts.map((row) => row.slice());
  counts[SCAN_ROWS.indexOf(rowForPitch(pitch))][headingIndex(yaw, origin)] += 1;
  return {
    counts,
    origin,
    lastForward: forward,
    lastTurn: guide.lastForward ? angleBetween(guide.lastForward, forward) : null,
    photos: guide.photos + 1,
  };
}

/** Rebuilds the guide after "undo": replays the remaining photos' directions. */
export function replayPhotos(directions: ReadonlyArray<[number, number, number] | null>): PhotoGuide {
  return directions.reduce<PhotoGuide>((guide, forward) => addPhoto(guide, forward), createPhotoGuide());
}

export function photoCoveredCells(guide: PhotoGuide) {
  return guide.counts.map((row) => row.map((count) => count >= PHOTOS_PER_CELL));
}

export function photoCoverageFraction(guide: PhotoGuide) {
  const cells = photoCoveredCells(guide).flat();
  return cells.filter(Boolean).length / cells.length;
}

export type PhotoHint = { tone: "warn" | "info" | "good"; text: string };

/** The one thing the person should do before the next photo. */
export function photoHint(guide: PhotoGuide, hasMotion: boolean): PhotoHint {
  if (guide.photos === 0) {
    return { tone: "info", text: "Start in a corner. Take a photo, take one small step sideways, then take the next" };
  }
  if (guide.photos >= MAX_SCAN_PHOTOS) {
    return { tone: "good", text: `That is the maximum of ${MAX_SCAN_PHOTOS} photos. Tap Done to build the 3D room` };
  }
  if (guide.lastTurn !== null && guide.lastTurn > MAX_TURN_BETWEEN_PHOTOS) {
    return { tone: "warn", text: "Big turn: turn less between photos so each one overlaps the last" };
  }
  if (hasMotion) {
    const covered = photoCoveredCells(guide);
    const count = (row: ScanRow) => covered[SCAN_ROWS.indexOf(row)].filter(Boolean).length;
    if (count("level") < SCAN_HEADINGS * 0.75) {
      return { tone: "info", text: "Step sideways along the walls, one photo per step, at eye level" };
    }
    if (count("low") < SCAN_HEADINGS * 0.5) {
      return { tone: "info", text: "Now tilt down a little: floor and furniture, one step between photos" };
    }
    if (count("high") < SCAN_HEADINGS * 0.5) {
      return { tone: "info", text: "Now tilt up a little: ceiling and tops of the walls" };
    }
  }
  if (guide.photos < MIN_SCAN_PHOTOS) {
    return { tone: "info", text: `Keep going: step, photo, step, photo (at least ${MIN_SCAN_PHOTOS})` };
  }
  if (guide.photos < RECOMMENDED_SCAN_PHOTOS) {
    return { tone: "info", text: `Good. More photos from new spots give a better 3D room (aim for ${RECOMMENDED_SCAN_PHOTOS}+)` };
  }
  return { tone: "good", text: "Great coverage. Tap Done whenever you are ready" };
}

/**
 * True when a photo is far blurrier than the ones before it (the phone moved
 * while the shutter was open).  Scores of featureless views (a blank wall)
 * are near zero too, so nothing is rejected until the typical score is known.
 */
export function isBlurredPhoto(score: number, previousScores: readonly number[]) {
  const scores = previousScores.filter((value) => value > 0).slice(-15);
  if (scores.length < 3 || score <= 0) return false;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median > 20 && score < 0.35 * median;
}
