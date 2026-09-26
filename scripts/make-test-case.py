#!/usr/bin/env python3
"""Renders a studio-style capture set from any 2:1 panorama.

Each photo is what a phone following the studio's guidance would have taken:
a portrait 3:4 still at every target of the 12-photo (quick) or 36-photo
(full) plan, turning right, and the W3C device-orientation angles the phone
would have reported (see capture_simulator.py for the hand profiles).  The
result is a ground-truth test case for the Tests page:

    test-cases/12-images/<name>/01.jpg ... 12.jpg + metadata.json

Example:
    python scripts/make-test-case.py \\
        --panorama public/images/tours/flagship/arrival-2048.webp \\
        --extent quick --name synthetic-arrival
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture_simulator import CAPTURE_COLUMNS, PROFILES, simulate_capture  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--panorama", required=True, type=Path)
    parser.add_argument("--extent", choices=["quick", "full"], default="quick")
    parser.add_argument("--name", required=True)
    parser.add_argument("--out", type=Path, default=Path("test-cases"))
    parser.add_argument("--width", type=int, default=480, help="still width in pixels (height is 4/3 of it)")
    parser.add_argument(
        "--profile", choices=sorted(PROFILES), default="steady",
        help="steady: a careful capture; handheld: uneven turns, 3-10° down, 11-22° sideways tilt, "
             "a 49° lens and changing exposure",
    )
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    panorama = cv2.imread(str(args.panorama), cv2.IMREAD_COLOR)
    if panorama is None:
        raise SystemExit(f"Cannot read {args.panorama}")
    frames = simulate_capture(panorama, args.extent, PROFILES[args.profile], np.random.default_rng(args.seed), args.width)
    group = f"{CAPTURE_COLUMNS * (1 if args.extent == 'quick' else 3)}-images"
    target = args.out / group / args.name
    target.mkdir(parents=True, exist_ok=False)

    records = []
    for frame in frames:
        file = f"{frame.sequence + 1:02d}.jpg"
        cv2.imwrite(str(target / file), frame.image, [cv2.IMWRITE_JPEG_QUALITY, 88])
        records.append({
            "sequence": frame.sequence,
            "band": frame.band,
            "column": frame.column,
            "file": file,
            "zoom": 1,
            # What the phone's sensors reported, derived from the true pose.
            "imu": frame.imu,
            "truth": {"yaw": round(frame.yaw, 2), "pitch": round(frame.pitch, 2), "roll": round(frame.roll, 2)},
        })

    metadata = {
        "version": 1,
        "name": args.name,
        "extent": args.extent,
        "imageCount": len(records),
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": f"synthetic:{args.panorama.name}:{args.profile}",
        "frames": records,
    }
    (target / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf8")
    print(f"Wrote {len(records)} stills to {target}")


if __name__ == "__main__":
    main()
