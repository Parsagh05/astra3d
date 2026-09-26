#!/usr/bin/env python3
"""Stitch a guided Astra3D capture into an equirectangular panorama.

Every photograph is placed on the sphere by bundle adjustment (see
sphere_alignment.py): features are matched between all overlapping photos,
and each photo's full 3D rotation plus the shared lens focal length are
solved together.  When the phone recorded orientation samples (imu.json),
gravity keeps the horizon level and pitch and sideways tilt are corrected per
photo, and sensor headings hold photos that found no visual match.  Exposure
and white balance are equalised in linear light from the matched points,
then OpenCV handles block gain compensation, graph-cut seams and multiband
blending.  A JSON report is always written so the web app can request
precise retakes instead of returning a broken image.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sphere_alignment import (  # noqa: E402
    FORWARD,
    Alignment,
    Keyframe,
    align_capture,
    camera_rotation,
    detect_features,
    heading_of,
    heading_rotation,
    pitch_of,
    roll_of,
    rotation_from_orientation,
)


class StageTimer:
    """Coarse stage timings printed to stderr for laptop diagnostics."""

    def __init__(self) -> None:
        self.started = time.perf_counter()
        self.last = self.started

    def mark(self, stage: str) -> None:
        now = time.perf_counter()
        print(f"astra3d-stitch {stage}: {now - self.last:.1f}s", file=sys.stderr)
        self.last = now


CAPTURE_COLUMNS = 12
# A frame reaches pitch +/- vFOV/2, so the tilt decides how much ceiling and
# floor a sweep photographs.  50 closes the pole caps on a typical 4:3 phone
# and an ultrawide and cuts them to 6 degrees on the narrowest 3:4 crop.
# Must match BAND_TILT_DEGREES in src/lib/capture-plan.ts.
BAND_TILT = 50.0
BANDS = (("middle", 0.0), ("upper", BAND_TILT), ("lower", -BAND_TILT))
MIN_PAIR_INLIERS = 12
# Full-resolution photo stills are projected at up to this width; the
# lightweight registration copies stay much smaller.
MAX_SOURCE_WIDTH = 2048
# Native blend canvas cap.  4096 (11 px/°) is blended natively instead of
# upscaled from 3072, which only added blur, and it is the largest texture
# most phones' WebGL can show.  6144 doubled the time and needed 3.4 GB.
MAX_BLEND_WIDTH = 4096
# Capture advice thresholds, in degrees.
TURN_TOLERANCE = 7.0
TILT_TOLERANCE = 6.0
ROLL_TOLERANCE = 8.0


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


def load_imu_rotations(input_dir: Path) -> dict[int, np.ndarray]:
    """Exact rear-camera rotations from the phone's orientation samples."""
    path = input_dir / "imu.json"
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    rotations: dict[int, np.ndarray] = {}
    for key, value in raw.items():
        try:
            sequence = int(key)
            angles = (float(value["alpha"]), float(value["beta"]), float(value["gamma"]))
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= sequence < CAPTURE_COLUMNS * len(BANDS) and all(math.isfinite(v) for v in angles):
            rotations[sequence] = rotation_from_orientation(*angles)
    return rotations


@dataclass
class PreparedFrame:
    sequence: int
    band: str
    column: int
    source: np.ndarray
    image: np.ndarray
    gray: np.ndarray
    points: np.ndarray
    descriptors: np.ndarray | None
    blur_score: float
    focus_score: float
    fused: bool = False


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


def load_fused_frame(input_dir: Path, sequence: int) -> tuple[np.ndarray, bool]:
    """Loads a still and, when a short-exposure companion exists, Mertens-fuses
    the pair after MTB alignment to recover blown-out window highlights."""
    image = load_frame(input_dir / f"{sequence:03d}.frame")
    bracket_path = input_dir / f"{sequence:03d}.bracket"
    if not bracket_path.exists():
        return image, False
    try:
        dark = load_frame(bracket_path)
    except CaptureQualityError:
        return image, False
    if dark.shape != image.shape:
        return image, False
    try:
        stack = [image, dark]
        cv2.createAlignMTB().process(stack, stack)
        fused = cv2.createMergeMertens().process(stack)
        return np.clip(fused * 255.0, 0, 255).astype(np.uint8), True
    except cv2.error:
        return image, False


def focus_from_gray(gray: np.ndarray) -> float:
    """Detail retained relative to the contrast actually present.

    Raw Laplacian variance cannot tell a photograph apart from the surface it
    shows: a perfectly focused bare wall scores lower than a blurred bookshelf
    simply because a wall has nothing to resolve.  Dividing by the frame's own
    contrast asks the honest question instead - given how much this view could
    show, how much survived - so featureless walls score healthily while true
    motion blur collapses toward zero.
    """
    detail = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    contrast = float(gray.astype(np.float32).var())
    return detail / max(contrast, 1.0)


def prepare_frames(input_dir: Path, registration_width: int) -> list[PreparedFrame]:
    """Loads every photo and finds its features on an undistorted copy.

    Registration works on the plain photograph: a pinhole camera is exactly
    what bundle adjustment models, so nothing has to be approximated by a
    cylinder first.
    """
    detector = cv2.SIFT_create(nfeatures=1600, contrastThreshold=0.02, edgeThreshold=14)
    frames: list[PreparedFrame] = []
    for band_index, (band, _) in enumerate(BANDS):
        for column in range(CAPTURE_COLUMNS):
            sequence = band_index * CAPTURE_COLUMNS + column
            loaded, fused = load_fused_frame(input_dir, sequence)
            source = resize_for_registration(loaded, MAX_SOURCE_WIDTH)
            image = resize_for_registration(source, registration_width)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            points, descriptors = detect_features(gray, detector)
            frames.append(
                PreparedFrame(
                    sequence=sequence,
                    band=band,
                    column=column,
                    source=source,
                    image=image,
                    gray=gray,
                    points=points,
                    descriptors=descriptors,
                    blur_score=float(cv2.Laplacian(gray, cv2.CV_64F).var()),
                    focus_score=focus_from_gray(gray),
                    fused=fused,
                )
            )
    return frames


def capture_priors(
    frames: list[PreparedFrame],
    imu_rotations: dict[int, np.ndarray],
) -> list[tuple[np.ndarray, bool]]:
    """Starting rotation for every photo, and whether a sensor measured it.

    Sensor headings are relative (the gyro starts anywhere), so they are
    turned as a whole to put the first measured photo on its planned
    heading; pitch and sideways tilt come from gravity and stay absolute.
    """
    band_pitch = dict(BANDS)
    nominal = {frame.sequence: frame.column * 360.0 / CAPTURE_COLUMNS for frame in frames}
    reference = next((frame.sequence for frame in frames if frame.sequence in imu_rotations), None)
    base = np.eye(3)
    if reference is not None:
        base = heading_rotation(nominal[reference] - heading_of(imu_rotations[reference]))
    priors: list[tuple[np.ndarray, bool]] = []
    for frame in frames:
        if frame.sequence in imu_rotations:
            priors.append((base @ imu_rotations[frame.sequence], True))
        else:
            priors.append((camera_rotation(nominal[frame.sequence], band_pitch[frame.band]), False))
    return priors


def choose_retakes(
    frames: list[PreparedFrame],
    weak_by_band: dict[str, list[int]],
) -> list[int]:
    """Names the frames worth re-photographing, driven by alignment outcomes.

    Only overlaps that actually failed to align produce a retake.  Per-frame
    texture statistics decide which half of a failed pair to blame, never
    whether a retake is needed at all: a bare wall photographed perfectly is
    still a perfectly good photograph, and asking for it again would not
    change anything.
    """
    retakes: set[int] = set()
    for band_index, (band, _) in enumerate(BANDS):
        band_frames = frames[band_index * CAPTURE_COLUMNS : (band_index + 1) * CAPTURE_COLUMNS]
        for column in weak_by_band[band]:
            candidates = (band_frames[column], band_frames[(column + 1) % CAPTURE_COLUMNS])
            weaker = min(candidates, key=lambda frame: (frame.focus_score, len(frame.points)))
            retakes.add(weaker.sequence)
    return sorted(retakes)


def blurred_sequences(frames: list[PreparedFrame]) -> list[int]:
    """Frames whose detail collapsed far below the rest of the capture.

    Reported as advice only.  A genuinely unusable frame also fails to align,
    and the pair logic above is what turns that into a retake request.
    """
    scores = np.asarray([frame.focus_score for frame in frames], dtype=np.float32)
    floor = float(np.median(scores)) * 0.15
    return [frame.sequence for frame in frames if frame.focus_score < floor]


SRGB_GAMMA = 2.2


def estimate_gains(frames: list[PreparedFrame], alignment: Alignment) -> np.ndarray:
    """Per-photo, per-channel gains that make overlapping photos agree.

    Phones re-expose and re-balance every shot.  The same scene point is
    seen at each matched feature, so the ratio of its colour between two
    photos is exactly their relative gain.  Gains are solved in linear light
    (what exposure actually scales) by least squares over all matched pairs,
    anchored so the capture keeps its typical brightness.
    """
    count = len(frames)
    blurred = [
        (cv2.blur(frame.image, (7, 7)).astype(np.float32) / 255.0) ** SRGB_GAMMA
        for frame in frames
    ]
    rows: list[tuple[int, int, np.ndarray, float]] = []
    for pair in alignment.pairs:
        first, second = blurred[pair.first], blurred[pair.second]
        height, width = first.shape[:2]
        xa = np.clip(pair.points_first[:, 0].round().astype(int), 0, width - 1)
        ya = np.clip(pair.points_first[:, 1].round().astype(int), 0, height - 1)
        xb = np.clip(pair.points_second[:, 0].round().astype(int), 0, width - 1)
        yb = np.clip(pair.points_second[:, 1].round().astype(int), 0, height - 1)
        color_a, color_b = first[ya, xa], second[yb, xb]
        usable = np.all((color_a > 0.004) & (color_a < 0.93) & (color_b > 0.004) & (color_b < 0.93), axis=1)
        if usable.sum() < 6:
            continue
        ratio = np.median(np.log(color_a[usable]) - np.log(color_b[usable]), axis=0)
        rows.append((pair.first, pair.second, ratio, float(usable.sum())))
    gains = np.ones((count, 3))
    if not rows:
        return gains
    for channel in range(3):
        normal = np.eye(count) * 0.02
        target = np.zeros(count)
        for first, second, ratio, weight in rows:
            # gain_first * colour_first = gain_second * colour_second
            normal[first, first] += weight
            normal[second, second] += weight
            normal[first, second] -= weight
            normal[second, first] -= weight
            target[first] -= weight * ratio[channel]
            target[second] += weight * ratio[channel]
        log_gain = np.linalg.solve(normal, target)
        log_gain -= np.median(log_gain)
        gains[:, channel] = np.exp(log_gain)
    return np.clip(gains, 0.4, 2.5)


def apply_gains(image: np.ndarray, gains: np.ndarray) -> np.ndarray:
    levels = np.arange(256, dtype=np.float32) / 255.0
    channels = []
    for channel in range(3):
        table = np.clip((levels ** SRGB_GAMMA * gains[channel]) ** (1 / SRGB_GAMMA) * 255.0 + 0.5, 0, 255)
        channels.append(cv2.LUT(image[:, :, channel], table.astype(np.uint8)))
    return cv2.merge(channels)


def mask_column_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    occupied = np.any(mask > 0, axis=0).astype(np.uint8)
    padded = np.pad(occupied, (1, 1))
    changes = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(changes == 1)
    ends = np.flatnonzero(changes == -1)
    return [(int(start), int(end)) for start, end in zip(starts, ends) if end - start >= 3]


def spherical_layers(
    source: np.ndarray,
    rotation: np.ndarray,
    focal: float,
    longitude: np.ndarray,
    latitude: np.ndarray,
) -> list[tuple[np.ndarray, np.ndarray, tuple[int, int]]]:
    """Projects one photo onto the equirectangular canvas.

    Column 0 of the canvas is heading zero and headings grow to the right;
    the top row looks straight up.  Only the rows the photo can reach are
    computed.
    """
    source_height, source_width = source.shape[:2]
    forward = rotation @ FORWARD
    centre_latitude = math.asin(max(-1.0, min(1.0, float(forward[1]))))
    reach = math.atan(math.hypot(source_width, source_height) * 0.5 / focal) + 0.02
    rows = np.flatnonzero(np.abs(latitude - centre_latitude) <= reach)
    if rows.size == 0:
        return []
    row_start, row_end = int(rows[0]), int(rows[-1] + 1)
    lat = latitude[row_start:row_end]
    world = np.empty((row_end - row_start, longitude.size, 3), dtype=np.float32)
    world[..., 0] = np.cos(lat)[:, None] * np.sin(longitude)[None, :]
    world[..., 1] = np.sin(lat)[:, None]
    world[..., 2] = -np.cos(lat)[:, None] * np.cos(longitude)[None, :]
    local = world @ rotation.astype(np.float32)
    depth = -local[..., 2]
    safe = np.where(depth > 1e-4, depth, 1.0)
    map_x = (focal * local[..., 0] / safe + (source_width - 1) * 0.5).astype(np.float32)
    map_y = ((source_height - 1) * 0.5 - focal * local[..., 1] / safe).astype(np.float32)
    valid = (depth > 1e-4) & (map_x >= 0) & (map_x <= source_width - 1) & (map_y >= 0) & (map_y <= source_height - 1)
    mask = valid.astype(np.uint8) * 255
    projected = cv2.remap(source, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

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
                (start, row_start + top),
            )
        )
    return layers


def build_layers(
    frames: list[PreparedFrame],
    alignment: Alignment,
    output_width: int,
    output_height: int,
) -> tuple[list[np.ndarray], list[np.ndarray], list[tuple[int, int]]]:
    images: list[np.ndarray] = []
    masks: list[np.ndarray] = []
    corners: list[tuple[int, int]] = []
    longitude = (np.arange(output_width, dtype=np.float32) * (2.0 * np.pi / output_width)).astype(np.float32)
    latitude = (np.pi * 0.5 - (np.arange(output_height, dtype=np.float32) + 0.5) * (np.pi / output_height)).astype(np.float32)
    for frame, rotation in zip(frames, alignment.rotations):
        focal = alignment.focal * frame.source.shape[1] / frame.image.shape[1]
        for image, mask, corner in spherical_layers(frame.source, rotation, focal, longitude, latitude):
            images.append(image)
            masks.append(mask)
            corners.append(corner)
    return images, masks, corners


def compensate_exposure(
    images: list[np.ndarray],
    masks: list[np.ndarray],
    corners: list[tuple[int, int]],
    feed_scale: float = 0.35,
) -> None:
    """Balances exposure across layers.

    The block-gain estimation scales quadratically with overlap area, so the
    compensator is fed quarter-scale copies (as OpenCV's own stitching sample
    does) and its interpolated gain maps are applied at full resolution.
    """
    compensator = cv2.detail.ExposureCompensator_createDefault(cv2.detail.ExposureCompensator_GAIN_BLOCKS)
    small_images: list[np.ndarray] = []
    small_masks: list[np.ndarray] = []
    small_corners: list[tuple[int, int]] = []
    for image, mask, (left, top) in zip(images, masks, corners):
        width = max(2, round(image.shape[1] * feed_scale))
        height = max(2, round(image.shape[0] * feed_scale))
        small_images.append(cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA))
        small_masks.append(cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST))
        small_corners.append((round(left * feed_scale), round(top * feed_scale)))
    compensator.feed(corners=small_corners, images=small_images, masks=small_masks)
    for index in range(len(images)):
        compensator.apply(index, corners[index], images[index], masks[index])


def find_seams(
    images: list[np.ndarray],
    masks: list[np.ndarray],
    corners: list[tuple[int, int]],
    seam_scale: float = 0.28,
) -> None:
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
) -> tuple[np.ndarray, np.ndarray]:
    blender = cv2.detail_MultiBandBlender()
    blender.setNumBands(max(3, min(7, int(math.log2(output_width)) - 6)))
    blender.prepare((0, 0, output_width, output_height))
    for image, mask, corner in zip(images, masks, corners):
        blender.feed(image.astype(np.int16), mask, corner)
    result, result_mask = blender.blend(None, None)
    return np.clip(result, 0, 255).astype(np.uint8), result_mask


def smooth_ring_colors(colors: np.ndarray, kernel_width: int) -> np.ndarray:
    """Circularly smooths one row of colors across the panorama's longitude."""
    kernel_width = max(3, kernel_width | 1)
    pad = kernel_width
    wrapped = np.concatenate([colors[-pad:], colors, colors[:pad]], axis=0)
    blurred = cv2.blur(wrapped[None, :, :], (kernel_width, 1))[0]
    return blurred[pad:-pad]


def fill_polar_holes(
    result: np.ndarray,
    result_mask: np.ndarray,
    trim_degrees: float = 0.6,
) -> None:
    """Fills the pole caps with a smooth gradient toward the ring of nearest
    trusted pixels.

    Replaces diffusion inpainting, which took minutes at 3K+ output sizes.
    Only a hairline just inside the coverage boundary is discarded, where the
    multiband blend fades against the empty canvas.  This used to be 8°,
    which replaced real photographed curtain rails, ceiling lights and the
    bottom of furniture with the smooth fill.  The margin follows the
    coverage rather than a fixed latitude, so a capture that saw more of the
    floor keeps it.
    """
    valid = result_mask != 0
    height, width = valid.shape
    rows = np.arange(height, dtype=np.float32)[:, None]
    column_index = np.arange(width)
    row_grid = np.arange(height)[:, None]
    trim = max(1, round(height * trim_degrees / 180.0))
    top_first = np.clip(
        np.where(valid, row_grid, height).min(axis=0) + trim, 0, height - 1,
    )
    bottom_last = np.clip(
        np.where(valid, row_grid, -1).max(axis=0) - trim, 0, height - 1,
    )
    # A column with no coverage at all has nothing to fade toward.
    empty = ~valid.any(axis=0)
    top_first[empty] = height - 1
    bottom_last[empty] = 0

    above = row_grid < top_first[None, :]
    if np.any(above):
        boundary = result[np.clip(top_first, 0, height - 1), column_index].astype(np.float32)
        boundary = smooth_ring_colors(boundary, width // 48)
        pole = smooth_ring_colors(boundary, width // 8)
        # 0 at the pole row, 1 at the covered boundary.
        weight = (rows / np.maximum(top_first[None, :], 1).astype(np.float32)).clip(0, 1)[..., None]
        fill = pole[None, :, :] * (1 - weight) + boundary[None, :, :] * weight
        result[above] = np.clip(fill, 0, 255).astype(np.uint8)[above]

    below = row_grid > bottom_last[None, :]
    if np.any(below):
        boundary = result[np.clip(bottom_last, 0, height - 1), column_index].astype(np.float32)
        boundary = smooth_ring_colors(boundary, width // 48)
        pole = smooth_ring_colors(boundary, width // 8)
        depth = np.maximum(height - 1 - bottom_last[None, :], 1).astype(np.float32)
        weight = ((height - 1 - rows) / depth).clip(0, 1)[..., None]
        fill = pole[None, :, :] * (1 - weight) + boundary[None, :, :] * weight
        result[below] = np.clip(fill, 0, 255).astype(np.uint8)[below]

    # Any interior pinholes left between covered rows are small; diffusion
    # inpainting stays affordable at that size.
    remaining = (~valid) & ~above & ~below
    if np.any(remaining):
        patched = cv2.inpaint(result, remaining.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
        result[remaining] = patched[remaining]


def measure_horizontal_fov(
    input_dir: Path,
    learned: "Any | None",
    default_fov: float = 72.0,
    imu_turns: dict[int, float] | None = None,
) -> tuple[float, bool]:
    """Recovers the camera's horizontal field of view from the capture itself.

    A sweep returns to where it started, so the eye-level turns must add up to
    one full circle.  That single constraint pins the focal length: guess it
    too short and the measured turns overshoot 360 degrees, too long and they
    fall short.  Phones rarely report a usable focal length and a 3:4 crop, a
    16:9 crop and an ultrawide all differ by tens of degrees, so measuring
    beats assuming.

    When the phone measured each turn (`imu_turns`), every pair is compared
    with its own turn instead of assuming a perfect 30° step; handheld turns
    range from 20° to 40° and would otherwise skew the lens.  This is only
    the starting point: bundle adjustment refines the focal afterwards.
    """
    frames = []
    for column in range(CAPTURE_COLUMNS):
        path = input_dir / f"{column:03d}.frame"
        if not path.exists():
            return default_fov, False
        image = resize_for_registration(load_frame(path), 700)
        frames.append(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))

    width = frames[0].shape[1]
    centre = (width - 1) * 0.5
    detector = cv2.SIFT_create(nfeatures=1400, contrastThreshold=0.025, edgeThreshold=14)
    correspondences: list[tuple[np.ndarray, np.ndarray] | None] = []
    for column in range(CAPTURE_COLUMNS):
        first, second = frames[column], frames[(column + 1) % CAPTURE_COLUMNS]
        points = None
        # Repeating wardrobe panels and patterned rugs make SIFT confident and
        # wrong, which is fatal here: one bad turn skews the whole lens
        # estimate.  The learned matcher leads when it is installed.
        if learned is not None and learned.available():
            matched = learned.match_pair(first, second)
            if len(matched) >= 12:
                points = (matched[:, 0:2], matched[:, 2:4])
        if points is None:
            keys_a, desc_a = detector.detectAndCompute(first, None)
            keys_b, desc_b = detector.detectAndCompute(second, None)
            if desc_a is not None and desc_b is not None and len(desc_a) > 1 and len(desc_b) > 1:
                pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc_a, desc_b, k=2)
                good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.72 * p[1].distance]
                if len(good) >= 12:
                    points = (
                        np.array([keys_a[g.queryIdx].pt for g in good], dtype=np.float32),
                        np.array([keys_b[g.trainIdx].pt for g in good], dtype=np.float32),
                    )
        if points is None:
            correspondences.append(None)
            continue
        vertical = points[0][:, 1] - points[1][:, 1]
        keep = np.abs(vertical - np.median(vertical)) < first.shape[0] * 0.05
        if keep.sum() < 12:
            correspondences.append(None)
            continue
        horizontal = points[0][keep, 0] - points[1][keep, 0]
        # A blank wall can return many confident matches that all sit where
        # they started.  They describe no turn at all, and averaging them in
        # would make the sweep look slower than it was and the lens wider.
        if abs(float(np.median(horizontal))) < width * 0.08:
            correspondences.append(None)
            continue
        correspondences.append((points[0][keep, 0], points[1][keep, 0], column))

    usable = [c for c in correspondences if c is not None]
    if len(usable) < max(3, CAPTURE_COLUMNS // 2):
        return default_fov, False

    # Every turn of one sweep goes the same way; a pair that disagrees is a
    # mismatch, not a change of heart.
    directions = [float(np.median(a - b)) for a, b, _ in usable]
    forward = sum(1 for d in directions if d > 0) >= len(directions) / 2
    usable = [c for c, d in zip(usable, directions) if (d > 0) == forward]
    if len(usable) < max(3, CAPTURE_COLUMNS // 2):
        return default_fov, False

    nominal_turn = 2.0 * math.pi / CAPTURE_COLUMNS
    turns = imu_turns or {}

    def typical_turn(focal: float) -> float:
        angles = []
        for first_x, second_x, column in usable:
            turn = np.arctan((first_x - centre) / focal) - np.arctan((second_x - centre) / focal)
            median = np.median(turn)
            spread = np.median(np.abs(turn - median))
            inliers = turn[np.abs(turn - median) <= max(math.radians(0.5), spread * 3)]
            if len(inliers) >= 12:
                # Scale each pair to the step it really was, when measured.
                scale = nominal_turn / math.radians(turns[column]) if column in turns else 1.0
                angles.append(abs(float(np.median(inliers))) * scale)
        return float(np.median(angles)) if angles else 0.0

    # The sweep is aimed at even steps, so the typical (scaled) turn should
    # be one step of the circle.  Turn angle shrinks as the focal grows,
    # which makes the search monotonic.
    low, high = width * 0.20, width * 6.0
    for _ in range(50):
        middle = (low + high) * 0.5
        if typical_turn(middle) > nominal_turn:
            low = middle
        else:
            high = middle
    focal = (low + high) * 0.5
    fov = math.degrees(2.0 * math.atan((width * 0.5) / focal))
    if not 30.0 <= fov <= 120.0:
        return default_fov, False
    return fov, True


def capture_advice(
    frames: list[PreparedFrame],
    alignment: Alignment,
    gains: np.ndarray,
) -> tuple[list[str], list[dict[str, float]]]:
    """Plain-language notes on how the photos were taken, from the solve."""
    angles = [
        {
            "sequence": frame.sequence,
            "yaw": round(heading_of(rotation), 1),
            "pitch": round(pitch_of(rotation), 1),
            "roll": round(roll_of(rotation), 1),
        }
        for frame, rotation in zip(frames, alignment.rotations)
    ]
    notes: list[str] = []
    band_pitch = dict(BANDS)
    uneven: list[str] = []
    for band_index, (band, _) in enumerate(BANDS):
        for column in range(CAPTURE_COLUMNS):
            first = angles[band_index * CAPTURE_COLUMNS + column]
            second = angles[band_index * CAPTURE_COLUMNS + (column + 1) % CAPTURE_COLUMNS]
            turn = (second["yaw"] - first["yaw"]) % 360.0
            if abs(turn - 360.0 / CAPTURE_COLUMNS) > TURN_TOLERANCE:
                uneven.append(f"{first['sequence'] + 1}→{second['sequence'] + 1} ({turn:.0f}°)")
    if uneven:
        notes.append(
            "Uneven turns between photos " + ", ".join(uneven[:4])
            + ". Stop on each dot; about 30° per step keeps enough overlap."
        )
    middle = [angle for angle, frame in zip(angles, frames) if frame.band == "middle"]
    mean_pitch = float(np.mean([angle["pitch"] - band_pitch["middle"] for angle in middle]))
    if abs(mean_pitch) > TILT_TOLERANCE:
        notes.append(
            f"The phone pointed {abs(mean_pitch):.0f}° {'down' if mean_pitch < 0 else 'up'} on average at eye level. "
            "Hold it level so the ceiling and floor edges are photographed evenly."
        )
    tilted = [angle for angle in angles if abs(angle["roll"]) > ROLL_TOLERANCE]
    if tilted:
        notes.append(
            "Photo" + ("s " if len(tilted) > 1 else " ")
            + ", ".join(f"{angle['sequence'] + 1} ({abs(angle['roll']):.0f}°)" for angle in tilted[:5])
            + " were tilted sideways. It was corrected, but an upright phone keeps more of each photo."
        )
    brightness = gains.mean(axis=1)
    if brightness.max() / max(brightness.min(), 1e-3) > 1.35:
        notes.append(
            "Brightness changed a lot between photos and was evened out. "
            "Locking exposure (the capture does this when the phone allows it) avoids it."
        )
    return notes, angles


def adjacent_pair_reports(
    frames: list[PreparedFrame],
    alignment: Alignment,
    measured: list[bool],
) -> tuple[list[dict[str, Any]], dict[str, list[int]]]:
    """Reports the in-sweep neighbour overlaps, which decide retakes."""
    matched = {(pair.first, pair.second): pair for pair in alignment.pairs}
    reports: list[dict[str, Any]] = []
    weak_by_band: dict[str, list[int]] = {}
    for band_index, (band, _) in enumerate(BANDS):
        weak_by_band[band] = []
        for column in range(CAPTURE_COLUMNS):
            first = band_index * CAPTURE_COLUMNS + column
            second = band_index * CAPTURE_COLUMNS + (column + 1) % CAPTURE_COLUMNS
            pair = matched.get((min(first, second), max(first, second)))
            if pair is None:
                weak_by_band[band].append(column)
                reports.append({
                    "from": first, "to": second, "inliers": 0, "fallback": True,
                    "imu": measured[first] and measured[second],
                })
            else:
                reports.append({
                    "from": first, "to": second, "inliers": len(pair.points_first), "fallback": False,
                    "learned": pair.learned, "residual": round(pair.residual_degrees, 3),
                })
    return reports, weak_by_band


def process(args: argparse.Namespace) -> dict[str, Any]:
    if args.width < 640 or args.height < 320 or args.width != args.height * 2:
        raise ValueError("Output dimensions must use a supported 2:1 size.")

    registration_width = min(720, max(360, round(args.width / 4.5)))
    timer = StageTimer()
    input_dir = Path(args.input)
    imu_poses = load_imu_poses(input_dir)
    imu_rotations = load_imu_rotations(input_dir)

    learned = None
    if args.matcher != "sift":
        try:
            from learned_matcher import LearnedMatcher

            learned = LearnedMatcher()
        except ImportError:
            learned = None

    imu_turns: dict[int, float] = {}
    for column in range(CAPTURE_COLUMNS):
        following = (column + 1) % CAPTURE_COLUMNS
        if column in imu_rotations and following in imu_rotations:
            turn = wrap_degrees(heading_of(imu_rotations[following]) - heading_of(imu_rotations[column]))
            if 8.0 <= turn <= 70.0:
                imu_turns[column] = turn
    lens_fov, lens_measured = (args.horizontal_fov, False)
    if args.horizontal_fov <= 0.0:
        lens_fov, lens_measured = measure_horizontal_fov(input_dir, learned, imu_turns=imu_turns)
        timer.mark("lens")
    # Calibration measures the already-cropped uploaded photographs. Applying
    # zoom again would narrow the lens twice.
    effective_fov = lens_fov if lens_measured else math.degrees(
        2.0 * math.atan(math.tan(math.radians(lens_fov * 0.5)) / args.zoom)
    )
    effective_fov = max(38.0, min(112.0, effective_fov))

    frames = prepare_frames(input_dir, registration_width)
    timer.mark("prepare")
    priors = capture_priors(frames, imu_rotations)
    measured = [trusted for _, trusted in priors]
    keyframes = [
        Keyframe(frame.gray, frame.points, frame.descriptors, prior, trusted)
        for frame, (prior, trusted) in zip(frames, priors)
    ]
    initial_focal = (frames[0].image.shape[1] * 0.5) / math.tan(math.radians(effective_fov * 0.5))
    alignment = align_capture(keyframes, initial_focal, learned, MIN_PAIR_INLIERS)
    solved_fov = math.degrees(2.0 * math.atan(frames[0].image.shape[1] * 0.5 / alignment.focal))
    timer.mark("align")

    pair_reports, weak_by_band = adjacent_pair_reports(frames, alignment, measured)
    retake_sequences = choose_retakes(frames, weak_by_band)
    fallback_pairs = sum(len(pairs) for pairs in weak_by_band.values())
    # A photo with no visual match is still placed from real data when the
    # phone measured it; only overlaps with neither are guesses.
    blind_pairs = sum(
        1 for report in pair_reports if report.get("fallback") and not report.get("imu")
    )
    if blind_pairs > len(frames) // 4:
        human_directions = ", ".join(str(sequence + 1) for sequence in retake_sequences[:6])
        suffix = f" Retake directions {human_directions}." if human_directions else ""
        raise CaptureQualityError(
            "The photographs do not contain enough sharp overlap for reliable alignment." + suffix,
            retake_sequences,
        )
    cross_band: dict[str, Any] = {}
    for band_index, (band, _) in enumerate(BANDS):
        if band == "middle":
            continue
        members = range(band_index * CAPTURE_COLUMNS, (band_index + 1) * CAPTURE_COLUMNS)
        linked = sum(
            1 for pair in alignment.pairs
            if (pair.first in members) != (pair.second in members)
            and (pair.first < CAPTURE_COLUMNS or pair.second < CAPTURE_COLUMNS)
        )
        cross_band[band] = {"source": "features" if linked else ("imu" if any(measured[i] for i in members) else "plan"), "pairs": linked}

    gains = estimate_gains(frames, alignment)
    for frame, gain in zip(frames, gains):
        frame.source = apply_gains(frame.source, gain)
    timer.mark("gains")

    # Seam finding and pyramid blending scale superlinearly, so the working
    # panorama is capped; larger exports get one high-quality resize at the
    # end.
    blend_width = min(args.width, MAX_BLEND_WIDTH)
    blend_height = blend_width // 2
    seam_scale = 0.28 * min(1.0, 1920.0 / blend_width)
    images, masks, corners = build_layers(frames, alignment, blend_width, blend_height)
    timer.mark("project")
    coverage = np.zeros((blend_height, blend_width), dtype=np.uint8)
    for mask, (left, top) in zip(masks, corners):
        target = coverage[top : top + mask.shape[0], left : left + mask.shape[1]]
        np.maximum(target, mask, out=target)
    # A quick scan photographs the eye-level ring. Check its central belt for
    # holes; the unphotographed ceiling/floor are explicitly disclosed below.
    quick = len(BANDS) == 1
    central = coverage[round(blend_height * (0.40 if quick else 0.12)) : round(blend_height * (0.60 if quick else 0.88))]
    coverage_ratio = float(np.count_nonzero(central) / central.size)
    if coverage_ratio < 0.92:
        raise CaptureQualityError(
            "The room coverage has large gaps. Keep the phone at one point and overlap every target.",
            retake_sequences,
        )

    # Whole-sphere coverage, each row weighted by cos(latitude) because an
    # equirectangular row near a pole stands for far less solid angle.
    latitudes = np.pi * 0.5 - (np.arange(blend_height, dtype=np.float32) + 0.5) * (np.pi / blend_height)
    row_weights = np.cos(latitudes)
    photographed = (coverage != 0).astype(np.float32)
    sphere_coverage = float(
        (photographed.mean(axis=1) * row_weights).sum() / row_weights.sum()
    )
    seen_rows = np.flatnonzero(photographed.any(axis=1))
    if seen_rows.size:
        top_cap = 90.0 - float(np.degrees(latitudes[seen_rows[0]]))
        bottom_cap = 90.0 + float(np.degrees(latitudes[seen_rows[-1]]))
    else:
        top_cap = bottom_cap = 90.0

    compensate_exposure(images, masks, corners)
    timer.mark("exposure")
    find_seams(images, masks, corners, seam_scale)
    timer.mark("seams")
    panorama, panorama_mask = multiband_blend(images, masks, corners, blend_width, blend_height)
    timer.mark("blend")
    fill_polar_holes(panorama, panorama_mask)
    timer.mark("fill")
    if blend_width != args.width:
        panorama = cv2.resize(panorama, (args.width, args.height), interpolation=cv2.INTER_LANCZOS4)
    if not cv2.imwrite(str(args.output), panorama, [cv2.IMWRITE_JPEG_QUALITY, args.quality]):
        raise RuntimeError("OpenCV could not encode the panorama.")
    timer.mark("encode")

    matched_pairs = len(pair_reports) - fallback_pairs
    alignment_score = matched_pairs / len(pair_reports)
    advice, frame_angles = capture_advice(frames, alignment, gains)
    warnings: list[str] = []
    if quick:
        warnings.append("Quick scan: ceiling and floor are soft-filled, not photographed. Use Full scan to capture those views.")
    blurred = blurred_sequences(frames)
    if blurred:
        warnings.append(
            "Photograph"
            + ("s " if len(blurred) != 1 else " ")
            + ", ".join(str(sequence + 1) for sequence in blurred[:6])
            + " look softer than the rest of the capture."
        )
    if fallback_pairs and (learned is None or not learned.available()):
        warnings.append(
            "Plain surfaces limited the visual match. Run npm run setup:panorama "
            "to install the learned matcher, which aligns bare walls."
        )
    if fallback_pairs:
        warnings.append(
            f"{fallback_pairs} overlap{'s were' if fallback_pairs != 1 else ' was'} placed from the motion sensors because visual detail was limited."
        )
    warnings.extend(advice)
    return {
        "ok": True,
        "method": "opencv-sift-spherical-v5",
        "alignmentScore": round(alignment_score, 3),
        "matchedPairs": matched_pairs,
        "fallbackPairs": fallback_pairs,
        "coverage": round(coverage_ratio, 3),
        "coverageScope": "eye-level ring" if quick else "three bands",
        "sphereCoverage": round(sphere_coverage, 3),
        "unphotographedCapDegrees": [round(top_cap, 1), round(bottom_cap, 1)],
        "blendResolution": [blend_width, blend_height],
        "retakeSequences": retake_sequences,
        "warnings": warnings,
        "pairs": pair_reports,
        "bundle": {
            "pairs": len(alignment.pairs),
            "rmsDegrees": round(alignment.rms_degrees, 3),
            "iterations": alignment.iterations,
            "droppedPairs": alignment.dropped_pairs,
            "level": "imu" if any(measured) else "plan",
        },
        "frameAngles": frame_angles,
        "gains": [[round(float(value), 3) for value in gain] for gain in gains],
        "blurScores": [round(frame.blur_score, 1) for frame in frames],
        "imuFrames": len(imu_poses),
        "crossBand": cross_band,
        "fusedFrames": sum(1 for frame in frames if frame.fused),
        "sourceWidth": int(np.median([frame.source.shape[1] for frame in frames])),
        "matcher": "sift+superpoint-lightglue" if learned is not None and learned.available() else "sift",
        "learnedPairs": sum(1 for pair in alignment.pairs if pair.learned),
        "blindPairs": blind_pairs,
        "horizontalFov": round(solved_fov, 1),
        "initialHorizontalFov": round(effective_fov, 1),
        "lensMeasured": lens_measured,
        "blurredFrames": blurred,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--columns", type=int, default=CAPTURE_COLUMNS)
    parser.add_argument("--capture-mode", choices=["quick", "full"], default="full")
    parser.add_argument("--horizontal-fov", type=float, default=0.0,
                        help="0 measures the lens from the photographs themselves")
    parser.add_argument("--zoom", type=float, default=1.0)
    parser.add_argument(
        "--matcher",
        choices=["auto", "sift"],
        default="auto",
        help="auto uses the learned matcher to rescue low-texture overlaps when its model is installed",
    )
    args = parser.parse_args()
    if args.columns >= 3:
        globals()["CAPTURE_COLUMNS"] = args.columns
    if args.capture_mode == "quick":
        globals()["BANDS"] = (("middle", 0.0),)
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
