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
};

export type GeneratedRoomRecord = {
  id: "latest-room";
  name: string;
  createdAt: string;
  photoCount: number;
  panorama: Blob;
  processor?: "device" | "laptop";
};
