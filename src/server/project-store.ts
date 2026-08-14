import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ServerPanoramaFrame } from "@/server/panorama-processor";
import type { PanoramaQualityReport, SharedRoomProject } from "@/types/capture";

const DATA_ROOT = process.env.ASTRA3D_DATA_DIR
  ? path.resolve(process.env.ASTRA3D_DATA_DIR)
  : path.join(process.cwd(), ".astra3d-data");
const PROJECTS_ROOT = path.join(DATA_ROOT, "projects");
const MANIFEST_FILE = "project.json";
const PANORAMA_FILE = "panorama.jpg";
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredProjectManifest = SharedRoomProject & {
  version: 1;
  panoramaFile: typeof PANORAMA_FILE;
  sourceFrames: Array<{
    sequence: number;
    band: ServerPanoramaFrame["band"];
    column: number;
    zoom: number;
    file: string;
  }>;
};

export type SaveCapturedProjectInput = {
  name: string;
  createdAt?: string;
  frames: readonly ServerPanoramaFrame[];
  panorama: Buffer;
  quality: PanoramaQualityReport;
};

export type SavePanoramaProjectInput = {
  name: string;
  createdAt?: string;
  photoCount: number;
  panorama: Buffer;
  quality?: PanoramaQualityReport;
};

function cleanName(name: string) {
  const value = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 48);
  return value || "My room";
}

function cleanDate(value?: string) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function projectDirectory(projectId: string) {
  if (!PROJECT_ID_PATTERN.test(projectId)) return null;
  return path.join(PROJECTS_ROOT, projectId);
}

function extensionFor(frame: ServerPanoramaFrame) {
  if (frame.mimeType === "image/png") return "png";
  if (frame.mimeType === "image/webp") return "webp";
  return "jpg";
}

function publicProject(manifest: StoredProjectManifest): SharedRoomProject {
  return {
    id: manifest.id,
    name: manifest.name,
    createdAt: manifest.createdAt,
    photoCount: manifest.photoCount,
    hasSourceFrames: manifest.hasSourceFrames,
    processor: "laptop",
    quality: manifest.quality,
  };
}

function isStoredManifest(value: unknown): value is StoredProjectManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredProjectManifest>;
  return candidate.version === 1 &&
    typeof candidate.id === "string" && PROJECT_ID_PATTERN.test(candidate.id) &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "string" &&
    Number.isInteger(candidate.photoCount) &&
    typeof candidate.hasSourceFrames === "boolean" &&
    candidate.processor === "laptop" &&
    candidate.panoramaFile === PANORAMA_FILE &&
    Array.isArray(candidate.sourceFrames);
}

async function readManifest(directory: string) {
  try {
    const value = JSON.parse(await readFile(path.join(directory, MANIFEST_FILE), "utf8")) as unknown;
    return isStoredManifest(value) ? value : null;
  } catch {
    return null;
  }
}

async function saveProject(
  input: SavePanoramaProjectInput,
  frames: readonly ServerPanoramaFrame[],
) {
  await mkdir(PROJECTS_ROOT, { recursive: true });
  const projectId = randomUUID();
  const stagingDirectory = path.join(PROJECTS_ROOT, `.${projectId}.staging`);
  const finalDirectory = path.join(PROJECTS_ROOT, projectId);
  const sourceFrames = frames.map((frame) => ({
    sequence: frame.sequence,
    band: frame.band,
    column: frame.column,
    zoom: frame.zoom ?? 1,
    file: `frames/${String(frame.sequence + 1).padStart(2, "0")}-${frame.band}-${frame.column + 1}.${extensionFor(frame)}`,
  }));
  const manifest: StoredProjectManifest = {
    version: 1,
    id: projectId,
    name: cleanName(input.name),
    createdAt: cleanDate(input.createdAt),
    photoCount: Math.max(0, Math.min(24, Math.round(input.photoCount))),
    hasSourceFrames: frames.length > 0,
    processor: "laptop",
    quality: input.quality,
    panoramaFile: PANORAMA_FILE,
    sourceFrames,
  };

  try {
    await mkdir(stagingDirectory, { recursive: false });
    if (frames.length > 0) await mkdir(path.join(stagingDirectory, "frames"));
    await Promise.all([
      writeFile(path.join(stagingDirectory, PANORAMA_FILE), input.panorama, { flag: "wx" }),
      ...frames.map((frame, index) => writeFile(
        path.join(stagingDirectory, sourceFrames[index].file),
        frame.image,
        { flag: "wx" },
      )),
    ]);
    await writeFile(
      path.join(stagingDirectory, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
    await rename(stagingDirectory, finalDirectory);
    return publicProject(manifest);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function saveCapturedProject(input: SaveCapturedProjectInput) {
  return saveProject({
    name: input.name,
    createdAt: input.createdAt,
    photoCount: input.frames.length,
    panorama: input.panorama,
    quality: input.quality,
  }, input.frames);
}

export function savePanoramaProject(input: SavePanoramaProjectInput) {
  return saveProject(input, []);
}

export async function listProjects() {
  await mkdir(PROJECTS_ROOT, { recursive: true });
  const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
  const projects = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && PROJECT_ID_PATTERN.test(entry.name))
    .map((entry) => readManifest(path.join(PROJECTS_ROOT, entry.name))));
  return projects
    .filter((project): project is StoredProjectManifest => project !== null)
    .map(publicProject)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readProjectPanorama(projectId: string) {
  const directory = projectDirectory(projectId);
  if (!directory) return null;
  const manifest = await readManifest(directory);
  if (!manifest || manifest.id !== projectId) return null;
  try {
    return {
      project: publicProject(manifest),
      panorama: await readFile(path.join(directory, PANORAMA_FILE)),
    };
  } catch {
    return null;
  }
}

export const projectStorePaths = { dataRoot: DATA_ROOT, projectsRoot: PROJECTS_ROOT };
