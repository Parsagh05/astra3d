/**
 * House tour rules shared by the server (validation) and the viewer
 * (navigation and placing arrows).  Pure functions only.
 */

import { clamp, clampPanoramaView, shortestAngleDelta, wrapDegrees, type PanoramaViewInput, type SphericalPoint } from "@/components/tour/tour-math";
import type { HouseTour, HouseTourInput, HouseTourLink, HouseTourSpot } from "@/types/house-tour";

export const MAX_TOUR_SPOTS = 40;
export const MAX_LINKS_PER_SPOT = 12;
/** Arrows sit between the floor and just above eye level. */
export const LINK_PITCH_RANGE: [number, number] = [-70, 20];
/** "Forward" (W / up arrow) takes the arrow within this angle of the view. */
export const FORWARD_LINK_ANGLE = 60;

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cleanTourText(value: unknown, fallback: string, maxLength = 60) {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
  return text || fallback;
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function roundAngle(value: number) {
  return Math.round(value * 100) / 100;
}

export function newTourItemId() {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return random.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

/**
 * Validates and normalises a tour sent by the editor.  Unknown fields are
 * dropped, angles wrapped and clamped, arrows to missing spots or to the
 * spot itself removed.  Returns an error string for input that cannot be a
 * tour at all.
 */
export function sanitizeTourInput(value: unknown): HouseTourInput | string {
  if (!value || typeof value !== "object") return "The tour is missing.";
  const candidate = value as Partial<Record<keyof HouseTourInput, unknown>>;
  if (!Array.isArray(candidate.spots) || candidate.spots.length === 0) return "A tour needs at least one room.";
  if (candidate.spots.length > MAX_TOUR_SPOTS) return `A tour can have up to ${MAX_TOUR_SPOTS} rooms.`;

  const spots: HouseTourSpot[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of candidate.spots.entries()) {
    if (!raw || typeof raw !== "object") return "A room in the tour is invalid.";
    const spot = raw as Partial<Record<keyof HouseTourSpot, unknown>>;
    if (typeof spot.id !== "string" || !ITEM_ID.test(spot.id) || seen.has(spot.id)) return "A room in the tour has an invalid id.";
    if (typeof spot.projectId !== "string" || !PROJECT_ID.test(spot.projectId)) return "A room in the tour does not point at a saved 360° project.";
    seen.add(spot.id);
    spots.push({
      id: spot.id,
      projectId: spot.projectId.toLowerCase(),
      name: cleanTourText(spot.name, `Room ${index + 1}`, 48),
      startYaw: roundAngle(wrapDegrees(finiteNumber(spot.startYaw))),
      links: Array.isArray(spot.links) ? (spot.links as unknown[]).filter((link): link is Record<string, unknown> => !!link && typeof link === "object").map((link) => ({
        id: typeof link.id === "string" ? link.id : "",
        targetSpotId: typeof link.targetSpotId === "string" ? link.targetSpotId : "",
        yaw: roundAngle(wrapDegrees(finiteNumber(link.yaw))),
        pitch: roundAngle(clamp(finiteNumber(link.pitch, -20), ...LINK_PITCH_RANGE)),
      })) : [],
    });
  }

  for (const spot of spots) {
    const linkIds = new Set<string>();
    spot.links = spot.links.filter((link) => {
      if (!ITEM_ID.test(link.id) || linkIds.has(link.id)) return false;
      if (link.targetSpotId === spot.id || !seen.has(link.targetSpotId)) return false;
      linkIds.add(link.id);
      return true;
    }).slice(0, MAX_LINKS_PER_SPOT);
  }

  const startSpotId = typeof candidate.startSpotId === "string" && seen.has(candidate.startSpotId)
    ? candidate.startSpotId
    : spots[0].id;
  return { name: cleanTourText(candidate.name, "My house"), startSpotId, spots };
}

export function findSpot(tour: Pick<HouseTour, "spots">, spotId: string) {
  return tour.spots.find((spot) => spot.id === spotId) ?? null;
}

/**
 * Which way the visitor faces after moving `from` → `to`.  Like Street View,
 * you keep walking forward: if `to` has an arrow back to `from`, you face
 * directly away from it.  Otherwise the target spot's start view.
 */
export function arrivalYaw(tour: Pick<HouseTour, "spots">, fromSpotId: string, toSpotId: string) {
  const target = findSpot(tour, toSpotId);
  if (!target) return 0;
  const back = target.links.find((link) => link.targetSpotId === fromSpotId);
  return back ? wrapDegrees(back.yaw + 180) : target.startYaw;
}

/** The arrow closest to where the visitor looks, if one is roughly ahead. */
export function linkAhead(spot: HouseTourSpot, viewYaw: number): HouseTourLink | null {
  let best: HouseTourLink | null = null;
  let bestDelta = FORWARD_LINK_ANGLE;
  for (const link of spot.links) {
    const delta = Math.abs(shortestAngleDelta(viewYaw, link.yaw));
    if (delta <= bestDelta) {
      best = link;
      bestDelta = delta;
    }
  }
  return best;
}

/** Spots that have no arrow pointing at them (unreachable unless picked from the list). */
export function unreachableSpots(tour: Pick<HouseTour, "spots" | "startSpotId">) {
  const reached = new Set([tour.startSpotId]);
  for (const spot of tour.spots) for (const link of spot.links) reached.add(link.targetSpotId);
  return tour.spots.filter((spot) => !reached.has(spot.id));
}

/** Adds (or moves) the arrow from `spotId` to `targetSpotId`. */
export function placeLink(tour: HouseTourInput, spotId: string, targetSpotId: string, point: SphericalPoint): HouseTourInput {
  if (spotId === targetSpotId) return tour;
  return {
    ...tour,
    spots: tour.spots.map((spot) => {
      if (spot.id !== spotId) return spot;
      const existing = spot.links.find((link) => link.targetSpotId === targetSpotId);
      const placed: HouseTourLink = {
        id: existing?.id ?? newTourItemId(),
        targetSpotId,
        yaw: roundAngle(wrapDegrees(point.yaw)),
        pitch: roundAngle(clamp(point.pitch, ...LINK_PITCH_RANGE)),
      };
      const others = spot.links.filter((link) => link.targetSpotId !== targetSpotId);
      return { ...spot, links: [...others, placed].slice(-MAX_LINKS_PER_SPOT) };
    }),
  };
}

export function removeLink(tour: HouseTourInput, spotId: string, linkId: string): HouseTourInput {
  return {
    ...tour,
    spots: tour.spots.map((spot) => spot.id === spotId ? { ...spot, links: spot.links.filter((link) => link.id !== linkId) } : spot),
  };
}

/** Removes a spot and every arrow that led to it. */
export function removeSpot(tour: HouseTourInput, spotId: string): HouseTourInput {
  const spots = tour.spots
    .filter((spot) => spot.id !== spotId)
    .map((spot) => ({ ...spot, links: spot.links.filter((link) => link.targetSpotId !== spotId) }));
  return { ...tour, spots, startSpotId: tour.startSpotId === spotId ? spots[0]?.id ?? "" : tour.startSpotId };
}

/**
 * The inverse of projectSphericalPoint: which panorama direction is under
 * the viewport pixel (x, y).  Used to place an arrow where the editor clicks.
 */
export function unprojectViewportPoint(
  x: number,
  y: number,
  view: PanoramaViewInput,
  viewportWidth: number,
  viewportHeight: number,
): SphericalPoint {
  const safe = clampPanoramaView(view);
  const yaw = (safe.yaw * Math.PI) / 180;
  const pitch = (safe.pitch * Math.PI) / 180;
  const focal = viewportHeight / (2 * Math.tan(((safe.fov * Math.PI) / 180) / 2));
  const cameraX = (x - viewportWidth / 2) / focal;
  const cameraY = -(y - viewportHeight / 2) / focal;
  const right = [Math.cos(yaw), 0, Math.sin(yaw)];
  const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
  const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const direction = [0, 1, 2].map((axis) => right[axis] * cameraX + up[axis] * cameraY + forward[axis]);
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  return {
    yaw: wrapDegrees((Math.atan2(direction[0], -direction[2]) * 180) / Math.PI),
    pitch: (Math.asin(clamp(direction[1] / length, -1, 1)) * 180) / Math.PI,
  };
}
