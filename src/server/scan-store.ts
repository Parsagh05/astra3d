import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ScanFile, ScanJob, ScanResult, ScanStage, ScanStatus } from "@/types/scan";

/**
 * Scan jobs live on disk, one folder per scan under <data>/scans/<id>/:
 *
 *   job.json      status, stage and progress (rewritten by the worker)
 *   video.<ext>   the uploaded walk-through, or
 *   photos.zip    the photos taken while walking around the room
 *   claim.lock    held by whoever is working on the job (O_EXCL)
 *   scene.splat, scene.json, poster.jpg, scene.ply, pipeline.log   results
 *
 * The folder is the whole contract with scripts/splat_pipeline.py, so the
 * worker can run in this container or on a separate GPU machine that shares
 * the data folder.
 */

const SCAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_FILE = "job.json";
const CLAIM_FILE = "claim.lock";
const DEFAULT_MAX_BYTES = 1536 * 1024 * 1024;
const MIN_UPLOAD_BYTES = 64 * 1024;
/** Fewer photos rarely give COLMAP enough overlapping views to place them. */
export const MIN_SCAN_PHOTOS = 20;
export const MAX_SCAN_PHOTOS = 400;
/** Photos arrive as one uncompressed ZIP so a phone sends a single request. */
export const PHOTO_ARCHIVE_TYPES = ["application/zip", "application/x-zip-compressed"];
/** Workers beat every 20 s; a running job silent this long has died. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};

type StoredScanJob = Omit<ScanJob, "video" | "photos"> & {
  version: 1;
  video?: NonNullable<ScanJob["video"]> & { file: string };
  photos?: NonNullable<ScanJob["photos"]> & { file: string };
  heartbeatAt?: string;
};

export class ScanStoreError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ScanStoreError";
    this.status = status;
  }
}

function dataRoot() {
  return process.env.ASTRA3D_DATA_DIR
    ? path.resolve(process.env.ASTRA3D_DATA_DIR)
    : path.join(process.cwd(), ".astra3d-data");
}

export function scansRoot() {
  return path.join(dataRoot(), "scans");
}

export function maxScanBytes() {
  const configured = Number(process.env.ASTRA3D_SCAN_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

export function scanDirectory(id: string) {
  return SCAN_ID_PATTERN.test(id) ? path.join(scansRoot(), id.toLowerCase()) : null;
}

function now() {
  return new Date().toISOString();
}

export function cleanScanName(value: string | null | undefined) {
  const name = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || "My room";
}

async function writeJob(directory: string, job: StoredScanJob) {
  const temporary = path.join(directory, `${JOB_FILE}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, JSON.stringify(job, null, 2), "utf8");
  await rename(temporary, path.join(directory, JOB_FILE));
}

async function readJob(directory: string): Promise<StoredScanJob | null> {
  try {
    const job = JSON.parse(await readFile(path.join(directory, JOB_FILE), "utf8")) as StoredScanJob;
    return job && job.version === 1 && typeof job.id === "string" ? job : null;
  } catch {
    return null;
  }
}

/** Same lock the Python worker takes, so the web app never edits a job mid-run. */
async function tryClaim(directory: string) {
  try {
    const handle = await open(path.join(directory, CLAIM_FILE), "wx");
    await handle.writeFile(`${hostname()}:${process.pid}:web\n`);
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function releaseClaim(directory: string) {
  await unlink(path.join(directory, CLAIM_FILE)).catch(() => undefined);
}

export function publicScan(job: StoredScanJob): ScanJob {
  const result: ScanResult | undefined = job.result
    ? {
      kind: job.result.kind,
      gaussians: job.result.gaussians,
      frames: job.result.frames,
      placed: job.result.placed,
      sceneBytes: job.result.sceneBytes,
    }
    : undefined;
  return {
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    stage: job.stage,
    progress: Math.max(0, Math.min(1, Number(job.progress) || 0)),
    message: job.message ?? "",
    error: job.error ?? null,
    source: job.photos ? "photos" : "video",
    ...(job.video ? { video: { bytes: job.video.bytes, mimeType: job.video.mimeType } } : {}),
    ...(job.photos ? { photos: { count: job.photos.count, bytes: job.photos.bytes } } : {}),
    ...(result ? { result } : {}),
    ...(job.worker ? { worker: { host: job.worker.host, trainer: job.worker.trainer } } : {}),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  };
}

function byteLimiter(limit: number) {
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(new ScanStoreError(`The upload is larger than ${Math.round(limit / 1024 / 1024)} MB.`, 413));
        return;
      }
      callback(null, chunk);
    },
  });
  return { counter, bytes: () => total };
}

/**
 * Number of entries in a ZIP, read from its end-of-central-directory record
 * (the last 22 bytes plus an optional comment).  Null when the file is not a
 * ZIP.  The worker still opens every photo; this only rejects obvious junk
 * and records the count before the upload is queued.
 */
export async function zipEntryCount(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 22 + 0xffff);
    if (length < 22) return null;
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    for (let offset = length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) return tail.readUInt16LE(offset + 10);
    }
    return null;
  } finally {
    await handle.close();
  }
}

export type CreateScanInput = {
  name: string;
  mimeType: string;
  body: ReadableStream<Uint8Array>;
  declaredBytes?: number;
};

/**
 * Streams an uploaded video, or a ZIP of photos, to disk (never buffering
 * it in memory) and queues it.  The job appears only once the upload is complete: everything
 * is written to a hidden staging folder, then renamed into place.
 */
export async function createScan(input: CreateScanInput) {
  const mimeType = input.mimeType.split(";")[0].trim().toLowerCase();
  const extension = VIDEO_TYPES[mimeType];
  const isPhotos = PHOTO_ARCHIVE_TYPES.includes(mimeType);
  if (!extension && !isPhotos) {
    throw new ScanStoreError("Upload an MP4, MOV, WebM or MKV video, or take photos in the 3D scan page.", 415);
  }
  const limit = maxScanBytes();
  if (input.declaredBytes !== undefined && input.declaredBytes > limit) {
    throw new ScanStoreError(`The upload is larger than ${Math.round(limit / 1024 / 1024)} MB.`, 413);
  }

  const root = scansRoot();
  await mkdir(root, { recursive: true });
  const id = randomUUID();
  const staging = path.join(root, `.staging-${id}`);
  await mkdir(staging);
  try {
    const inputFile = isPhotos ? "photos.zip" : `video.${extension}`;
    const limiter = byteLimiter(limit);
    await pipeline(
      Readable.fromWeb(input.body as unknown as NodeReadableStream<Uint8Array>),
      limiter.counter,
      createWriteStream(path.join(staging, inputFile), { flags: "wx" }),
    );
    const bytes = limiter.bytes();
    if (bytes < MIN_UPLOAD_BYTES) {
      throw new ScanStoreError(isPhotos ? "The photos are missing or empty." : "The video is empty or too short.", 400);
    }
    let photoCount = 0;
    if (isPhotos) {
      const count = await zipEntryCount(path.join(staging, inputFile));
      if (count === null) throw new ScanStoreError("The photos could not be read. Take them again.", 415);
      if (count < MIN_SCAN_PHOTOS) {
        throw new ScanStoreError(`Only ${count} photos arrived. Take at least ${MIN_SCAN_PHOTOS} while walking around the room.`, 400);
      }
      if (count > MAX_SCAN_PHOTOS) {
        throw new ScanStoreError(`That is ${count} photos; the server takes up to ${MAX_SCAN_PHOTOS} per scan.`, 413);
      }
      photoCount = count;
    }
    const createdAt = now();
    const job: StoredScanJob = {
      version: 1,
      id,
      name: cleanScanName(input.name),
      createdAt,
      updatedAt: createdAt,
      status: "queued",
      stage: "queued",
      progress: 0,
      message: "Waiting for a worker…",
      error: null,
      source: isPhotos ? "photos" : "video",
      ...(isPhotos
        ? { photos: { file: inputFile, count: photoCount, bytes } }
        : { video: { file: inputFile, bytes, mimeType } }),
    };
    await writeJob(staging, job);
    await rename(staging, path.join(root, id));
    return publicScan(job);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof ScanStoreError) throw error;
    // A client that disconnects mid-upload surfaces as a stream error.
    if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE" || (error as Error).name === "AbortError") {
      throw new ScanStoreError("The upload was interrupted.", 400);
    }
    throw error;
  }
}

/**
 * A running job whose worker stopped beating (container restart, crash,
 * out-of-memory kill) is marked failed so it can be retried.
 */
async function recoverStale(directory: string, job: StoredScanJob, isActive: (id: string) => boolean) {
  if (job.status !== "running" || isActive(job.id)) return job;
  const beat = Date.parse(job.heartbeatAt ?? job.updatedAt);
  if (Number.isFinite(beat) && Date.now() - beat < STALE_AFTER_MS) return job;
  const failed: StoredScanJob = {
    ...job,
    status: "failed",
    error: `The worker stopped responding. Retry to process the ${job.photos ? "photos" : "video"} again.`,
    message: "Worker stopped",
    updatedAt: now(),
    finishedAt: now(),
  };
  await writeJob(directory, failed);
  await releaseClaim(directory);
  return failed;
}

export type ScanStoreOptions = {
  /** Jobs this server is processing right now (never considered stale). */
  isActive?: (id: string) => boolean;
};

export async function listScans(options: ScanStoreOptions = {}) {
  const root = scansRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && SCAN_ID_PATTERN.test(entry.name))
    .map(async (entry) => {
      const directory = path.join(root, entry.name);
      const job = await readJob(directory);
      if (!job || job.id !== entry.name) return null;
      return recoverStale(directory, job, options.isActive ?? (() => false));
    }));
  return jobs
    .filter((job): job is StoredScanJob => job !== null)
    .map(publicScan)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getScan(id: string, options: ScanStoreOptions = {}) {
  const directory = scanDirectory(id);
  if (!directory) return null;
  const job = await readJob(directory);
  if (!job || job.id.toLowerCase() !== id.toLowerCase()) return null;
  return publicScan(await recoverStale(directory, job, options.isActive ?? (() => false)));
}

/** Oldest queued job first; the local runner processes them one at a time. */
export async function nextQueuedScan() {
  const queued = (await listScans()).filter((job) => job.status === "queued");
  return queued.at(-1) ?? null;
}

export async function deleteScan(id: string) {
  const directory = scanDirectory(id);
  if (!directory || !(await readJob(directory))) {
    throw new ScanStoreError("Scan not found.", 404);
  }
  if (!(await tryClaim(directory))) {
    throw new ScanStoreError("The scan is being processed. Wait for it to finish, then delete it.", 409);
  }
  // Rename first so a worker scanning the folder never sees half a job.
  const trash = path.join(scansRoot(), `.deleting-${randomUUID()}`);
  await rename(directory, trash);
  await rm(trash, { recursive: true, force: true });
}

/** Queues a failed scan again, or a finished one for another pass (e.g. with a GPU worker). */
export async function retryScan(id: string) {
  const directory = scanDirectory(id);
  const job = directory ? await readJob(directory) : null;
  if (!directory || !job) throw new ScanStoreError("Scan not found.", 404);
  if (job.status === "queued") return publicScan(job);
  if (!(await tryClaim(directory))) {
    throw new ScanStoreError("The scan is already being processed.", 409);
  }
  try {
    const current = await readJob(directory);
    if (!current) throw new ScanStoreError("Scan not found.", 404);
    const status: ScanStatus = "queued";
    const stage: ScanStage = "queued";
    const queued: StoredScanJob = {
      ...current,
      status,
      stage,
      progress: 0,
      error: null,
      message: "Waiting for a worker…",
      updatedAt: now(),
      finishedAt: undefined,
      startedAt: undefined,
    };
    await writeJob(directory, queued);
    return publicScan(queued);
  } finally {
    await releaseClaim(directory);
  }
}

const FILE_TYPES: Record<ScanFile, string> = {
  "scene.splat": "application/octet-stream",
  "scene.json": "application/json",
  "poster.jpg": "image/jpeg",
  "scene.ply": "application/octet-stream",
  "pipeline.log": "text/plain; charset=utf-8",
};

export function scanFileType(file: ScanFile) {
  return FILE_TYPES[file];
}

export async function scanFileInfo(id: string, file: ScanFile) {
  const directory = scanDirectory(id);
  if (!directory || !(file in FILE_TYPES)) return null;
  const filePath = path.join(directory, file);
  try {
    const info = await stat(filePath);
    return info.isFile() ? { path: filePath, size: info.size, modified: info.mtime } : null;
  } catch {
    return null;
  }
}

/**
 * Called by the local runner after its pipeline process exits: a job still
 * queued or running then never started or was killed, so it fails visibly.
 */
export async function failUnfinishedScan(id: string, error: string) {
  const directory = scanDirectory(id);
  const job = directory ? await readJob(directory) : null;
  if (!directory || !job || job.status === "done" || job.status === "failed") return;
  await writeJob(directory, { ...job, status: "failed", error, message: "Processing failed", updatedAt: now(), finishedAt: now() });
  await releaseClaim(directory);
}
