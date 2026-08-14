export type CaptureBandId = "upper" | "middle" | "lower";

export type CaptureSlot = {
  id: string;
  band: CaptureBandId;
  column: number;
  sequence: number;
  yaw: number;
};

export type CapturedFrame = CaptureSlot & {
  dataUrl: string;
  capturedAt: number;
  /** Optical or preview zoom used for this view. */
  zoom: number;
};

export type PanoramaQualityReport = {
  method: "opencv-sift-cylindrical-v2";
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
};
