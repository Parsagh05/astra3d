import { Euler, MathUtils, Quaternion, Vector3 } from "three";

import { STILL_HORIZONTAL_FOV, STILL_VERTICAL_FOV } from "@/lib/guided-capture";

/**
 * Scene frame shared by the live capture guide: y up, heading zero along -z
 * and positive yaw turning right (toward +x).  It matches `orientationToView`
 * and the panorama viewer, so a shot drawn at (yaw, pitch) sits exactly where
 * the guidance said the target was.
 */
const SENSOR_TO_CAMERA = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const scratchEuler = new Euler();
const scratchQuaternion = new Quaternion();

export type ViewQuaternion = [number, number, number, number];

/**
 * Rear-camera orientation from W3C device-orientation angles.
 * `screenAngle` rolls the picture for landscape screens, and `headingOrigin`
 * (a camera yaw in degrees) becomes heading zero.
 */
export function deviceQuaternion(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle = 0,
  headingOrigin = 0,
  out = new Quaternion(),
) {
  scratchEuler.set(
    MathUtils.degToRad(beta),
    MathUtils.degToRad(alpha),
    -MathUtils.degToRad(gamma),
    "YXZ",
  );
  out.setFromEuler(scratchEuler).multiply(SENSOR_TO_CAMERA);
  if (screenAngle) {
    out.multiply(scratchQuaternion.setFromAxisAngle(Z_AXIS, -MathUtils.degToRad(screenAngle)));
  }
  if (headingOrigin) {
    out.premultiply(scratchQuaternion.setFromAxisAngle(Y_AXIS, MathUtils.degToRad(headingOrigin)));
  }
  return out;
}

/** Camera orientation for a nominal (yaw, pitch) with no roll. */
export function viewQuaternion(yaw: number, pitch: number, out = new Quaternion()) {
  scratchEuler.set(MathUtils.degToRad(pitch), -MathUtils.degToRad(yaw), 0, "YXZ");
  return out.setFromEuler(scratchEuler);
}

export function directionForView(yaw: number, pitch: number, out = new Vector3()) {
  const yawRadians = MathUtils.degToRad(yaw);
  const pitchRadians = MathUtils.degToRad(pitch);
  return out.set(
    Math.sin(yawRadians) * Math.cos(pitchRadians),
    Math.sin(pitchRadians),
    -Math.cos(yawRadians) * Math.cos(pitchRadians),
  );
}

export type ScreenPoint = {
  x: number;
  y: number;
  /** False when the point is behind the camera or outside the viewport. */
  onScreen: boolean;
};

const scratchLocal = new Vector3();
const scratchInverse = new Quaternion();

/**
 * Projects a scene direction into viewport pixels.  Points behind the camera
 * or beyond the edges are pulled onto the border along their true bearing,
 * so an arrow toward them always points the right way.
 */
export function projectDirection(
  direction: Vector3,
  camera: Quaternion,
  focal: number,
  width: number,
  height: number,
  margin = 28,
): ScreenPoint {
  const local = scratchLocal.copy(direction).applyQuaternion(scratchInverse.copy(camera).invert());
  const depth = -local.z;
  const centerX = width / 2;
  const centerY = height / 2;
  if (depth > 0.02) {
    const x = centerX + (local.x / depth) * focal;
    const y = centerY - (local.y / depth) * focal;
    if (x >= margin && x <= width - margin && y >= margin && y <= height - margin) {
      return { x, y, onScreen: true };
    }
  }
  // Off screen: keep the bearing and clamp to the inset border.
  let dx = local.x;
  let dy = -local.y;
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = 0;
    dy = 1;
  }
  const scale = Math.min(
    (centerX - margin) / Math.max(Math.abs(dx), 1e-6),
    (centerY - margin) / Math.max(Math.abs(dy), 1e-6),
  );
  return { x: centerX + dx * scale, y: centerY + dy * scale, onScreen: false };
}

export type CaptureViewLayout = {
  width: number;
  height: number;
  /** Pixels per unit of tangent: the virtual camera's focal length. */
  focal: number;
  /** Vertical field of view of the whole viewport, in degrees. */
  fov: number;
  /** Size of the live camera window that shows exactly the still's crop. */
  windowWidth: number;
  windowHeight: number;
};

const TAN_HALF_HORIZONTAL = Math.tan(MathUtils.degToRad(STILL_HORIZONTAL_FOV / 2));
const TAN_HALF_VERTICAL = Math.tan(MathUtils.degToRad(STILL_VERTICAL_FOV / 2));

/**
 * Sphere mode zooms out so the live still window fills about 70% of the
 * screen and captured neighbours stay visible around it.  Without the sphere
 * the live picture fills the viewport and the guide uses the camera's own
 * field of view, so the target dot stays glued to the scene.
 */
export function captureViewLayout(width: number, height: number, sphere: boolean): CaptureViewLayout {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const focal = sphere
    ? Math.min((safeWidth * 0.72) / (2 * TAN_HALF_HORIZONTAL), (safeHeight * 0.72) / (2 * TAN_HALF_VERTICAL))
    : Math.max(safeHeight / (2 * TAN_HALF_VERTICAL), safeWidth / (2 * TAN_HALF_HORIZONTAL));
  return {
    width: safeWidth,
    height: safeHeight,
    focal,
    fov: MathUtils.radToDeg(2 * Math.atan(safeHeight / (2 * focal))),
    windowWidth: sphere ? 2 * focal * TAN_HALF_HORIZONTAL : safeWidth,
    windowHeight: sphere ? 2 * focal * TAN_HALF_VERTICAL : safeHeight,
  };
}

export function currentScreenAngle() {
  if (typeof window === "undefined") return 0;
  const angle = window.screen?.orientation?.angle ??
    (window as Window & { orientation?: number }).orientation ??
    0;
  return Number.isFinite(angle) ? Number(angle) : 0;
}
