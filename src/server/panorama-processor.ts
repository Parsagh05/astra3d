import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  TOTAL_CAPTURE_SLOTS,
} from "@/lib/capture-plan";
import type { CaptureBandId, CaptureOrientation, PanoramaQualityReport } from "@/types/capture";

export const PANORAMA_WIDTH = 3072;
export const PANORAMA_HEIGHT = 1536;
/** Output size used when the phone delivered full-resolution photo stills. */
export const HIGH_RES_PANORAMA_WIDTH = 4096;
/** Portrait still width that indicates real photo captures rather than preview grabs. */
const HIGH_RES_FRAME_WIDTH = 1440;
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;
/**
 * A complete capture is every slot, and each may carry an exposure bracket,
 * so the package cap follows the plan instead of a number that quietly stops
 * fitting when the plan grows.
 */
export const MAX_CAPTURE_BYTES = TOTAL_CAPTURE_SLOTS * 2 * MAX_FRAME_BYTES;

export type ServerPanoramaFrame = {
  sequence: number;
  band: CaptureBandId;
  column: number;
  image: Buffer;
  zoom?: number;
  imu?: CaptureOrientation;
  /** Under-exposed companion still for highlight fusion. */
  bracket?: Buffer;
  mimeType?: "image/jpeg" | "image/png" | "image/webp";
};

type PanoramaOptions = {
  width?: number;
  height?: number;
  quality?: number;
  timeoutMs?: number;
  pythonCommand?: string;
  scriptPath?: string;
};

type WorkerReport = PanoramaQualityReport & {
  ok: boolean;
  code?: string;
  message?: string;
  retakeSequences: number[];
};

export type ServerPanoramaResult = {
  panorama: Buffer;
  report: PanoramaQualityReport;
  width: number;
  height: number;
};

export class PanoramaProcessingError extends Error {
  readonly code: string;
  readonly retakeSequences: number[];

  constructor(message: string, code = "PROCESSING_FAILED", retakeSequences: number[] = []) {
    super(message);
    this.name = "PanoramaProcessingError";
    this.code = code;
    this.retakeSequences = retakeSequences;
  }
}

function assertCapturePlan(frames: readonly ServerPanoramaFrame[]) {
  if (frames.length !== TOTAL_CAPTURE_SLOTS) {
    throw new Error(`Expected ${TOTAL_CAPTURE_SLOTS} capture frames.`);
  }

  const sequences = new Set<number>();
  for (const frame of frames) {
    const expectedBand = CAPTURE_BANDS[Math.floor(frame.sequence / CAPTURE_COLUMNS)]?.id;
    const expectedColumn = frame.sequence % CAPTURE_COLUMNS;
    if (
      !Number.isInteger(frame.sequence) ||
      frame.sequence < 0 ||
      frame.sequence >= TOTAL_CAPTURE_SLOTS ||
      frame.band !== expectedBand ||
      frame.column !== expectedColumn ||
      sequences.has(frame.sequence)
    ) {
      throw new Error("The capture manifest is incomplete or out of order.");
    }
    sequences.add(frame.sequence);
  }
}

function isWorkerReport(value: unknown): value is WorkerReport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerReport>;
  return typeof candidate.ok === "boolean" && Array.isArray(candidate.retakeSequences);
}

function runWorker(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new PanoramaProcessingError(
        "Feature alignment exceeded the laptop processing time limit.",
        "PROCESSING_TIMEOUT",
      ));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 12_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

async function readWorkerReport(reportPath: string) {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    return isWorkerReport(report) ? report : null;
  } catch {
    return null;
  }
}

async function removePrivateJobDirectory(jobDirectory: string) {
  const temporaryRoot = path.resolve(tmpdir());
  const resolvedJob = path.resolve(jobDirectory);
  if (
    path.dirname(resolvedJob) !== temporaryRoot ||
    !path.basename(resolvedJob).startsWith("astra3d-panorama-")
  ) {
    throw new Error("Refusing to remove an unexpected panorama directory.");
  }
  await rm(resolvedJob, { recursive: true, force: true });
}

/** Full-resolution photo captures earn the larger equirect output. */
async function chooseOutputWidth(frames: readonly ServerPanoramaFrame[]) {
  try {
    const probe = frames.find((frame) => frame.sequence === 0) ?? frames[0];
    const metadata = await sharp(probe.image).metadata();
    return (metadata.width ?? 0) >= HIGH_RES_FRAME_WIDTH
      ? HIGH_RES_PANORAMA_WIDTH
      : PANORAMA_WIDTH;
  } catch {
    return PANORAMA_WIDTH;
  }
}

export async function processRoomPanorama(
  frames: readonly ServerPanoramaFrame[],
  options: PanoramaOptions = {},
): Promise<ServerPanoramaResult> {
  assertCapturePlan(frames);

  const width = options.width ?? await chooseOutputWidth(frames);
  const height = options.height ?? width / 2;
  const quality = options.quality ?? 90;
  if (width < 640 || height < 320 || width !== height * 2) {
    throw new Error("The panorama output must use a supported 2:1 size.");
  }

  const jobDirectory = await mkdtemp(path.join(tmpdir(), "astra3d-panorama-"));
  const outputPath = path.join(jobDirectory, "panorama.jpg");
  const reportPath = path.join(jobDirectory, "report.json");
  const scriptPath = options.scriptPath ?? path.join(process.cwd(), "scripts", "panorama-stitcher.py");
  const pythonCandidates = options.pythonCommand
    ? [options.pythonCommand]
    : process.platform === "win32"
      ? ["python", "python3"]
      : ["python3", "python"];
  try {
    await Promise.all(
      [...frames]
        .sort((left, right) => left.sequence - right.sequence)
        .flatMap((frame) => {
          const baseName = String(frame.sequence).padStart(3, "0");
          const writes = [writeFile(
            path.join(jobDirectory, `${baseName}.frame`),
            frame.image,
            { flag: "wx" },
          )];
          if (frame.bracket) {
            writes.push(writeFile(
              path.join(jobDirectory, `${baseName}.bracket`),
              frame.bracket,
              { flag: "wx" },
            ));
          }
          return writes;
        }),
    );
    const orientationEntries = Object.fromEntries(
      frames
        .filter((frame) => frame.imu)
        .map((frame) => [String(frame.sequence), frame.imu]),
    );
    if (Object.keys(orientationEntries).length > 0) {
      await writeFile(
        path.join(jobDirectory, "imu.json"),
        JSON.stringify(orientationEntries),
        { flag: "wx" },
      );
    }

    const args = [
      scriptPath,
      "--input", jobDirectory,
      "--output", outputPath,
      "--report", reportPath,
      "--width", String(width),
      "--height", String(height),
      "--quality", String(Math.max(70, Math.min(96, quality))),
      "--columns", String(CAPTURE_COLUMNS),
      "--zoom", String(frames.reduce((sum, frame) => sum + (frame.zoom ?? 1), 0) / frames.length),
    ];

    let workerResult: { code: number; stderr: string } | null = null;
    for (const command of pythonCandidates) {
      try {
        workerResult = await runWorker(command, args, options.timeoutMs ?? 180_000);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!workerResult) {
      throw new PanoramaProcessingError(
        "Python was not found. Install the panorama requirements on this laptop and restart Astra3D.",
        "PROCESSOR_UNAVAILABLE",
      );
    }

    const report = await readWorkerReport(reportPath);
    if (workerResult.code !== 0 || !report?.ok) {
      if (workerResult.stderr) console.error("Astra3D OpenCV worker failed", workerResult.stderr);
      throw new PanoramaProcessingError(
        report?.message ?? "OpenCV could not reconstruct this capture.",
        report?.code ?? "PROCESSING_FAILED",
        report?.retakeSequences ?? [],
      );
    }

    const panorama = await readFile(outputPath);
    if (panorama.length === 0) {
      throw new PanoramaProcessingError("OpenCV returned an empty panorama.");
    }
    return { panorama, report, width, height };
  } catch (error) {
    if (error instanceof PanoramaProcessingError) throw error;
    throw new PanoramaProcessingError("The feature-alignment job could not be completed.");
  } finally {
    await removePrivateJobDirectory(jobDirectory);
  }
}

/** Convenience wrapper retained for callers that only need the encoded JPEG. */
export async function composeRoomPanorama(
  frames: readonly ServerPanoramaFrame[],
  options: PanoramaOptions = {},
) {
  return (await processRoomPanorama(frames, options)).panorama;
}
