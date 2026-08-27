export const MIN_PANORAMA_FOV = 35;
export const MAX_PANORAMA_FOV = 90;
export const MAX_PANORAMA_PITCH = 85;

export type PanoramaView = {
  /** Horizontal look direction in degrees. Positive values turn right. */
  yaw: number;
  /** Vertical look direction in degrees. Positive values look up. */
  pitch: number;
  /** Vertical field of view in degrees. */
  fov: number;
};

/** Accepts either the renderer's concise `fov` name or content-model naming. */
export type PanoramaViewInput = Omit<PanoramaView, "fov"> &
  (
    | { fov: number; fieldOfView?: number }
    | { fov?: number; fieldOfView: number }
  );

export type SphericalPoint = {
  yaw: number;
  pitch: number;
};

export type ProjectedPoint = {
  /** Horizontal pixel coordinate from the viewport's left edge. */
  x: number;
  /** Vertical pixel coordinate from the viewport's top edge. */
  y: number;
  /** Camera-space depth. Values at or below zero are behind the viewer. */
  depth: number;
  /** Whether the point is in front of the camera and inside the viewport. */
  visible: boolean;
};

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Normalizes an angle to the half-open range [-180, 180). */
export function wrapDegrees(angle: number) {
  return ((angle + 180) % 360 + 360) % 360 - 180;
}

export function shortestAngleDelta(from: number, to: number) {
  return wrapDegrees(to - from);
}

export function clampPitch(
  pitch: number,
  maximum = MAX_PANORAMA_PITCH,
) {
  return clamp(pitch, -Math.abs(maximum), Math.abs(maximum));
}

export function clampFov(
  fov: number,
  minimum = MIN_PANORAMA_FOV,
  maximum = MAX_PANORAMA_FOV,
) {
  return clamp(fov, minimum, maximum);
}

export function clampPanoramaView(view: PanoramaViewInput): PanoramaView {
  const fov = view.fov ?? view.fieldOfView ?? 75;

  return {
    yaw: wrapDegrees(view.yaw),
    pitch: clampPitch(view.pitch),
    fov: clampFov(fov),
  };
}

export const clampView = clampPanoramaView;

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

/**
 * Converts device-orientation angles into the rear camera's look direction.
 * Uses the W3C convention: intrinsic Z-X'-Y'' rotation where `alpha` spins
 * about the vertical axis, `beta` tilts front-to-back, and `gamma` rolls
 * left-to-right. The rear camera looks along the device's -z axis, so a
 * phone held upright reports pitch 0 and pointing it at the ceiling
 * approaches pitch 90. Yaw follows the panorama convention: positive turns
 * right.
 */
export function orientationToView(
  alpha: number,
  beta: number,
  gamma: number,
): SphericalPoint {
  const alphaRadians = degreesToRadians(alpha);
  const betaRadians = degreesToRadians(beta);
  const gammaRadians = degreesToRadians(gamma);

  // Rear-camera direction (0, 0, -1) rotated by Ry(gamma) then Rx(beta).
  const x = -Math.sin(gammaRadians);
  const y = Math.sin(betaRadians) * Math.cos(gammaRadians);
  const z = -Math.cos(betaRadians) * Math.cos(gammaRadians);

  // Rz(alpha) into the world frame: x points east, y north, z up.
  const east = x * Math.cos(alphaRadians) - y * Math.sin(alphaRadians);
  const north = x * Math.sin(alphaRadians) + y * Math.cos(alphaRadians);

  return {
    yaw: wrapDegrees(radiansToDegrees(Math.atan2(east, north))),
    pitch: radiansToDegrees(Math.asin(clamp(z, -1, 1))),
  };
}

function sphericalDirection(point: SphericalPoint) {
  const yaw = degreesToRadians(point.yaw);
  const pitch = degreesToRadians(clampPitch(point.pitch, 90));
  const cosPitch = Math.cos(pitch);

  return {
    x: Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/**
 * Projects a yaw/pitch point into DOM pixel coordinates for a rectilinear
 * panorama viewport. The convention matches `PanoramaScene`: yaw zero faces
 * the center of the panorama, positive yaw turns right, and pitch points up.
 */
export function projectSphericalPoint(
  point: SphericalPoint,
  view: PanoramaViewInput,
  viewportWidth: number,
  viewportHeight: number,
): ProjectedPoint {
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { x: 0, y: 0, depth: -1, visible: false };
  }

  const safeView = clampPanoramaView(view);
  const direction = sphericalDirection(point);
  const yaw = degreesToRadians(safeView.yaw);
  const pitch = degreesToRadians(safeView.pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);

  const right = { x: cosYaw, y: 0, z: sinYaw };
  const up = {
    x: -sinYaw * sinPitch,
    y: cosPitch,
    z: cosYaw * sinPitch,
  };
  const forward = {
    x: sinYaw * cosPitch,
    y: sinPitch,
    z: -cosYaw * cosPitch,
  };

  const cameraX =
    direction.x * right.x + direction.y * right.y + direction.z * right.z;
  const cameraY =
    direction.x * up.x + direction.y * up.y + direction.z * up.z;
  const depth =
    direction.x * forward.x +
    direction.y * forward.y +
    direction.z * forward.z;

  if (depth <= 0.0001) {
    return {
      x: viewportWidth / 2,
      y: viewportHeight / 2,
      depth,
      visible: false,
    };
  }

  const focalLength =
    viewportHeight / (2 * Math.tan(degreesToRadians(safeView.fov) / 2));
  const x = viewportWidth / 2 + (cameraX / depth) * focalLength;
  const y = viewportHeight / 2 - (cameraY / depth) * focalLength;

  return {
    x,
    y,
    depth,
    visible: x >= 0 && x <= viewportWidth && y >= 0 && y <= viewportHeight,
  };
}

export const projectHotspot = projectSphericalPoint;
