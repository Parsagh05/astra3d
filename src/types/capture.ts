export type CaptureBandId = "upper" | "middle" | "lower";

export type CaptureSlot = {
  id: string;
  band: CaptureBandId;
  column: number;
  sequence: number;
  yaw: number;
};

export type CaptureOrientation = {
  /** W3C device-orientation angles sampled at the moment of capture. */
  alpha: number;
  beta: number;
  gamma: number;
};

export type CapturedFrame = CaptureSlot & {
  dataUrl: string;
  capturedAt: number;
  /** Optical or preview zoom used for this view. */
  zoom: number;
  /** Motion-sensor pose recorded with the still, when sensors were live. */
  imu?: CaptureOrientation;
};

export type PanoramaQualityReport = {
  method: "opencv-sift-spherical-v3" | "opencv-sift-spherical-v4";
  alignmentScore: number;
  matchedPairs: number;
  fallbackPairs: number;
  coverage: number;
  retakeSequences: number[];
  warnings: string[];
};

export type GeneratedRoomRecord = {
  id: "latest-room";
  name: string;
  createdAt: string;
  photoCount: number;
  panorama: Blob;
  processor?: "device" | "laptop";
  quality?: PanoramaQualityReport;
  serverProjectId?: string;
  hasSourceFrames?: boolean;
};

export type SharedRoomProject = {
  id: string;
  name: string;
  createdAt: string;
  photoCount: number;
  hasSourceFrames: boolean;
  processor: "laptop";
  quality?: PanoramaQualityReport;
};
