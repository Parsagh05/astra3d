#!/usr/bin/env python3
"""Scores the stitcher against ground truth.

Each scenario renders a simulated phone capture from a known panorama
(scripts/capture_simulator.py), stitches it exactly as the server does, and
compares the result with the original panorama:

  psnr / ssim   image agreement over everything the photos actually saw
  edge psnr     agreement in the outer 12° of that coverage, where cropping
                or a soft fill shows up first (curtain rails, floor drawers)
  bands         spread of brightness ratio between output and truth across
                headings; exposure seams raise it
  horizon       vertical offset of the result, in degrees

Usage:
    python scripts/panorama-benchmark.py                  # all scenarios
    python scripts/panorama-benchmark.py --profile handheld --extent quick
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture_simulator import PROFILES, coverage_mask, simulate_capture  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PANORAMAS = ["arrival", "collection", "lounge"]
COMPARE_WIDTH, COMPARE_HEIGHT = 1024, 512


def ssim(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    blur = lambda image: cv2.GaussianBlur(image, (11, 11), 1.5)  # noqa: E731
    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a ** 2
    var_b = blur(b * b) - mu_b ** 2
    cov = blur(a * b) - mu_a * mu_b
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    index = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2))
    return float(index[mask].mean())


def psnr(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    if not mask.any():
        return float("nan")
    error = np.mean((a[mask].astype(np.float32) - b[mask].astype(np.float32)) ** 2)
    return float(10 * math.log10(255 ** 2 / max(error, 1e-6)))


def best_yaw_shift(result: np.ndarray, truth: np.ndarray, mask: np.ndarray) -> int:
    """Finds the circular heading offset between result and truth."""
    rows = mask.any(axis=1)
    a = result[rows].astype(np.float32)
    b = truth[rows].astype(np.float32)
    a -= a.mean()
    b -= b.mean()
    spectrum = np.fft.fft(a, axis=1) * np.conj(np.fft.fft(b, axis=1))
    correlation = np.real(np.fft.ifft(spectrum.sum(axis=0)))
    return int(np.argmax(correlation))


def horizon_offset(result: np.ndarray, truth: np.ndarray, mask: np.ndarray) -> float:
    """Vertical shift (degrees) that best maps truth onto result."""
    best, best_error = 0, float("inf")
    for shift in range(-24, 25):
        shifted = np.roll(truth, shift, axis=0)
        valid = mask & np.roll(mask, shift, axis=0)
        if valid.sum() < 1000:
            continue
        error = float(np.mean(np.abs(result[valid].astype(np.float32) - shifted[valid].astype(np.float32))))
        if error < best_error:
            best, best_error = shift, error
    return best * 180.0 / COMPARE_HEIGHT


def run_scenario(
    panorama_name: str, extent: str, profile_name: str, seed: int, width: int, work: Path, no_imu: bool = False,
) -> dict:
    truth_full = cv2.imread(str(ROOT / f"public/images/tours/flagship/{panorama_name}-2048.webp"), cv2.IMREAD_COLOR)
    profile = PROFILES[profile_name]
    rng = np.random.default_rng(seed)
    frames = simulate_capture(truth_full, extent, profile, rng, width)
    job = work / f"{panorama_name}-{extent}-{profile_name}{'-noimu' if no_imu else ''}"
    job.mkdir(parents=True)
    imu = {}
    for frame in frames:
        encoded = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 88])[1]
        (job / f"{frame.sequence:03d}.frame").write_bytes(encoded.tobytes())
        imu[str(frame.sequence)] = frame.imu
    if not no_imu:
        (job / "imu.json").write_text(json.dumps(imu))
    output = job / "panorama.jpg"
    report_path = job / "report.json"
    started = time.perf_counter()
    completed = subprocess.run(
        [sys.executable, str(ROOT / "scripts/panorama-stitcher.py"),
         "--input", str(job), "--output", str(output), "--report", str(report_path),
         "--width", "3072", "--height", "1536", "--quality", "90",
         "--columns", "12", "--capture-mode", extent, "--zoom", "1"],
        capture_output=True, text=True,
    )
    elapsed = time.perf_counter() - started
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    row = {"case": f"{panorama_name}/{extent}/{profile_name}{'/no-imu' if no_imu else ''}", "seconds": round(elapsed, 1)}
    if completed.returncode != 0 or not output.exists():
        row["error"] = report.get("message") or completed.stderr.strip().splitlines()[-1:]
        return row

    result = cv2.resize(cv2.imread(str(output)), (COMPARE_WIDTH, COMPARE_HEIGHT), interpolation=cv2.INTER_AREA)
    truth = cv2.resize(truth_full, (COMPARE_WIDTH, COMPARE_HEIGHT), interpolation=cv2.INTER_AREA)
    seen = coverage_mask(frames, profile.horizontal_fov, COMPARE_WIDTH, COMPARE_HEIGHT)
    # Ignore the last 1.5° inside the photographed edge, where any blend fades.
    margin = max(1, round(COMPARE_HEIGHT * 1.5 / 180))
    inner = cv2.erode(seen.astype(np.uint8), np.ones((2 * margin + 1, 2 * margin + 1), np.uint8)).astype(bool)
    result_gray = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    truth_gray = cv2.cvtColor(truth, cv2.COLOR_BGR2GRAY)
    shift = best_yaw_shift(result_gray, truth_gray, inner)
    truth_gray = np.roll(truth_gray, shift, axis=1)
    inner = np.roll(inner, shift, axis=1)

    # The outer 12° of coverage above and below, per heading.
    edge = np.zeros_like(inner)
    band_rows = round(COMPARE_HEIGHT * 12 / 180)
    for column in range(COMPARE_WIDTH):
        rows = np.flatnonzero(inner[:, column])
        if rows.size:
            edge[rows[0] : rows[0] + band_rows, column] = True
            edge[max(rows[-1] - band_rows, 0) : rows[-1] + 1, column] = True
    edge &= inner

    ratio_columns = []
    for start in range(0, COMPARE_WIDTH, COMPARE_WIDTH // 48):
        block = inner[:, start : start + COMPARE_WIDTH // 48]
        if block.sum() > 200:
            r = result_gray[:, start : start + COMPARE_WIDTH // 48][block].mean()
            t = truth_gray[:, start : start + COMPARE_WIDTH // 48][block].mean()
            ratio_columns.append(r / max(t, 1))
    row.update({
        "psnr": round(psnr(result_gray, truth_gray, inner), 2),
        "ssim": round(ssim(result_gray, truth_gray, inner), 3),
        "edgePsnr": round(psnr(result_gray, truth_gray, edge), 2),
        "bands": round(float(np.std(ratio_columns)), 3),
        "horizon": round(horizon_offset(result_gray, truth_gray, inner), 1),
        "aligned": f"{report.get('matchedPairs')}/{report.get('matchedPairs', 0) + report.get('fallbackPairs', 0)}",
        "fov": report.get("horizontalFov"),
    })
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", choices=sorted(PROFILES), action="append")
    parser.add_argument("--extent", choices=["quick", "full"], action="append")
    parser.add_argument("--panorama", choices=PANORAMAS, action="append")
    parser.add_argument("--width", type=int, default=720, help="simulated still width")
    parser.add_argument("--seed", type=int, default=3)
    parser.add_argument("--no-imu", action="store_true", help="drop the motion data, as a manual capture would")
    parser.add_argument("--json", type=Path, help="also write the rows as JSON")
    parser.add_argument("--keep", action="store_true", help="keep the rendered jobs")
    args = parser.parse_args()

    work = Path(tempfile.mkdtemp(prefix="astra3d-bench-"))
    rows = []
    try:
        for profile in args.profile or ["steady", "handheld"]:
            for extent in args.extent or ["quick", "full"]:
                for panorama in args.panorama or PANORAMAS:
                    # Seeded by scene, so filtering the list never changes a scenario.
                    seed = args.seed + PANORAMAS.index(panorama)
                    row = run_scenario(panorama, extent, profile, seed, args.width, work, args.no_imu)
                    rows.append(row)
                    print(json.dumps(row), flush=True)
    finally:
        if args.keep:
            print(f"kept {work}", file=sys.stderr)
        else:
            shutil.rmtree(work, ignore_errors=True)

    scored = [row for row in rows if "psnr" in row]
    if scored:
        summary = {
            key: round(float(np.mean([row[key] for row in scored])), 3)
            for key in ("psnr", "ssim", "edgePsnr", "bands", "seconds")
        }
        summary["horizonAbs"] = round(float(np.mean([abs(row["horizon"]) for row in scored])), 2)
        summary["failed"] = len(rows) - len(scored)
        print("SUMMARY " + json.dumps(summary))
    if args.json:
        args.json.write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
