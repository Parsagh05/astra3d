/** A 3D scan: a walk-through video turned into a Gaussian splat scene. */

export type ScanStatus = "queued" | "running" | "done" | "failed";

export type ScanStage = "queued" | "frames" | "poses" | "training" | "export" | "done";

/** `preview` is built from the reconstructed points without a GPU; `trained` is splatfacto's photoreal result. */
export type ScanKind = "preview" | "trained";

export type ScanResult = {
  kind: ScanKind;
  gaussians: number;
  frames: number;
  placed: number;
  sceneBytes: number;
};

export type ScanJob = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: ScanStatus;
  stage: ScanStage;
  /** 0..1 across all stages. */
  progress: number;
  message: string;
  error: string | null;
  video: { bytes: number; mimeType: string };
  result?: ScanResult;
  worker?: { host: string; trainer: string };
  startedAt?: string;
  finishedAt?: string;
};

export type ScanPathPoint = { position: [number, number, number]; forward: [number, number, number] };

/** scene.json, written next to scene.splat by scripts/splat_pipeline.py. */
export type ScanScene = {
  version: 1;
  kind: ScanKind;
  gaussians: number;
  frames: { used: number; placed: number };
  up: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  path: ScanPathPoint[];
};

export const SCAN_FILES = ["scene.splat", "scene.json", "poster.jpg", "scene.ply", "pipeline.log"] as const;
export type ScanFile = (typeof SCAN_FILES)[number];
