import { CAPTURE_COLUMNS, getSignedAngleDelta } from "@/lib/capture-plan";

/**
 * Field of view of one saved still: the portrait 3:4 crop of a typical phone
 * main camera (26 mm equivalent).  Only the live guide uses these numbers, to
 * draw targets and captured shots where they really are; the laptop stitcher
 * measures the true lens from the photos themselves.
 */
export const STILL_HORIZONTAL_FOV = 55.4;
export const STILL_VERTICAL_FOV = 70;

/**
 * Tracks where the phone points, as one continuous clockwise heading.
 *
 * The heading is measured from the direction the first sweep started in and
 * is never reset between sweeps.  Every band therefore photographs column N
 * at the same compass direction, which is what the stitcher expects when it
 * matches the tilted bands against eye level (it gives up beyond 25°).
 * Earlier builds restarted the heading at every band, so the upper and lower
 * sweeps began wherever the user happened to be facing.
 */
export type HeadingTracker = {
  /** Camera yaw, in degrees, that counts as heading zero. */
  origin: number | null;
  previous: number | null;
  /** Unwrapped degrees turned clockwise since the origin; may exceed 360. */
  heading: number;
};

export function createHeadingTracker(): HeadingTracker {
  return { origin: null, previous: null, heading: 0 };
}

export function resetHeadingTracker(tracker: HeadingTracker) {
  tracker.origin = null;
  tracker.previous = null;
  tracker.heading = 0;
}

/** Feeds one camera yaw sample and returns the continuous heading. */
export function advanceHeading(tracker: HeadingTracker, yaw: number) {
  if (tracker.origin === null || tracker.previous === null) {
    tracker.origin = yaw;
    tracker.previous = yaw;
    tracker.heading = 0;
    return 0;
  }
  tracker.heading += getSignedAngleDelta(yaw, tracker.previous);
  tracker.previous = yaw;
  return tracker.heading;
}

/**
 * The heading of a column, expressed as the turn nearest to where the phone
 * points now.  After a full eye-level sweep the phone sits near 330°, so the
 * upper band's first target resolves to 360° (keep turning right) instead of
 * 0° (swing all the way back).
 */
export function nearestTargetYaw(column: number, heading: number) {
  const base = column * (360 / CAPTURE_COLUMNS);
  return base + 360 * Math.round((heading - base) / 360);
}

export type GuidanceHint = "turn-right" | "turn-left" | "tilt-up" | "tilt-down" | "straighten" | "hold";

/** Sideways tilt beyond which the phone is asked to be held upright. */
export const MAX_CAPTURE_ROLL = 8;

/** The single most useful instruction for the current aiming error. */
export function guidanceHint(yawError: number, pitchError: number, aligned: boolean, roll = 0): GuidanceHint {
  if (aligned) return "hold";
  // A tilted photo loses its corners to the correction, so fix that first
  // once the phone is roughly on target.
  if (Math.abs(roll) > MAX_CAPTURE_ROLL && Math.abs(yawError) < 15) return "straighten";
  // Pitch is asked for first only when it is clearly the larger problem.
  if (Math.abs(pitchError) > 10 && Math.abs(pitchError) > Math.abs(yawError)) {
    return pitchError > 0 ? "tilt-up" : "tilt-down";
  }
  if (Math.abs(yawError) > 4) return yawError > 0 ? "turn-right" : "turn-left";
  return pitchError > 0 ? "tilt-up" : "tilt-down";
}

export const GUIDANCE_HINT_TEXT: Record<GuidanceHint, string> = {
  "turn-right": "Turn right toward the dot",
  "turn-left": "Turn left toward the dot",
  "tilt-up": "Tilt up toward the dot",
  "tilt-down": "Tilt down toward the dot",
  straighten: "Hold the phone upright",
  hold: "Hold still — capturing",
};
