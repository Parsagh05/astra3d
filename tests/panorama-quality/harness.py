#!/usr/bin/env python3
"""Synthetic ground-truth harness for the Astra3D panorama stitcher.

Real capture quality cannot be regression-tested from a phone, so this harness
manufactures a capture whose correct answer is known: it renders the 24 guided
stills out of an existing equirectangular image, applies controllable
yaw/pitch/roll errors, writes the matching W3C device-orientation samples and
optional exposure brackets, runs the real stitcher, and scores the panorama it
produces against the image everything was rendered from.

Run one case directly, or use `run_suite.py` for the full matrix:

  python harness.py --source <equirect.webp> --perturb --imu --label my-case
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

CAPTURE_COLUMNS = 8
BANDS = ("middle", "upper", "lower")
FRAME_WIDTH = 900
HFOV = 72.0
DEFAULT_STITCHER = Path(__file__).resolve().parents[2] / "scripts" / "panorama-stitcher.py"
# Simulated exposures for bracket cases: the normal shot clips highlights and
# the companion shot is darker so fusion can recover them.
BRIGHT_GAIN = 1.7
DARK_GAIN = 0.4


def camera_basis(yaw_deg: float, pitch_deg: float, roll_deg: float):
    """World-frame camera basis, with world x east, y north, z up.

    Yaw is positive turning right, pitch positive toward the ceiling, and roll
    positive when the camera's top edge tilts toward its right.
    """
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    roll = math.radians(roll_deg)
    forward = np.array([
        math.sin(yaw) * math.cos(pitch),
        math.cos(yaw) * math.cos(pitch),
        math.sin(pitch),
    ])
    right0 = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    up0 = np.cross(right0, forward)
    up0 /= np.linalg.norm(up0)
    up = math.cos(roll) * up0 + math.sin(roll) * right0
    right = np.cross(forward, up)
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return forward, up, right


def orientation_angles(yaw_deg: float, pitch_deg: float, roll_deg: float):
    """Inverts a camera pose into the W3C alpha/beta/gamma a phone would report.

    Device axes are x right, y top, z out of the screen, so the rear camera
    looks along -z. This is the exact inverse of the conversion the stitcher
    performs, which is what makes the IMU cases a real end-to-end check.
    """
    forward, up, right = camera_basis(yaw_deg, pitch_deg, roll_deg)
    rotation = np.column_stack([right, up, -forward])
    beta = math.asin(max(-1.0, min(1.0, rotation[2][1])))
    alpha = math.atan2(-rotation[0][1], rotation[1][1])
    gamma = math.atan2(-rotation[2][0], rotation[2][2])
    return math.degrees(alpha) % 360.0, math.degrees(beta), math.degrees(gamma)


def render_frame(equirect, yaw_deg, pitch_deg, roll_deg, width, height):
    """Renders one rectilinear still the phone would have photographed."""
    focal = (width * 0.5) / math.tan(math.radians(HFOV * 0.5))
    forward, up, right = camera_basis(yaw_deg, pitch_deg, roll_deg)

    xs = (np.arange(width, dtype=np.float64) - (width - 1) * 0.5) / focal
    ys = ((height - 1) * 0.5 - np.arange(height, dtype=np.float64)) / focal
    dir_x = forward[0] + xs[None, :] * right[0] + ys[:, None] * up[0]
    dir_y = forward[1] + xs[None, :] * right[1] + ys[:, None] * up[1]
    dir_z = forward[2] + xs[None, :] * right[2] + ys[:, None] * up[2]
    norm = np.sqrt(dir_x**2 + dir_y**2 + dir_z**2)
    dir_x /= norm
    dir_y /= norm
    dir_z /= norm

    eq_h, eq_w = equirect.shape[:2]
    lon = np.arctan2(dir_x, dir_y)
    lat = np.arcsin(np.clip(dir_z, -1.0, 1.0))
    map_x = ((lon % (2 * math.pi)) / (2 * math.pi) * eq_w).astype(np.float32)
    map_y = ((math.pi / 2 - lat) / math.pi * eq_h).astype(np.float32)
    return cv2.remap(equirect, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def flatten_walls(source: np.ndarray, strength: float = 0.97) -> np.ndarray:
    """Simulates a bare-walled room by washing out the wall band's texture.

    The wall latitudes are blended almost entirely toward a heavy blur, which
    starves SIFT of features the way bare paint does, while faint gradients
    and soft shadows survive for a learned matcher to lock onto. The returned
    image is the scene's new ground truth.
    """
    height = source.shape[0]
    blurred = cv2.GaussianBlur(source, (0, 0), sigmaX=max(4.0, source.shape[1] / 64))
    # Full flattening between latitudes +55 and -25 (the wall band), feathered
    # over ~8 degrees so no artificial texture edge is introduced.
    latitudes = 90.0 - (np.arange(height, dtype=np.float32) + 0.5) * (180.0 / height)
    upper = np.clip((55.0 - latitudes) / 8.0, 0.0, 1.0)
    lower = np.clip((latitudes + 25.0) / 8.0, 0.0, 1.0)
    alpha = (strength * upper * lower)[:, None, None]
    return (source.astype(np.float32) * (1 - alpha) + blurred.astype(np.float32) * alpha).astype(np.uint8)


def ground_truth_poses(perturb: bool, roll: float = 0.0, seed: int = 7):
    """The poses the capture actually used, ideal or realistically sloppy.

    The perturbed variant models what phone captures really look like: each
    tilted sweep starts at a different heading than the eye-level one, the
    tilt is not exactly +/-35 degrees, and every frame carries hand shake.
    """
    rng = np.random.default_rng(seed)
    band_yaw_offset = {"middle": 0.0, "upper": 7.0 if perturb else 0.0, "lower": -5.0 if perturb else 0.0}
    band_pitch = {
        "middle": 0.0,
        "upper": 32.0 if perturb else 35.0,
        "lower": -38.0 if perturb else -35.0,
    }
    poses = {}
    for band_index, band in enumerate(BANDS):
        for column in range(CAPTURE_COLUMNS):
            sequence = band_index * CAPTURE_COLUMNS + column
            yaw = column * 45.0 + band_yaw_offset[band]
            pitch = band_pitch[band]
            frame_roll = roll if sequence % 2 == 0 else -roll
            if perturb:
                yaw += float(rng.uniform(-3.0, 3.0))
                pitch += float(rng.uniform(-2.5, 2.5))
                frame_roll += float(rng.uniform(-6.0, 6.0))
            poses[sequence] = (yaw, pitch, frame_roll)
    return poses


def score_against_source(result, source):
    """Reconstruction error against the source, overall and by latitude zone.

    The panorama's yaw origin is arbitrary, so the score searches every
    circular shift and keeps the best alignment before measuring.
    """
    height, width = 256, 512
    a = cv2.cvtColor(cv2.resize(result, (width, height), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = cv2.cvtColor(cv2.resize(source, (width, height), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    top, bottom = round(height * 0.08), round(height * 0.92)
    best_rmse, best_shift = None, 0
    for shift in range(width):
        rmse = float(np.sqrt(np.mean((np.roll(a[top:bottom], shift, axis=1) - b[top:bottom]) ** 2)))
        if best_rmse is None or rmse < best_rmse:
            best_rmse, best_shift = rmse, shift

    zones = {}
    for name, low, high in (("upper", 0.08, 0.35), ("middle", 0.35, 0.65), ("lower", 0.65, 0.92)):
        rows = slice(round(height * low), round(height * high))
        zones[name] = float(np.sqrt(np.mean((np.roll(a[rows], best_shift, axis=1) - b[rows]) ** 2)))

    # Share of the source's bright regions that saturated to flat white in the
    # result. Comparing brightness directly would be unfair to exposure fusion,
    # which tone-maps the whole image; what matters is whether window detail
    # survived at all. Lower is better.
    aligned = np.roll(a, best_shift, axis=1)
    bright = b > 200
    clipped = float(np.mean(aligned[bright] >= 250)) if np.any(bright) else None
    return best_rmse, best_shift, zones, clipped


def run_case(
    source_path: str,
    *,
    label: str = "run",
    perturb: bool = False,
    roll: float = 0.0,
    imu: bool = False,
    bracket: bool = False,
    clip_highlights: bool = False,
    bare_walls: bool = False,
    matcher: str = "auto",
    frame_width: int = FRAME_WIDTH,
    output_width: int = 1536,
    stitcher: str | Path = DEFAULT_STITCHER,
    keep_dir: str | Path | None = None,
) -> dict:
    """Renders a capture, stitches it, and returns the measured result."""
    source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if source is None:
        raise SystemExit(f"could not read source {source_path}")
    if bare_walls:
        source = flatten_walls(source)

    frame_height = round(frame_width * 4 / 3)
    poses = ground_truth_poses(perturb, roll)
    clip = bracket or clip_highlights

    with tempfile.TemporaryDirectory(prefix="astra3d-harness-") as work:
        work_dir = Path(work)
        orientations = {}
        for sequence, (yaw, pitch, frame_roll) in poses.items():
            frame = render_frame(source, yaw, pitch, frame_roll, frame_width, frame_height)
            if clip:
                frame = np.clip(frame.astype(np.float32) * BRIGHT_GAIN, 0, 255).astype(np.uint8)
            if bracket:
                # Slight pose jitter between the two shots simulates hand shake.
                shifted = render_frame(source, yaw + 0.25, pitch + 0.15, frame_roll, frame_width, frame_height)
                dark = np.clip(shifted.astype(np.float32) * DARK_GAIN, 0, 255).astype(np.uint8)
                write_jpeg(work_dir / f"{sequence:03d}.bracket", dark)
            write_jpeg(work_dir / f"{sequence:03d}.frame", frame)
            alpha, beta, gamma = orientation_angles(yaw, pitch, frame_roll)
            orientations[str(sequence)] = {"alpha": alpha, "beta": beta, "gamma": gamma}
        if imu:
            (work_dir / "imu.json").write_text(json.dumps(orientations), encoding="utf-8")

        output = work_dir / "panorama.jpg"
        report_path = work_dir / "report.json"
        started = time.perf_counter()
        completed = subprocess.run(
            [
                sys.executable, str(stitcher),
                "--input", str(work_dir),
                "--output", str(output),
                "--report", str(report_path),
                "--width", str(output_width),
                "--height", str(output_width // 2),
                "--matcher", matcher,
            ],
            capture_output=True,
            text=True,
        )
        stitch_seconds = time.perf_counter() - started
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
        if completed.returncode == 2:
            # The stitcher's quality gate refused the capture: a legitimate,
            # measurable outcome for hostile control cases.
            return {
                "label": label,
                "rejected": True,
                "rejectionMessage": report.get("message"),
                "retakeSequences": report.get("retakeSequences"),
                "stitchSeconds": round(stitch_seconds, 1),
            }
        if completed.returncode != 0:
            raise SystemExit(
                f"[{label}] stitcher failed rc={completed.returncode}\n"
                f"{completed.stderr[-1500:]}\n{json.dumps(report, indent=2)[:1000]}"
            )

        result = cv2.imread(str(output), cv2.IMREAD_COLOR)
        rmse, shift, zones, clipped = score_against_source(result, source)
        if keep_dir:
            keep = Path(keep_dir)
            keep.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(keep / f"{label}.jpg"), result)

        return {
            "label": label,
            "rejected": False,
            "rmse": round(rmse, 2),
            "zones": {name: round(value, 1) for name, value in zones.items()},
            "clippedHighlights": round(clipped, 3) if clipped is not None else None,
            "yawShift": shift,
            "stitchSeconds": round(stitch_seconds, 1),
            "outputWidth": output_width,
            "frameWidth": frame_width,
            "alignmentScore": report.get("alignmentScore"),
            "matchedPairs": report.get("matchedPairs"),
            "fallbackPairs": report.get("fallbackPairs"),
            "coverage": report.get("coverage"),
            "fusedFrames": report.get("fusedFrames"),
            "sourceWidth": report.get("sourceWidth"),
            "matcher": report.get("matcher"),
            "learnedPairs": report.get("learnedPairs"),
            "crossBand": report.get("crossBand"),
        }


def write_jpeg(path: Path, image) -> None:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise SystemExit(f"could not encode {path.name}")
    path.write_bytes(encoded.tobytes())


def format_result(result: dict) -> str:
    if result.get("rejected"):
        return (
            f"[{result['label']}] REJECTED by quality gate: "
            f"{result.get('rejectionMessage')} (stitchSec={result['stitchSeconds']})"
        )
    zones = result["zones"]
    line = (
        f"[{result['label']}] rmse={result['rmse']} "
        f"zones=up:{zones['upper']}/mid:{zones['middle']}/low:{zones['lower']} "
        f"matched={result['matchedPairs']} fallback={result['fallbackPairs']} "
        f"learned={result['learnedPairs']} coverage={result['coverage']} "
        f"fused={result['fusedFrames']} stitchSec={result['stitchSeconds']}"
    )
    if result["clippedHighlights"] is not None:
        line += f" clipped={result['clippedHighlights']}"
    return line


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--stitcher", default=str(DEFAULT_STITCHER))
    parser.add_argument("--label", default="run")
    parser.add_argument("--perturb", action="store_true")
    parser.add_argument("--roll", type=float, default=0.0)
    parser.add_argument("--imu", action="store_true")
    parser.add_argument("--bracket", action="store_true")
    parser.add_argument("--clip-highlights", action="store_true")
    parser.add_argument("--bare-walls", action="store_true")
    parser.add_argument("--matcher", choices=["auto", "sift"], default="auto")
    parser.add_argument("--frame-width", type=int, default=FRAME_WIDTH)
    parser.add_argument("--width", type=int, default=1536)
    parser.add_argument("--keep", default="")
    args = parser.parse_args()

    result = run_case(
        args.source,
        label=args.label,
        perturb=args.perturb,
        roll=args.roll,
        imu=args.imu,
        bracket=args.bracket,
        clip_highlights=args.clip_highlights,
        bare_walls=args.bare_walls,
        matcher=args.matcher,
        frame_width=args.frame_width,
        output_width=args.width,
        stitcher=args.stitcher,
        keep_dir=args.keep or None,
    )
    print(format_result(result))


if __name__ == "__main__":
    main()
