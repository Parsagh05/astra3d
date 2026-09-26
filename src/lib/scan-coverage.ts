/**
 * Live guidance while filming a room for a 3D scan.
 *
 * Gaussian splatting needs every surface seen from several positions and
 * angles, so the recorder tracks which directions the camera has pointed at
 * (12 headings x 3 heights: floor, eye level, ceiling) and warns when the
 * phone turns so fast that frames blur.  Directions use the capture guide's
 * frame: y up, heading 0 along -z, positive yaw turning right.
 */

export const SCAN_HEADINGS = 12;
export const SCAN_ROWS = ["low", "level", "high"] as const;
export type ScanRow = (typeof SCAN_ROWS)[number];

/** Pitch (degrees) beyond which the camera counts as looking down / up. */
export const ROW_PITCH = 18;
/** Turning faster than this (degrees per second) blurs video frames. */
export const FAST_TURN_DEG_PER_S = 55;
/** A cell counts once the camera has spent this long pointing into it. */
const CELL_DWELL_MS = 350;
const SPEED_SMOOTHING_MS = 250;

export type ScanCoverage = {
  /** Milliseconds spent in each cell, [row][heading]. */
  dwell: number[][];
  lastForward: [number, number, number] | null;
  lastTime: number | null;
  /** Smoothed turn rate, degrees per second. */
  turnRate: number;
  /** Heading origin (the first yaw seen), so heading 0 is where filming began. */
  origin: number | null;
};

export function createScanCoverage(): ScanCoverage {
  return {
    dwell: SCAN_ROWS.map(() => Array.from({ length: SCAN_HEADINGS }, () => 0)),
    lastForward: null,
    lastTime: null,
    turnRate: 0,
    origin: null,
  };
}

export function yawPitch(forward: readonly [number, number, number]) {
  const [x, y, z] = forward;
  const length = Math.hypot(x, y, z) || 1;
  return {
    yaw: (Math.atan2(x, -z) * 180) / Math.PI,
    pitch: (Math.asin(Math.max(-1, Math.min(1, y / length))) * 180) / Math.PI,
  };
}

export function rowForPitch(pitch: number): ScanRow {
  if (pitch < -ROW_PITCH) return "low";
  if (pitch > ROW_PITCH) return "high";
  return "level";
}

function headingIndex(yaw: number, origin: number) {
  const relative = (((yaw - origin) % 360) + 360 + 180 / SCAN_HEADINGS) % 360;
  return Math.floor(relative / (360 / SCAN_HEADINGS)) % SCAN_HEADINGS;
}

/** Adds one orientation sample (camera forward vector at time `now`, ms). */
export function addCoverageSample(coverage: ScanCoverage, forward: [number, number, number], now: number): ScanCoverage {
  const { yaw, pitch } = yawPitch(forward);
  const origin = coverage.origin ?? yaw;
  const dwell = coverage.dwell.map((row) => row.slice());
  let turnRate = coverage.turnRate;
  if (coverage.lastForward && coverage.lastTime !== null) {
    const elapsed = now - coverage.lastTime;
    if (elapsed > 0 && elapsed < 1000) {
      const [ax, ay, az] = coverage.lastForward;
      const [bx, by, bz] = forward;
      const cosine = (ax * bx + ay * by + az * bz) / ((Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)) || 1);
      const degrees = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
      const instant = (degrees / elapsed) * 1000;
      const blend = Math.min(1, elapsed / SPEED_SMOOTHING_MS);
      turnRate += (instant - turnRate) * blend;
      // Only steady views count: a whip past a wall films nothing sharp.
      if (instant < FAST_TURN_DEG_PER_S * 1.5) {
        dwell[SCAN_ROWS.indexOf(rowForPitch(pitch))][headingIndex(yaw, origin)] += elapsed;
      }
    }
  }
  return { dwell, lastForward: forward, lastTime: now, turnRate, origin };
}

export function coveredCells(coverage: ScanCoverage) {
  return coverage.dwell.map((row) => row.map((ms) => ms >= CELL_DWELL_MS));
}

export function coverageFraction(coverage: ScanCoverage) {
  const cells = coveredCells(coverage).flat();
  return cells.filter(Boolean).length / cells.length;
}

export type ScanHint = { tone: "warn" | "info" | "good"; text: string };

/** The one thing the person filming should do next. */
export function scanHint(coverage: ScanCoverage, elapsedMs: number): ScanHint {
  if (coverage.turnRate > FAST_TURN_DEG_PER_S) {
    return { tone: "warn", text: "Slow down: turn and walk more slowly for sharp frames" };
  }
  const covered = coveredCells(coverage);
  const count = (row: ScanRow) => covered[SCAN_ROWS.indexOf(row)].filter(Boolean).length;
  if (count("level") < SCAN_HEADINGS * 0.75) {
    return { tone: "info", text: "Walk slowly around the room, filming the walls at eye level" };
  }
  if (count("low") < SCAN_HEADINGS * 0.6) {
    return { tone: "info", text: "Now walk another loop tilted down to film the floor and furniture" };
  }
  if (count("high") < SCAN_HEADINGS * 0.6) {
    return { tone: "info", text: "One more loop tilted up to film the ceiling and the tops of the walls" };
  }
  if (elapsedMs < 30_000) {
    return { tone: "info", text: "Good coverage. Keep filming details from new positions" };
  }
  return { tone: "good", text: "Great coverage. Stop whenever you are ready" };
}
