#!/usr/bin/env python3
"""Renders a studio-style capture set from any 2:1 panorama.

Each photo is what a phone following the studio's guidance would have taken:
a portrait 3:4 still at every target of the 12-photo (quick) or 36-photo
(full) plan, turning right, with a little hand wobble, and the W3C
device-orientation angles the phone would have reported.  The result is a
ground-truth test case for the Tests page:

    test-cases/12-images/<name>/01.jpg ... 12.jpg + metadata.json

Example:
    python scripts/make-test-case.py \\
        --panorama public/images/tours/flagship/arrival-2048.webp \\
        --extent quick --name synthetic-arrival
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

CAPTURE_COLUMNS = 12
BAND_TILT_DEGREES = 50
BANDS = [("middle", 0.0), ("upper", BAND_TILT_DEGREES), ("lower", -BAND_TILT_DEGREES)]
# Portrait 3:4 still of a typical 26 mm-equivalent phone camera.
HORIZONTAL_FOV = 55.4


def rotation(yaw: float, pitch: float, roll: float) -> np.ndarray:
    """Camera-to-world rotation: y up, -z ahead, positive yaw turns right."""
    y, p, r = (math.radians(v) for v in (yaw, pitch, roll))
    ry = np.array([[math.cos(-y), 0, math.sin(-y)], [0, 1, 0], [-math.sin(-y), 0, math.cos(-y)]])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return ry @ rx @ rz


def render_view(panorama: np.ndarray, yaw: float, pitch: float, roll: float, width: int) -> np.ndarray:
    height = round(width * 4 / 3)
    focal = (width / 2) / math.tan(math.radians(HORIZONTAL_FOV / 2))
    xs, ys = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    rays = np.stack([(xs - width / 2) / focal, -(ys - height / 2) / focal, -np.ones_like(xs)], axis=-1)
    world = rays @ rotation(yaw, pitch, roll).T
    world /= np.linalg.norm(world, axis=-1, keepdims=True)
    ray_yaw = np.arctan2(world[..., 0], -world[..., 2])
    ray_pitch = np.arcsin(np.clip(world[..., 1], -1, 1))
    pano_h, pano_w = panorama.shape[:2]
    map_x = ((ray_yaw / (2 * math.pi) + 0.5) * pano_w - 0.5).astype(np.float32)
    map_y = ((0.5 - ray_pitch / math.pi) * pano_h - 0.5).astype(np.float32)
    return cv2.remap(panorama, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--panorama", required=True, type=Path)
    parser.add_argument("--extent", choices=["quick", "full"], default="quick")
    parser.add_argument("--name", required=True)
    parser.add_argument("--out", type=Path, default=Path("test-cases"))
    parser.add_argument("--width", type=int, default=480, help="still width in pixels (height is 4/3 of it)")
    parser.add_argument("--wobble", type=float, default=2.5, help="max hand wobble in degrees")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    panorama = cv2.imread(str(args.panorama), cv2.IMREAD_COLOR)
    if panorama is None:
        raise SystemExit(f"Cannot read {args.panorama}")
    rng = np.random.default_rng(args.seed)
    bands = BANDS[:1] if args.extent == "quick" else BANDS
    group = f"{CAPTURE_COLUMNS * len(bands)}-images"
    target = args.out / group / args.name
    target.mkdir(parents=True, exist_ok=False)

    frames = []
    for band_index, (band, pitch) in enumerate(bands):
        for column in range(CAPTURE_COLUMNS):
            sequence = band_index * CAPTURE_COLUMNS + column
            yaw = column * 360 / CAPTURE_COLUMNS + rng.uniform(-args.wobble, args.wobble)
            real_pitch = pitch + rng.uniform(-args.wobble, args.wobble)
            roll = rng.uniform(-args.wobble, args.wobble) * 0.6
            still = render_view(panorama, yaw, real_pitch, roll, args.width)
            # Small auto-exposure drift between stills, like a real phone.
            still = cv2.convertScaleAbs(still, alpha=float(rng.uniform(0.94, 1.06)), beta=float(rng.uniform(-4, 4)))
            file = f"{sequence + 1:02d}.jpg"
            cv2.imwrite(str(target / file), still, [cv2.IMWRITE_JPEG_QUALITY, 88])
            frames.append({
                "sequence": sequence,
                "band": band,
                "column": column,
                "file": file,
                "zoom": 1,
                # What the phone reports for that pose (roll ignored: gamma 0).
                "imu": {
                    "alpha": round((-yaw) % 360, 3),
                    "beta": round(90 + real_pitch, 3),
                    "gamma": 0,
                },
            })

    metadata = {
        "version": 1,
        "name": args.name,
        "extent": args.extent,
        "imageCount": len(frames),
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": f"synthetic:{args.panorama.name}",
        "frames": frames,
    }
    (target / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf8")
    print(f"Wrote {len(frames)} stills to {target}")


if __name__ == "__main__":
    main()
