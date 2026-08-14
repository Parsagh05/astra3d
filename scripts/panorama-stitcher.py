#!/usr/bin/env python3
"""Feature-align a guided Astra3D capture into an equirectangular panorama.

The capture plan supplies eight ordered headings at three pitch bands.  This
worker uses that ordering as a safe prior, then refines adjacent placement with
SIFT features.  OpenCV handles cylindrical projection, exposure compensation,
graph-cut seams, and multiband blending.  A JSON report is always written so
the web app can request precise retakes instead of returning a broken image.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np


CAPTURE_COLUMNS = 8
BANDS = (("middle", 0.0), ("upper", 35.0), ("lower", -35.0))
MIN_KEYPOINTS = 24
MIN_PAIR_INLIERS = 9


@dataclass
class PreparedFrame:
    sequence: int
    band: str
    column: int
    image: np.ndarray
    mask: np.ndarray
    gray: np.ndarray
    keypoints: list[Any]
    descriptors: np.ndarray | None
    blur_score: float


class CaptureQualityError(RuntimeError):
    def __init__(self, message: str, retake_sequences: list[int]):
        super().__init__(message)
        self.retake_sequences = sorted(set(retake_sequences))[:8]


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def load_frame(path: Path) -> np.ndarray:
    encoded = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise CaptureQualityError("One of the captured photographs could not be decoded.", [])
    return image


def resize_for_registration(image: np.ndarray, target_width: int) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(1.0, target_width / float(width))
    if scale == 1.0:
        return image
    return cv2.resize(
        image,
        (max(2, round(width * scale)), max(2, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def cylindrical_warp(image: np.ndarray, horizontal_fov: float) -> tuple[np.ndarray, np.ndarray]:
    height, width = image.shape[:2]
    focal = (width * 0.5) / math.tan(math.radians(horizontal_fov * 0.5))
    y_grid, x_grid = np.indices((height, width), dtype=np.float32)
    theta = (x_grid - (width - 1) * 0.5) / focal
    vertical = (y_grid - (height - 1) * 0.5) / focal
    source_x = focal * np.tan(theta) + (width - 1) * 0.5
    source_y = focal * vertical / np.cos(theta) + (height - 1) * 0.5
    valid = (
        (source_x >= 0)
        & (source_x <= width - 1)
        & (source_y >= 0)
        & (source_y <= height - 1)
    )
    warped = cv2.remap(
        image,
        source_x,
        source_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )
    mask = (valid.astype(np.uint8) * 255)
    return warped, mask


def prepare_frames(input_dir: Path, registration_width: int, horizontal_fov: float) -> list[PreparedFrame]:
    detector = cv2.SIFT_create(nfeatures=1400, contrastThreshold=0.025, edgeThreshold=14)
    frames: list[PreparedFrame] = []
    for band_index, (band, _) in enumerate(BANDS):
        for column in range(CAPTURE_COLUMNS):
            sequence = band_index * CAPTURE_COLUMNS + column
            image = resize_for_registration(load_frame(input_dir / f"{sequence:03d}.frame"), registration_width)
            warped, mask = cylindrical_warp(image, horizontal_fov)
            gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
            blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            feature_mask = mask.copy()
            border = max(4, round(feature_mask.shape[1] * 0.04))
            feature_mask[:, :border] = 0
            feature_mask[:, -border:] = 0
            keypoints, descriptors = detector.detectAndCompute(gray, feature_mask)
            frames.append(
                PreparedFrame(
                    sequence=sequence,
                    band=band,
                    column=column,
                    image=warped,
                    mask=mask,
                    gray=gray,
                    keypoints=keypoints,
                    descriptors=descriptors,
                    blur_score=blur_score,
                )
            )
    return frames


def estimate_pair(
    previous: PreparedFrame,
    current: PreparedFrame,
    horizontal_fov: float,
) -> tuple[float, float, int, float] | None:
    if previous.descriptors is None or current.descriptors is None:
        return None

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    candidates = matcher.knnMatch(previous.descriptors, current.descriptors, k=2)
    width = min(previous.image.shape[1], current.image.shape[1])
    expected_step = width * (45.0 / horizontal_fov)
    deltas: list[tuple[float, float]] = []
    for pair in candidates:
        if len(pair) != 2 or pair[0].distance >= 0.72 * pair[1].distance:
            continue
        match = pair[0]
        p0 = previous.keypoints[match.queryIdx].pt
        p1 = current.keypoints[match.trainIdx].pt
        dx = p0[0] - p1[0]
        dy = p0[1] - p1[1]
        if width * 0.28 <= dx <= width * 0.92 and abs(dy) <= previous.image.shape[0] * 0.22:
            deltas.append((dx, dy))

    if len(deltas) < MIN_PAIR_INLIERS:
        return None

    values = np.asarray(deltas, dtype=np.float32)
    median = np.median(values, axis=0)
    residuals = np.linalg.norm(values - median, axis=1)
    threshold = max(3.0, float(np.median(residuals) * 2.8))
    inliers = values[residuals <= threshold]
    if len(inliers) < MIN_PAIR_INLIERS:
        return None
    refined = np.median(inliers, axis=0)
    spread = float(np.median(np.linalg.norm(inliers - refined, axis=1)))
    if abs(float(refined[0]) - expected_step) > width * 0.34:
        return None
    return float(refined[0]), float(refined[1]), int(len(inliers)), spread


def band_positions(
    band_frames: list[PreparedFrame],
    horizontal_fov: float,
) -> tuple[list[float], list[float], float, list[int], list[dict[str, Any]]]:
    width = float(band_frames[0].image.shape[1])
    nominal_step = width * (45.0 / horizontal_fov)
    estimates: list[tuple[float, float]] = []
    weak_pairs: list[int] = []
    pair_reports: list[dict[str, Any]] = []

    for column in range(CAPTURE_COLUMNS):
        previous = band_frames[column]
        current = band_frames[(column + 1) % CAPTURE_COLUMNS]
        estimate = estimate_pair(previous, current, horizontal_fov)
        if estimate is None:
            estimates.append((nominal_step, 0.0))
            weak_pairs.append(column)
            pair_reports.append({"from": previous.sequence, "to": current.sequence, "inliers": 0, "fallback": True})
            continue
        dx, dy, inliers, spread = estimate
        estimates.append((dx, dy))
        pair_reports.append(
            {
                "from": previous.sequence,
                "to": current.sequence,
                "inliers": inliers,
                "spread": round(spread, 2),
                "fallback": False,
            }
        )

    # The last pair closes the ring.  Distributing closure drift prevents a
    # visible jump at 0/360 degrees while preserving the measured local steps.
    circumference = max(width * 3.4, sum(dx for dx, _ in estimates))
    vertical_closure = sum(dy for _, dy in estimates)
    corrected_dy = [dy - vertical_closure / CAPTURE_COLUMNS for _, dy in estimates]
    x_positions = [0.0]
    y_positions = [0.0]
    for index in range(CAPTURE_COLUMNS - 1):
        x_positions.append(x_positions[-1] + estimates[index][0])
        y_positions.append(y_positions[-1] + corrected_dy[index])
    return x_positions, y_positions, circumference, weak_pairs, pair_reports


def choose_retakes(frames: list[PreparedFrame], weak_by_band: dict[str, list[int]]) -> list[int]:
    retakes: set[int] = set()
    blur_scores = np.asarray([frame.blur_score for frame in frames], dtype=np.float32)
    blur_floor = max(16.0, float(np.percentile(blur_scores, 20) * 0.48))
    for frame in frames:
        if frame.blur_score < blur_floor or len(frame.keypoints) < MIN_KEYPOINTS:
            retakes.add(frame.sequence)

    for band_index, (band, _) in enumerate(BANDS):
        band_frames = frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS]
        for column in weak_by_band[band]:
            candidates = (band_frames[column], band_frames[(column + 1) % CAPTURE_COLUMNS])
            weaker = min(candidates, key=lambda frame: (len(frame.keypoints), frame.blur_score))
            retakes.add(weaker.sequence)
    return sorted(retakes)


def clip_layer(
    image: np.ndarray,
    mask: np.ndarray,
    left: int,
    top: int,
    canvas_width: int,
    canvas_height: int,
) -> tuple[np.ndarray, np.ndarray, tuple[int, int]] | None:
    height, width = image.shape[:2]
    x0, y0 = max(0, left), max(0, top)
    x1, y1 = min(canvas_width, left + width), min(canvas_height, top + height)
    if x1 <= x0 or y1 <= y0:
        return None
    source_x, source_y = x0 - left, y0 - top
    return (
        image[source_y : source_y + (y1 - y0), source_x : source_x + (x1 - x0)],
        mask[source_y : source_y + (y1 - y0), source_x : source_x + (x1 - x0)],
        (x0, y0),
    )


def build_layers(
    frames: list[PreparedFrame],
    positions: dict[str, tuple[list[float], list[float], float]],
    output_width: int,
    output_height: int,
) -> tuple[list[np.ndarray], list[np.ndarray], list[tuple[int, int]]]:
    images: list[np.ndarray] = []
    masks: list[np.ndarray] = []
    corners: list[tuple[int, int]] = []
    reference_circumference = positions["middle"][2]
    global_scale = output_width / reference_circumference

    for band_index, (band, pitch) in enumerate(BANDS):
        x_positions, y_positions, circumference = positions[band]
        band_scale = global_scale * reference_circumference / circumference
        band_frames = frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS]
        for column, frame in enumerate(band_frames):
            frame_width = max(8, round(frame.image.shape[1] * band_scale))
            frame_height = max(8, round(frame.image.shape[0] * band_scale))
            interpolation = cv2.INTER_AREA if band_scale < 1 else cv2.INTER_LINEAR
            image = cv2.resize(frame.image, (frame_width, frame_height), interpolation=interpolation)
            mask = cv2.resize(frame.mask, (frame_width, frame_height), interpolation=cv2.INTER_NEAREST)
            x = round(x_positions[column] * output_width / circumference)
            pitch_offset = pitch * output_width / 360.0
            y = round(output_height * 0.5 - pitch_offset - frame_height * 0.5 + y_positions[column] * band_scale)
            for wrapped_x in (x - output_width, x, x + output_width):
                clipped = clip_layer(image, mask, wrapped_x, y, output_width, output_height)
                if clipped is None:
                    continue
                clipped_image, clipped_mask, corner = clipped
                if clipped_image.shape[0] < 4 or clipped_image.shape[1] < 4:
                    continue
                images.append(clipped_image)
                masks.append(clipped_mask)
                corners.append(corner)
    return images, masks, corners


def compensate_exposure(images: list[np.ndarray], masks: list[np.ndarray], corners: list[tuple[int, int]]) -> None:
    compensator = cv2.detail.ExposureCompensator_createDefault(cv2.detail.ExposureCompensator_GAIN_BLOCKS)
    compensator.feed(corners=corners, images=images, masks=masks)
    for index in range(len(images)):
        compensator.apply(index, corners[index], images[index], masks[index])


def find_seams(images: list[np.ndarray], masks: list[np.ndarray], corners: list[tuple[int, int]]) -> None:
    seam_scale = 0.28
    seam_images: list[np.ndarray] = []
    seam_masks: list[np.ndarray] = []
    seam_corners: list[tuple[int, int]] = []
    for image, mask, (left, top) in zip(images, masks, corners):
        width = max(2, round(image.shape[1] * seam_scale))
        height = max(2, round(image.shape[0] * seam_scale))
        seam_images.append(cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA).astype(np.float32))
        seam_masks.append(cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST))
        seam_corners.append((round(left * seam_scale), round(top * seam_scale)))
    finder = cv2.detail_GraphCutSeamFinder("COST_COLOR_GRAD")
    finder.find(seam_images, seam_corners, seam_masks)
    for index, seam_mask in enumerate(seam_masks):
        masks[index] = cv2.resize(
            seam_mask,
            (masks[index].shape[1], masks[index].shape[0]),
            interpolation=cv2.INTER_NEAREST,
        )


def multiband_blend(
    images: list[np.ndarray],
    masks: list[np.ndarray],
    corners: list[tuple[int, int]],
    output_width: int,
    output_height: int,
) -> np.ndarray:
    blender = cv2.detail_MultiBandBlender()
    blender.setNumBands(max(3, min(7, int(math.log2(output_width)) - 6)))
    blender.prepare((0, 0, output_width, output_height))
    for image, mask, corner in zip(images, masks, corners):
        blender.feed(image.astype(np.int16), mask, corner)
    result, result_mask = blender.blend(None, None)
    result = np.clip(result, 0, 255).astype(np.uint8)

    holes = result_mask == 0
    if np.any(holes):
        # Only fill uncovered pole slivers. Large central holes indicate an
        # invalid capture and are caught before this stage by coverage checks.
        nearest = cv2.inpaint(result, holes.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
        result[holes] = nearest[holes]
    return result


def process(args: argparse.Namespace) -> dict[str, Any]:
    if args.width < 640 or args.height < 320 or args.width != args.height * 2:
        raise ValueError("Output dimensions must use a supported 2:1 size.")

    registration_width = min(640, max(320, round(args.width / 5.0)))
    effective_fov = math.degrees(
        2.0 * math.atan(math.tan(math.radians(args.horizontal_fov * 0.5)) / args.zoom)
    )
    effective_fov = max(48.0, min(112.0, effective_fov))
    frames = prepare_frames(Path(args.input), registration_width, effective_fov)
    positions: dict[str, tuple[list[float], list[float], float]] = {}
    weak_by_band: dict[str, list[int]] = {}
    pair_reports: list[dict[str, Any]] = []
    for band_index, (band, _) in enumerate(BANDS):
        band_frames = frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS]
        x_positions, y_positions, circumference, weak_pairs, reports = band_positions(
            band_frames,
            effective_fov,
        )
        positions[band] = (x_positions, y_positions, circumference)
        weak_by_band[band] = weak_pairs
        pair_reports.extend(reports)

    retake_sequences = choose_retakes(frames, weak_by_band)
    fallback_pairs = sum(len(pairs) for pairs in weak_by_band.values())
    if fallback_pairs > 9 or len(retake_sequences) > 6:
        human_directions = ", ".join(str(sequence + 1) for sequence in retake_sequences[:6])
        suffix = f" Retake directions {human_directions}." if human_directions else ""
        raise CaptureQualityError(
            "The photographs do not contain enough sharp overlap for reliable alignment." + suffix,
            retake_sequences,
        )

    # Seam finding and pyramid blending scale superlinearly.  A 1920-wide
    # working panorama retains more than enough seam detail for phone viewing,
    # then a single high-quality resize produces the requested 3072 export
    # without exhausting a normal laptop's memory.
    blend_width = min(args.width, 1920)
    blend_height = blend_width // 2
    images, masks, corners = build_layers(frames, positions, blend_width, blend_height)
    coverage = np.zeros((blend_height, blend_width), dtype=np.uint8)
    for mask, (left, top) in zip(masks, corners):
        target = coverage[top : top + mask.shape[0], left : left + mask.shape[1]]
        np.maximum(target, mask, out=target)
    central = coverage[round(blend_height * 0.12) : round(blend_height * 0.88)]
    coverage_ratio = float(np.count_nonzero(central) / central.size)
    if coverage_ratio < 0.92:
        raise CaptureQualityError(
            "The room coverage has large gaps. Keep the phone at one point and overlap every target.",
            retake_sequences,
        )

    compensate_exposure(images, masks, corners)
    find_seams(images, masks, corners)
    panorama = multiband_blend(images, masks, corners, blend_width, blend_height)
    if blend_width != args.width:
        panorama = cv2.resize(panorama, (args.width, args.height), interpolation=cv2.INTER_LANCZOS4)
    if not cv2.imwrite(str(args.output), panorama, [cv2.IMWRITE_JPEG_QUALITY, args.quality]):
        raise RuntimeError("OpenCV could not encode the panorama.")

    matched_pairs = len(pair_reports) - fallback_pairs
    alignment_score = matched_pairs / len(pair_reports)
    warnings: list[str] = []
    if fallback_pairs:
        warnings.append(
            f"{fallback_pairs} overlap{'s used' if fallback_pairs != 1 else ' used'} guided placement because visual detail was limited."
        )
    return {
        "ok": True,
        "method": "opencv-sift-cylindrical-v2",
        "alignmentScore": round(alignment_score, 3),
        "matchedPairs": matched_pairs,
        "fallbackPairs": fallback_pairs,
        "coverage": round(coverage_ratio, 3),
        "blendResolution": [blend_width, blend_height],
        "retakeSequences": retake_sequences,
        "warnings": warnings,
        "pairs": pair_reports,
        "blurScores": [round(frame.blur_score, 1) for frame in frames],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--horizontal-fov", type=float, default=72.0)
    parser.add_argument("--zoom", type=float, default=1.0)
    args = parser.parse_args()
    report_path = Path(args.report)
    try:
        report = process(args)
        write_report(report_path, report)
        return 0
    except CaptureQualityError as error:
        write_report(
            report_path,
            {
                "ok": False,
                "code": "QUALITY_CHECK_FAILED",
                "message": str(error),
                "retakeSequences": error.retake_sequences,
            },
        )
        return 2
    except Exception as error:  # Return safe detail to Node; stderr retains type.
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        write_report(
            report_path,
            {
                "ok": False,
                "code": "PROCESSING_FAILED",
                "message": "OpenCV could not reconstruct this capture.",
                "retakeSequences": [],
            },
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
