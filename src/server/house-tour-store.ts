import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeTourInput } from "@/lib/house-tour";
import type { HouseTour } from "@/types/house-tour";

/**
 * House tours are small JSON files, one per tour, in <data>/tours/<id>.json.
 * They only reference studio projects by id; the panoramas stay in
 * <data>/projects/ and are served by the projects API.
 */

const TOUR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredTour = HouseTour & { version: 1 };

export class TourStoreError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TourStoreError";
    this.status = status;
  }
}

function toursRoot() {
  const dataRoot = process.env.ASTRA3D_DATA_DIR
    ? path.resolve(process.env.ASTRA3D_DATA_DIR)
    : path.join(process.cwd(), ".astra3d-data");
  return path.join(dataRoot, "tours");
}

function tourFile(id: string) {
  return TOUR_ID_PATTERN.test(id) ? path.join(toursRoot(), `${id.toLowerCase()}.json`) : null;
}

function publicTour(tour: StoredTour): HouseTour {
  return {
    id: tour.id,
    name: tour.name,
    createdAt: tour.createdAt,
    updatedAt: tour.updatedAt,
    startSpotId: tour.startSpotId,
    spots: tour.spots,
  };
}

async function readTour(file: string): Promise<StoredTour | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<StoredTour>;
    if (value?.version !== 1 || typeof value.id !== "string") return null;
    // Re-validate on read so a hand-edited file cannot break the viewer.
    const clean = sanitizeTourInput(value);
    if (typeof clean === "string") return null;
    return {
      version: 1,
      id: value.id,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      ...clean,
    };
  } catch {
    return null;
  }
}

async function writeTour(tour: StoredTour) {
  const file = tourFile(tour.id);
  if (!file) throw new TourStoreError("Tour not found.", 404);
  await mkdir(toursRoot(), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(tour, null, 2), "utf8");
  await rename(temporary, file);
}

export async function listTours() {
  const root = toursRoot();
  await mkdir(root, { recursive: true });
  const names = (await readdir(root)).filter((name) => name.endsWith(".json") && TOUR_ID_PATTERN.test(name.slice(0, -5)));
  const tours = await Promise.all(names.map((name) => readTour(path.join(root, name))));
  return tours
    .filter((tour): tour is StoredTour => tour !== null)
    .map(publicTour)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getTour(id: string) {
  const file = tourFile(id);
  const tour = file ? await readTour(file) : null;
  return tour ? publicTour(tour) : null;
}

export async function createTour(input: unknown) {
  const clean = sanitizeTourInput(input);
  if (typeof clean === "string") throw new TourStoreError(clean, 400);
  const now = new Date().toISOString();
  const tour: StoredTour = { version: 1, id: randomUUID(), createdAt: now, updatedAt: now, ...clean };
  await writeTour(tour);
  return publicTour(tour);
}

export async function updateTour(id: string, input: unknown) {
  const file = tourFile(id);
  const existing = file ? await readTour(file) : null;
  if (!existing) throw new TourStoreError("Tour not found.", 404);
  const clean = sanitizeTourInput(input);
  if (typeof clean === "string") throw new TourStoreError(clean, 400);
  const tour: StoredTour = { ...existing, ...clean, updatedAt: new Date().toISOString() };
  await writeTour(tour);
  return publicTour(tour);
}

export async function deleteTour(id: string) {
  const file = tourFile(id);
  if (!file || !(await readTour(file))) throw new TourStoreError("Tour not found.", 404);
  await rm(file, { force: true });
}

/** A tour is a few KB of JSON; anything far larger is not one. */
const MAX_TOUR_BYTES = 256 * 1024;

/** Reads a tour from a request body, refusing oversized or malformed JSON. */
export async function readTourBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TOUR_BYTES) throw new TourStoreError("The tour is too large.", 413);
  const text = await request.text();
  if (text.length > MAX_TOUR_BYTES) throw new TourStoreError("The tour is too large.", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TourStoreError("The tour is not valid JSON.", 400);
  }
}

/** Exposed for tests. */
export const tourStorePaths = { toursRoot };
