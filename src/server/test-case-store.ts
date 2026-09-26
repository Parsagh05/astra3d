import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCaptureSlots, CAPTURE_COLUMNS, getCaptureBands, type CaptureExtent } from "@/lib/capture-plan";
import { parseOrientation } from "@/server/capture-upload";
import type { ServerPanoramaFrame } from "@/server/panorama-processor";
import { readProjectSource } from "@/server/project-store";
import type { CaptureBandId, CaptureOrientation } from "@/types/capture";

/**
 * Fixed capture sets for re-running the panorama pipeline without a phone.
 *
 *   test-cases/<group>/<case>/01.jpg … 12.jpg (or … 36.jpg) + metadata.json
 *
 * The group folder is only for humans ("12-images", "36-images", "12", …);
 * the plan is taken from metadata.json, or else from the number of photos.
 */
export const TEST_CASES_ROOT = process.env.ASTRA3D_TEST_CASES_DIR
  ? path.resolve(process.env.ASTRA3D_TEST_CASES_DIR)
  : path.join(process.cwd(), "test-cases");

const METADATA_FILE = "metadata.json";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TestCaseInfo = {
  /** `<group>/<case>`, the id used to run it. */
  path: string;
  name: string;
  group: string;
  extent: CaptureExtent;
  imageCount: number;
  hasImu: boolean;
  createdAt?: string;
  source?: string;
};

export type InvalidTestCase = { path: string; imageCount: number; reason: string };

type TestCaseFrameRecord = {
  sequence: number;
  band: CaptureBandId;
  column: number;
  file: string;
  zoom?: number;
  imu?: CaptureOrientation;
};

type TestCaseMetadata = {
  version: 1;
  name: string;
  extent: CaptureExtent;
  imageCount: number;
  createdAt: string;
  source?: string;
  frames: TestCaseFrameRecord[];
};

export class TestCaseError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TestCaseError";
    this.status = status;
  }
}

function extentForCount(count: number): CaptureExtent | null {
  if (count === CAPTURE_COLUMNS) return "quick";
  if (count === CAPTURE_COLUMNS * 3) return "full";
  return null;
}

export function groupForExtent(extent: CaptureExtent) {
  return extent === "quick" ? `${CAPTURE_COLUMNS}-images` : `${CAPTURE_COLUMNS * 3}-images`;
}

/** Turns any label into a safe folder name. */
export function testCaseSlug(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  return slug || `case-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
}

function isImage(file: string) {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function mimeFor(file: string): ServerPanoramaFrame["mimeType"] {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

async function readMetadata(directory: string): Promise<TestCaseMetadata | null> {
  try {
    const value = JSON.parse(await readFile(path.join(directory, METADATA_FILE), "utf8")) as Partial<TestCaseMetadata>;
    if (value.extent !== "quick" && value.extent !== "full") return null;
    return {
      version: 1,
      name: typeof value.name === "string" ? value.name : path.basename(directory),
      extent: value.extent,
      imageCount: Number(value.imageCount) || 0,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
      source: typeof value.source === "string" ? value.source : undefined,
      frames: Array.isArray(value.frames) ? value.frames : [],
    };
  } catch {
    return null;
  }
}

/**
 * Orders loose photos into plan sequence.  Understands `01.jpg` (1-based
 * sequence), `middle-1.jpg`/`01-middle-1.jpg` (band and 1-based column), and
 * the older `<pitch>-<column>` names such as `35-1.jpg` or `-35-1.jpg`.
 * Anything else falls back to natural file-name order.
 */
export function orderCaseImages(files: readonly string[], extent: CaptureExtent) {
  const bands = getCaptureBands(extent);
  const bandIndex = (id: string) => bands.findIndex((band) => band.id === id);
  const keyed = files.map((file) => {
    const base = path.basename(file, path.extname(file));
    let sequence: number | null = null;
    const named = /(?:^|-)(middle|upper|lower)-(\d+)$/i.exec(base);
    const pitched = /^(-?\d+)-(\d+)$/.exec(base);
    if (named) {
      const band = bandIndex(named[1].toLowerCase());
      if (band >= 0) sequence = band * CAPTURE_COLUMNS + Number(named[2]) - 1;
    } else if (pitched) {
      const pitch = Number(pitched[1]);
      const band = bandIndex(pitch === 0 ? "middle" : pitch > 0 ? "upper" : "lower");
      if (band >= 0) sequence = band * CAPTURE_COLUMNS + Number(pitched[2]) - 1;
    } else if (/^\d+$/.test(base)) {
      sequence = Number(base) - 1;
    }
    return { file, sequence };
  });
  const total = bands.length * CAPTURE_COLUMNS;
  const sequences = new Set(keyed.map((entry) => entry.sequence));
  const complete = keyed.every((entry) => entry.sequence !== null && entry.sequence >= 0 && entry.sequence < total) &&
    sequences.size === keyed.length;
  if (complete) {
    return [...keyed].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((entry) => entry.file);
  }
  return [...files].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function resolveCaseDirectory(casePath: string) {
  const segments = casePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length !== 2 || !segments.every((segment) => SEGMENT_PATTERN.test(segment) && segment !== "..")) {
    throw new TestCaseError("Invalid test case path.");
  }
  const directory = path.join(TEST_CASES_ROOT, ...segments);
  if (!directory.startsWith(TEST_CASES_ROOT + path.sep)) throw new TestCaseError("Invalid test case path.");
  return { directory, group: segments[0], name: segments[1] };
}

export async function discoverTestCases() {
  const cases: TestCaseInfo[] = [];
  const invalid: InvalidTestCase[] = [];
  let groups;
  try {
    groups = await readdir(TEST_CASES_ROOT, { withFileTypes: true });
  } catch {
    return { cases, invalid, root: TEST_CASES_ROOT };
  }

  for (const group of groups) {
    if (!group.isDirectory() || !SEGMENT_PATTERN.test(group.name)) continue;
    const groupDirectory = path.join(TEST_CASES_ROOT, group.name);
    let entries;
    try {
      entries = await readdir(groupDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SEGMENT_PATTERN.test(entry.name)) continue;
      const directory = path.join(groupDirectory, entry.name);
      const casePath = `${group.name}/${entry.name}`;
      const [files, metadata] = await Promise.all([
        readdir(directory).then((names) => names.filter(isImage)).catch(() => [] as string[]),
        readMetadata(directory),
      ]);
      const extent = metadata?.extent ?? extentForCount(files.length);
      const expected = extent ? getCaptureBands(extent).length * CAPTURE_COLUMNS : 0;
      if (!extent || files.length < expected) {
        invalid.push({
          path: casePath,
          imageCount: files.length,
          reason: `Found ${files.length} photos; a case needs ${CAPTURE_COLUMNS} (quick) or ${CAPTURE_COLUMNS * 3} (full).`,
        });
        continue;
      }
      cases.push({
        path: casePath,
        name: metadata?.name ?? entry.name,
        group: group.name,
        extent,
        imageCount: expected,
        hasImu: Boolean(metadata?.frames.some((frame) => parseOrientation(frame.imu))),
        ...(metadata?.createdAt ? { createdAt: metadata.createdAt } : {}),
        ...(metadata?.source ? { source: metadata.source } : {}),
      });
    }
  }

  cases.sort((a, b) => a.imageCount - b.imageCount || a.path.localeCompare(b.path));
  invalid.sort((a, b) => a.path.localeCompare(b.path));
  return { cases, invalid, root: TEST_CASES_ROOT };
}

/** Loads a case as the exact frames the studio would have uploaded. */
export async function loadTestCase(casePath: string) {
  const { directory, name } = resolveCaseDirectory(casePath);
  const [files, metadata] = await Promise.all([
    readdir(directory).then((names) => names.filter(isImage)).catch(() => null),
    readMetadata(directory),
  ]);
  if (!files) throw new TestCaseError("Test case not found.", 404);
  const extent = metadata?.extent ?? extentForCount(files.length);
  if (!extent) {
    throw new TestCaseError(`Found ${files.length} photos; a case needs ${CAPTURE_COLUMNS} or ${CAPTURE_COLUMNS * 3}.`);
  }
  const slots = buildCaptureSlots(extent);
  const records = new Map((metadata?.frames ?? []).map((frame) => [frame.sequence, frame]));
  const available = new Set(files);
  const useMetadata = slots.every((slot) => {
    const file = records.get(slot.sequence)?.file;
    return typeof file === "string" && available.has(path.basename(file));
  });
  const ordered = useMetadata
    ? slots.map((slot) => path.basename(records.get(slot.sequence)!.file))
    : orderCaseImages(files, extent);
  if (ordered.length < slots.length) {
    throw new TestCaseError(`This case has ${ordered.length} photos but the plan needs ${slots.length}.`);
  }

  const frames: ServerPanoramaFrame[] = await Promise.all(slots.map(async (slot, index) => {
    const file = ordered[index];
    const record = useMetadata ? records.get(slot.sequence) : undefined;
    const zoom = Number(record?.zoom);
    return {
      sequence: slot.sequence,
      band: slot.band,
      column: slot.column,
      image: await readFile(path.join(directory, file)),
      zoom: Number.isFinite(zoom) && zoom >= 0.5 && zoom <= 2 ? zoom : 1,
      imu: parseOrientation(record?.imu),
      mimeType: mimeFor(file),
    };
  }));
  return { name: metadata?.name ?? name, extent, frames };
}

async function uniqueCaseDirectory(group: string, slug: string) {
  const groupDirectory = path.join(TEST_CASES_ROOT, group);
  await mkdir(groupDirectory, { recursive: true });
  const existing = new Set(await readdir(groupDirectory));
  let candidate = slug;
  for (let suffix = 2; existing.has(candidate); suffix += 1) candidate = `${slug}-${suffix}`;
  return { groupDirectory, caseName: candidate };
}

/** Writes a complete capture as a new case, atomically. */
export async function saveTestCase(input: {
  name: string;
  extent: CaptureExtent;
  frames: readonly ServerPanoramaFrame[];
  source?: string;
}): Promise<TestCaseInfo> {
  const slots = buildCaptureSlots(input.extent);
  if (input.frames.length !== slots.length) {
    throw new TestCaseError(`A ${input.extent} case needs exactly ${slots.length} photos.`);
  }
  const group = groupForExtent(input.extent);
  const { groupDirectory, caseName } = await uniqueCaseDirectory(group, testCaseSlug(input.name));
  const staging = path.join(groupDirectory, `.${caseName}.staging-${process.pid}-${Date.now()}`);
  const ordered = [...input.frames].sort((a, b) => a.sequence - b.sequence);
  const metadata: TestCaseMetadata = {
    version: 1,
    name: input.name.trim().slice(0, 64) || caseName,
    extent: input.extent,
    imageCount: ordered.length,
    createdAt: new Date().toISOString(),
    ...(input.source ? { source: input.source } : {}),
    frames: ordered.map((frame) => ({
      sequence: frame.sequence,
      band: frame.band,
      column: frame.column,
      file: `${String(frame.sequence + 1).padStart(2, "0")}.${mimeExtension(frame.mimeType)}`,
      zoom: frame.zoom ?? 1,
      ...(frame.imu ? { imu: frame.imu } : {}),
    })),
  };

  try {
    await mkdir(staging);
    await Promise.all(ordered.map((frame, index) =>
      writeFile(path.join(staging, metadata.frames[index].file), frame.image, { flag: "wx" })));
    await writeFile(path.join(staging, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
    await rename(staging, path.join(groupDirectory, caseName));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    path: `${group}/${caseName}`,
    name: metadata.name,
    group,
    extent: input.extent,
    imageCount: ordered.length,
    hasImu: metadata.frames.some((frame) => frame.imu),
    createdAt: metadata.createdAt,
    ...(input.source ? { source: input.source } : {}),
  };
}

function mimeExtension(mimeType: ServerPanoramaFrame["mimeType"]) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

/** Copies a saved studio project's original photos into a permanent case. */
export async function promoteProjectToTestCase(projectId: string, name?: string) {
  const source = await readProjectSource(projectId);
  if (!source) throw new TestCaseError("That project has no saved source photos.", 404);
  return saveTestCase({
    name: name?.trim() || source.name,
    extent: source.extent,
    frames: source.frames,
    source: `project:${projectId}`,
  });
}

