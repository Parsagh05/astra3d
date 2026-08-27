#!/usr/bin/env python3
"""Feature-align a guided Astra3D capture into an equirectangular panorama.

The capture plan supplies eight ordered headings at three pitch bands.  This
worker uses that ordering as a safe prior, then refines adjacent placement with
SIFT features.  When the phone recorded orientation samples (imu.json), they
provide per-pair placement priors, per-frame roll correction, and fallbacks
for low-texture overlaps.  Each tilted band is also registered vertically
against the eye-level ring to measure its true yaw offset and pitch.  OpenCV
handles cylindrical projection, exposure compensation, graph-cut seams, and
multiband blending.  A JSON report is always written so the web app can
request precise retakes instead of returning a broken image.
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
MAX_BAND_YAW_OFFSET = 25.0
MAX_FRAME_ROLL = 15.0


def wrap_degrees(angle: float) -> float:
    return (angle + 180.0) % 360.0 - 180.0


def camera_pose_from_orientation(alpha: float, beta: float, gamma: float) -> tuple[float, float, float]:
    """Converts W3C device-orientation angles into rear-camera yaw/pitch/roll.

    Uses the intrinsic Z-X'-Y'' convention with the world frame x east,
    y north, z up.  Yaw is positive turning right, pitch positive toward the
    ceiling, and roll positive when the top edge tilts toward the right.
    """
    a, b, g = (math.radians(alpha), math.radians(beta), math.radians(gamma))
    ca, sa = math.cos(a), math.sin(a)
    cb, sb = math.cos(b), math.sin(b)
    cg, sg = math.cos(g), math.sin(g)
    # R = Rz(alpha) @ Rx(beta) @ Ry(gamma), device axes -> world axes.
    r01, r11, r21 = -sa * cb, ca * cb, sb
    r02, r12, r22 = ca * sg + sa * sb * cg, sa * sg - ca * sb * cg, cb * cg
    forward = (-r02, -r12, -r22)
    up = (r01, r11, r21)
    yaw = math.degrees(math.atan2(forward[0], forward[1]))
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, forward[2]))))
    horizontal = math.hypot(forward[0], forward[1])
    if horizontal < 1e-6:
        return yaw, pitch, 0.0
    right0 = (forward[1] / horizontal, -forward[0] / horizontal, 0.0)
    up0 = (
        right0[1] * forward[2] - right0[2] * forward[1],
        right0[2] * forward[0] - right0[0] * forward[2],
        right0[0] * forward[1] - right0[1] * forward[0],
    )
    roll = math.degrees(math.atan2(
        up[0] * right0[0] + up[1] * right0[1] + up[2] * right0[2],
        up[0] * up0[0] + up[1] * up0[1] + up[2] * up0[2],
    ))
    return yaw, pitch, roll


def load_imu_poses(input_dir: Path) -> dict[int, tuple[float, float, float]]:
    """Reads optional per-frame orientation samples written by the phone."""
    path = input_dir / "imu.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    poses: dict[int, tuple[float, float, float]] = {}
    for key, value in raw.items():
        try:
            sequence = int(key)
            angles = (float(value["alpha"]), float(value["beta"]), float(value["gamma"]))
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= sequence < CAPTURE_COLUMNS * len(BANDS) and all(math.isfinite(v) for v in angles):
            poses[sequence] = camera_pose_from_orientation(*angles)
    return poses


@dataclass
class PreparedFrame:
    sequence: int
    band: str
    column: int
    source: np.ndarray
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
                    source=image,
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
    expected_dx: float | None = None,
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
    # A measured IMU step allows a tighter plausibility gate than the plan's
    # nominal 45 degrees.
    if expected_dx is not None:
        if abs(float(refined[0]) - expected_dx) > width * 0.22:
            return None
    elif abs(float(refined[0]) - expected_step) > width * 0.34:
        return None
    return float(refined[0]), float(refined[1]), int(len(inliers)), spread


def imu_pair_step(
    imu_poses: dict[int, tuple[float, float, float]],
    previous_sequence: int,
    current_sequence: int,
    focal: float,
) -> tuple[float, float] | None:
    """Predicts the cylindrical (dx, dy) step between two frames from the IMU."""
    previous = imu_poses.get(previous_sequence)
    current = imu_poses.get(current_sequence)
    if previous is None or current is None:
        return None
    yaw_delta = wrap_degrees(current[0] - previous[0])
    pitch_delta = current[1] - previous[1]
    if not 10.0 <= yaw_delta <= 80.0 or abs(pitch_delta) > 20.0:
        return None
    return focal * math.radians(yaw_delta), -focal * math.radians(pitch_delta)


def band_positions(
    band_frames: list[PreparedFrame],
    horizontal_fov: float,
    imu_poses: dict[int, tuple[float, float, float]],
) -> tuple[list[float], list[float], float, list[int], list[dict[str, Any]]]:
    width = float(band_frames[0].image.shape[1])
    focal = (width * 0.5) / math.tan(math.radians(horizontal_fov * 0.5))
    nominal_step = width * (45.0 / horizontal_fov)
    estimates: list[tuple[float, float]] = []
    weak_pairs: list[int] = []
    pair_reports: list[dict[str, Any]] = []

    for column in range(CAPTURE_COLUMNS):
        previous = band_frames[column]
        current = band_frames[(column + 1) % CAPTURE_COLUMNS]
        imu_step = imu_pair_step(imu_poses, previous.sequence, current.sequence, focal)
        estimate = estimate_pair(
            previous,
            current,
            horizontal_fov,
            imu_step[0] if imu_step is not None else None,
        )
        if estimate is None:
            estimates.append(imu_step if imu_step is not None else (nominal_step, 0.0))
            weak_pairs.append(column)
            pair_reports.append({
                "from": previous.sequence,
                "to": current.sequence,
                "inliers": 0,
                "fallback": True,
                "imu": imu_step is not None,
            })
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


def ring_yaws(x_positions: list[float], circumference: float) -> list[float]:
    return [x * 360.0 / circumference for x in x_positions]


def estimate_band_alignment(
    middle_frames: list[PreparedFrame],
    other_frames: list[PreparedFrame],
    horizontal_fov: float,
    direction: int,
    middle_yaws: list[float],
    other_yaws: list[float],
) -> tuple[float, float, int] | None:
    """Matches each column against the eye-level band to measure the tilted
    band's true yaw offset and pitch instead of trusting the guided targets.

    `direction` is +1 for the upper band and -1 for the lower band.  Returns
    (yaw offset in degrees, measured band pitch in degrees, matched columns).
    """
    width = float(middle_frames[0].image.shape[1])
    height = float(middle_frames[0].image.shape[0])
    focal = (width * 0.5) / math.tan(math.radians(horizontal_fov * 0.5))
    center_y = (height - 1.0) * 0.5
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    offset_estimates: list[float] = []
    pitch_estimates: list[float] = []
    matched_columns = 0

    for column in range(CAPTURE_COLUMNS):
        middle = middle_frames[column]
        other = other_frames[column]
        if middle.descriptors is None or other.descriptors is None:
            continue
        candidates = matcher.knnMatch(middle.descriptors, other.descriptors, k=2)
        samples: list[tuple[float, float]] = []
        for pair in candidates:
            if len(pair) != 2 or pair[0].distance >= 0.72 * pair[1].distance:
                continue
            match = pair[0]
            p_mid = middle.keypoints[match.queryIdx].pt
            p_oth = other.keypoints[match.trainIdx].pt
            dx = p_mid[0] - p_oth[0]
            dy = p_mid[1] - p_oth[1]
            if abs(dx) > width * 0.30:
                continue
            if not 0.30 * focal <= dy * direction * -1.0 <= 1.05 * focal:
                continue
            pitch_sample = math.degrees(
                math.atan2(center_y - p_mid[1], focal) - math.atan2(center_y - p_oth[1], focal)
            )
            yaw_sample = math.degrees(dx / focal)
            samples.append((yaw_sample, pitch_sample))
        if len(samples) < MIN_PAIR_INLIERS:
            continue
        values = np.asarray(samples, dtype=np.float32)
        median = np.median(values, axis=0)
        residuals = np.linalg.norm(values - median, axis=1)
        threshold = max(0.75, float(np.median(residuals) * 2.8))
        inliers = values[residuals <= threshold]
        if len(inliers) < MIN_PAIR_INLIERS:
            continue
        refined = np.median(inliers, axis=0)
        pitch_estimate = float(refined[1])
        if not 24.0 <= pitch_estimate * direction <= 46.0:
            continue
        # The tilted band's cylindrical warp compresses azimuth by roughly
        # cos(pitch), so the raw x delta underestimates the yaw difference.
        yaw_delta = float(refined[0]) / max(0.5, math.cos(math.radians(pitch_estimate)))
        offset_estimates.append(
            wrap_degrees(middle_yaws[column] + yaw_delta - other_yaws[column])
        )
        pitch_estimates.append(pitch_estimate)
        matched_columns += 1

    if matched_columns < 2:
        return None
    yaw_offset = float(np.median(np.asarray(offset_estimates, dtype=np.float32)))
    band_pitch = float(np.median(np.asarray(pitch_estimates, dtype=np.float32)))
    if abs(yaw_offset) > MAX_BAND_YAW_OFFSET:
        return None
    return yaw_offset, band_pitch, matched_columns


def imu_band_alignment(
    imu_poses: dict[int, tuple[float, float, float]],
    band_index: int,
    nominal_pitch: float,
    middle_yaws: list[float],
    other_yaws: list[float],
) -> tuple[float, float] | None:
    """Falls back to IMU headings when vertical matching finds no columns."""
    offsets: list[float] = []
    pitches: list[float] = []
    for column in range(CAPTURE_COLUMNS):
        middle_pose = imu_poses.get(column)
        other_pose = imu_poses.get(band_index * CAPTURE_COLUMNS + column)
        if middle_pose is None or other_pose is None:
            continue
        offsets.append(wrap_degrees(
            middle_yaws[column] + wrap_degrees(other_pose[0] - middle_pose[0]) - other_yaws[column]
        ))
        pitches.append(other_pose[1] - middle_pose[1])
    if len(offsets) < 3:
        return None
    yaw_offset = float(np.median(np.asarray(offsets, dtype=np.float32)))
    band_pitch = float(np.median(np.asarray(pitches, dtype=np.float32)))
    if abs(yaw_offset) > MAX_BAND_YAW_OFFSET or abs(band_pitch - nominal_pitch) > 12.0:
        return None
    return yaw_offset, band_pitch


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


def mask_column_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    occupied = np.any(mask > 0, axis=0).astype(np.uint8)
    padded = np.pad(occupied, (1, 1))
    changes = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(changes == 1)
    ends = np.flatnonzero(changes == -1)
    return [(int(start), int(end)) for start, end in zip(starts, ends) if end - start >= 3]


def spherical_layers(
    frame: PreparedFrame,
    yaw_degrees: float,
    pitch_degrees: float,
    horizontal_fov: float,
    longitude_sin: np.ndarray,
    longitude_cos: np.ndarray,
    latitude_sin: np.ndarray,
    latitude_cos: np.ndarray,
    roll_degrees: float = 0.0,
) -> list[tuple[np.ndarray, np.ndarray, tuple[int, int]]]:
    source_height, source_width = frame.source.shape[:2]
    focal = (source_width * 0.5) / math.tan(math.radians(horizontal_fov * 0.5))
    world_x = latitude_cos[:, None] * longitude_sin[None, :]
    world_y = latitude_sin[:, None]
    world_z = latitude_cos[:, None] * longitude_cos[None, :]

    yaw = math.radians(yaw_degrees)
    pitch = math.radians(pitch_degrees)
    # Invert Ry(yaw) * Rx(-pitch) to transform each world ray into
    # this camera. Positive pitch therefore points toward the ceiling.
    local_x = math.cos(yaw) * world_x - math.sin(yaw) * world_z
    yaw_local_z = math.sin(yaw) * world_x + math.cos(yaw) * world_z
    local_y = math.cos(pitch) * world_y - math.sin(pitch) * yaw_local_z
    local_z = math.sin(pitch) * world_y + math.cos(pitch) * yaw_local_z

    if abs(roll_degrees) > 0.05:
        # IMU-measured roll: positive tilts the camera's top toward its right.
        roll = math.radians(roll_degrees)
        rolled_x = math.cos(roll) * local_x - math.sin(roll) * local_y
        local_y = math.cos(roll) * local_y + math.sin(roll) * local_x
        local_x = rolled_x

    safe_z = np.where(local_z > 1e-5, local_z, 1.0)
    map_x = (focal * local_x / safe_z + (source_width - 1) * 0.5).astype(np.float32)
    map_y = ((source_height - 1) * 0.5 - focal * local_y / safe_z).astype(np.float32)
    valid = (
        (local_z > 1e-5)
        & (map_x >= 0)
        & (map_x <= source_width - 1)
        & (map_y >= 0)
        & (map_y <= source_height - 1)
    )
    mask = valid.astype(np.uint8) * 255
    projected = cv2.remap(
        frame.source,
        map_x,
        map_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )

    layers: list[tuple[np.ndarray, np.ndarray, tuple[int, int]]] = []
    for start, end in mask_column_runs(mask):
        segment = mask[:, start:end]
        occupied_rows = np.flatnonzero(np.any(segment > 0, axis=1))
        if occupied_rows.size == 0:
            continue
        top, bottom = int(occupied_rows[0]), int(occupied_rows[-1] + 1)
        layers.append(
            (
                projected[top:bottom, start:end].copy(),
                mask[top:bottom, start:end].copy(),
                (start, top),
            )
        )
    return layers


def build_layers(
    frames: list[PreparedFrame],
    positions: dict[str, tuple[list[float], list[float], float]],
    band_alignment: dict[str, tuple[float, float]],
    frame_rolls: dict[int, float],
    output_width: int,
    output_height: int,
    horizontal_fov: float,
) -> tuple[list[np.ndarray], list[np.ndarray], list[tuple[int, int]]]:
    images: list[np.ndarray] = []
    masks: list[np.ndarray] = []
    corners: list[tuple[int, int]] = []
    longitude = np.arange(output_width, dtype=np.float32) * (2.0 * np.pi / output_width)
    latitude = np.pi * 0.5 - np.arange(output_height, dtype=np.float32) * (np.pi / output_height)
    longitude_sin = np.sin(longitude)
    longitude_cos = np.cos(longitude)
    latitude_sin = np.sin(latitude)
    latitude_cos = np.cos(latitude)

    for band_index, (band, _) in enumerate(BANDS):
        x_positions, y_positions, circumference = positions[band]
        yaw_offset, band_pitch = band_alignment[band]
        band_frames = frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS]
        for column, frame in enumerate(band_frames):
            yaw = x_positions[column] * 360.0 / circumference + yaw_offset
            registration_focal = (frame.image.shape[1] * 0.5) / math.tan(math.radians(horizontal_fov * 0.5))
            pitch_correction = math.degrees(math.atan2(y_positions[column], registration_focal))
            for image, mask, corner in spherical_layers(
                frame,
                yaw,
                band_pitch - pitch_correction,
                horizontal_fov,
                longitude_sin,
                longitude_cos,
                latitude_sin,
                latitude_cos,
                frame_rolls.get(frame.sequence, 0.0),
            ):
                images.append(image)
                masks.append(mask)
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
    resolved_masks = finder.find(seam_images, seam_corners, seam_masks)
    for index, seam_mask in enumerate(resolved_masks):
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
    input_dir = Path(args.input)
    imu_poses = load_imu_poses(input_dir)
    frames = prepare_frames(input_dir, registration_width, effective_fov)
    positions: dict[str, tuple[list[float], list[float], float]] = {}
    weak_by_band: dict[str, list[int]] = {}
    pair_reports: list[dict[str, Any]] = []
    for band_index, (band, _) in enumerate(BANDS):
        band_frames = frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS]
        x_positions, y_positions, circumference, weak_pairs, reports = band_positions(
            band_frames,
            effective_fov,
            imu_poses,
        )
        positions[band] = (x_positions, y_positions, circumference)
        weak_by_band[band] = weak_pairs
        pair_reports.extend(reports)

    # Register the tilted bands against the eye-level ring so a drifted sweep
    # start or an imprecise tilt no longer shears the panorama vertically.
    middle_yaw_ring = ring_yaws(positions["middle"][0], positions["middle"][2])
    band_alignment: dict[str, tuple[float, float]] = {"middle": (0.0, 0.0)}
    cross_band_report: dict[str, Any] = {}
    for band_index, (band, nominal_pitch) in enumerate(BANDS):
        if band == "middle":
            continue
        band_yaw_ring = ring_yaws(positions[band][0], positions[band][2])
        direction = 1 if nominal_pitch > 0 else -1
        alignment = estimate_band_alignment(
            frames[0:CAPTURE_COLUMNS],
            frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS],
            effective_fov,
            direction,
            middle_yaw_ring,
            band_yaw_ring,
        )
        if alignment is not None:
            yaw_offset, band_pitch, matched_columns = alignment
            band_alignment[band] = (yaw_offset, band_pitch)
            cross_band_report[band] = {
                "source": "features",
                "columns": matched_columns,
                "yawOffset": round(yaw_offset, 2),
                "pitch": round(band_pitch, 2),
            }
            continue
        imu_alignment = imu_band_alignment(
            imu_poses, band_index, nominal_pitch, middle_yaw_ring, band_yaw_ring,
        )
        if imu_alignment is not None:
            band_alignment[band] = imu_alignment
            cross_band_report[band] = {
                "source": "imu",
                "columns": 0,
                "yawOffset": round(imu_alignment[0], 2),
                "pitch": round(imu_alignment[1], 2),
            }
        else:
            band_alignment[band] = (0.0, nominal_pitch)
            cross_band_report[band] = {"source": "plan", "columns": 0}

    # IMU roll deviations from the eye-level median keep hand wobble from
    # tilting individual views without rotating the whole panorama.
    frame_rolls: dict[int, float] = {}
    middle_rolls = [imu_poses[s][2] for s in range(CAPTURE_COLUMNS) if s in imu_poses]
    if middle_rolls:
        reference_roll = float(np.median(np.asarray(middle_rolls, dtype=np.float32)))
        for sequence, pose in imu_poses.items():
            roll = wrap_degrees(pose[2] - reference_roll)
            frame_rolls[sequence] = max(-MAX_FRAME_ROLL, min(MAX_FRAME_ROLL, roll))

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
    images, masks, corners = build_layers(
        frames,
        positions,
        band_alignment,
        frame_rolls,
        blend_width,
        blend_height,
        effective_fov,
    )
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
        "method": "opencv-sift-spherical-v4",
        "alignmentScore": round(alignment_score, 3),
        "matchedPairs": matched_pairs,
        "fallbackPairs": fallback_pairs,
        "coverage": round(coverage_ratio, 3),
        "blendResolution": [blend_width, blend_height],
        "retakeSequences": retake_sequences,
        "warnings": warnings,
        "pairs": pair_reports,
        "blurScores": [round(frame.blur_score, 1) for frame in frames],
        "imuFrames": len(imu_poses),
        "crossBand": cross_band_report,
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
