import type { PanoramaMethod } from "@/types/capture";

/** Every stitcher version whose reports the app understands, oldest first. */
export const PANORAMA_METHODS = [
  "opencv-sift-spherical-v3",
  "opencv-sift-spherical-v4",
  "opencv-sift-spherical-v5",
] as const satisfies readonly PanoramaMethod[];

export const CURRENT_PANORAMA_METHOD: PanoramaMethod = "opencv-sift-spherical-v5";

export function isPanoramaMethod(value: unknown): value is PanoramaMethod {
  return typeof value === "string" && (PANORAMA_METHODS as readonly string[]).includes(value);
}

/** Reads a method name from a header or stored report. */
export function toPanoramaMethod(value: unknown): PanoramaMethod {
  return isPanoramaMethod(value) ? value : CURRENT_PANORAMA_METHOD;
}
