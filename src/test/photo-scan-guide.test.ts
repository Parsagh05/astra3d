import { describe, expect, it } from "vitest";

import {
  addPhoto,
  createPhotoGuide,
  isBlurredPhoto,
  MAX_SCAN_PHOTOS,
  MIN_SCAN_PHOTOS,
  photoCoverageFraction,
  photoCoveredCells,
  photoHint,
  replayPhotos,
  type PhotoGuide,
} from "@/lib/photo-scan-guide";
import { SCAN_HEADINGS } from "@/lib/scan-coverage";

function forward(yawDeg: number, pitchDeg: number): [number, number, number] {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

/** Two photos per 30° heading (two steps), going round once at `pitch`. */
function loop(start: PhotoGuide, pitch: number) {
  let guide = start;
  for (let heading = 0; heading < 360; heading += 30) {
    guide = addPhoto(guide, forward(heading, pitch));
    guide = addPhoto(guide, forward(heading + 8, pitch));
  }
  return guide;
}

describe("photo scan guide", () => {
  it("starts by explaining step-photo-step", () => {
    expect(photoHint(createPhotoGuide(), false).text).toMatch(/small step sideways/);
  });

  it("counts a direction once it is photographed from two spots", () => {
    let guide = addPhoto(createPhotoGuide(), forward(0, 0));
    expect(photoCoveredCells(guide)[1][0]).toBe(false);
    guide = addPhoto(guide, forward(5, 0));
    expect(photoCoveredCells(guide)[1][0]).toBe(true);
    expect(photoCoveredCells(guide)[0][0]).toBe(false);
  });

  it("walks through eye level, floor and ceiling, then asks for more photos", () => {
    let guide = loop(createPhotoGuide(), 0);
    expect(photoCoveredCells(guide)[1].filter(Boolean)).toHaveLength(SCAN_HEADINGS);
    expect(photoHint(guide, true).text).toMatch(/tilt down/);
    guide = loop(guide, -35);
    expect(photoHint(guide, true).text).toMatch(/tilt up/);
    guide = loop(guide, 35);
    expect(photoCoverageFraction(guide)).toBe(1);
    // 72 photos: past the recommended count.
    expect(photoHint(guide, true)).toMatchObject({ tone: "good" });
  });

  it("warns about a big turn between photos", () => {
    const guide = addPhoto(addPhoto(createPhotoGuide(), forward(0, 0)), forward(70, 0));
    expect(guide.lastTurn).toBeCloseTo(70);
    expect(photoHint(guide, true)).toMatchObject({ tone: "warn", text: expect.stringMatching(/turn less/) });
  });

  it("works without motion sensors, by count", () => {
    let guide = createPhotoGuide();
    for (let index = 0; index < 5; index += 1) guide = addPhoto(guide, null);
    expect(photoHint(guide, false).text).toMatch(new RegExp(`at least ${MIN_SCAN_PHOTOS}`));
    for (let index = 0; index < MAX_SCAN_PHOTOS; index += 1) guide = addPhoto(guide, null);
    expect(photoHint(guide, false).text).toMatch(/maximum/);
  });

  it("rebuilds the same guide when replaying after undo", () => {
    const directions = [forward(0, 0), null, forward(20, 0), forward(40, -30)];
    const live = directions.reduce<PhotoGuide>((guide, direction) => addPhoto(guide, direction), createPhotoGuide());
    expect(replayPhotos(directions)).toEqual(live);
    expect(replayPhotos(directions.slice(0, -1)).photos).toBe(3);
  });

  it("refuses a photo far blurrier than the typical one, but not a blank wall at the start", () => {
    expect(isBlurredPhoto(5, [])).toBe(false);
    expect(isBlurredPhoto(5, [300, 280, 320])).toBe(true);
    expect(isBlurredPhoto(200, [300, 280, 320])).toBe(false);
    // Featureless scenes score near zero; never treat them as blur.
    expect(isBlurredPhoto(0, [300, 280, 320])).toBe(false);
    expect(isBlurredPhoto(2, [8, 9, 10])).toBe(false);
  });
});
