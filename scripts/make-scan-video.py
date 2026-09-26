#!/usr/bin/env python3
"""Renders a walk-through video of a simple textured 3D room.

A test input for the 3D scan pipeline: unlike a panorama capture, the camera
moves, so photogrammetry can triangulate the room.  Walls, floor and ceiling
of a 6 x 3 x 6 m box are textured from a 2:1 panorama, and the camera walks a
circle while looking outward, the way a person films a room.

    python scripts/make-scan-video.py --panorama public/images/tours/flagship/lounge-2048.webp \\
        --output /tmp/room-walk.mp4
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import cv2
import numpy as np

HALF_WIDTH, HEIGHT = 3.0, 3.0
EYE = 1.5
_rng = np.random.default_rng(7)
GRAIN_WAVES = [
    (vector / np.linalg.norm(vector), frequency, phase)
    for vector, frequency, phase in zip(_rng.normal(size=(9, 3)), _rng.uniform(40.0, 200.0, 9), _rng.uniform(0, 6.3, 9))
]


def render(panorama: np.ndarray, position: np.ndarray, rotation: np.ndarray, width: int, height: int, fov: float) -> np.ndarray:
    focal = (width / 2) / math.tan(math.radians(fov / 2))
    xs, ys = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    rays = np.stack([(xs - width / 2) / focal, -(ys - height / 2) / focal, -np.ones_like(xs)], axis=-1) @ rotation.T
    # Distance to the box walls along every ray.
    with np.errstate(divide="ignore", invalid="ignore"):
        tx = np.where(rays[..., 0] > 0, (HALF_WIDTH - position[0]) / rays[..., 0], (-HALF_WIDTH - position[0]) / rays[..., 0])
        ty = np.where(rays[..., 1] > 0, (HEIGHT - position[1]) / rays[..., 1], (0.0 - position[1]) / rays[..., 1])
        tz = np.where(rays[..., 2] > 0, (HALF_WIDTH - position[2]) / rays[..., 2], (-HALF_WIDTH - position[2]) / rays[..., 2])
    t = np.minimum(np.minimum(np.where(tx > 0, tx, np.inf), np.where(ty > 0, ty, np.inf)), np.where(tz > 0, tz, np.inf))
    hit = position + rays * t[..., None]
    # Paint each surface point with the panorama seen from the room centre.
    direction = hit - np.array([0.0, EYE, 0.0])
    direction /= np.linalg.norm(direction, axis=-1, keepdims=True)
    yaw = np.arctan2(direction[..., 0], -direction[..., 2])
    pitch = np.arcsin(np.clip(direction[..., 1], -1, 1))
    pano_h, pano_w = panorama.shape[:2]
    map_x = ((yaw / (2 * math.pi) + 0.5) * pano_w - 0.5).astype(np.float32)
    map_y = ((0.5 - pitch / math.pi) * pano_h - 0.5).astype(np.float32)
    image = cv2.remap(panorama, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP).astype(np.float32)
    # Real surfaces carry fine detail (grain, weave, scuffs) that a stretched
    # panorama lacks; add a world-anchored mottled pattern (a sum of plane
    # waves in fixed random directions, 3-15 cm) so features stay put on the
    # surface as the camera moves, as they do in a real room.
    grain = np.zeros(hit.shape[:2], dtype=np.float64)
    for direction, frequency, phase in GRAIN_WAVES:
        grain += np.sin(hit @ direction * frequency + phase)
    image *= (1.0 + 0.09 * grain)[..., None]
    return np.clip(image, 0, 255).astype(np.uint8)


def look_rotation(forward: np.ndarray) -> np.ndarray:
    forward = forward / np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return np.stack([right, up, -forward], axis=1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--panorama", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--width", type=int, default=720)
    parser.add_argument("--height", type=int, default=960)
    parser.add_argument("--radius", type=float, default=0.9)
    args = parser.parse_args()

    panorama = cv2.imread(str(args.panorama), cv2.IMREAD_COLOR)
    if panorama is None:
        raise SystemExit(f"Cannot read {args.panorama}")
    writer = cv2.VideoWriter(str(args.output), cv2.VideoWriter_fourcc(*"mp4v"), args.fps, (args.width, args.height))
    frames = round(args.seconds * args.fps)
    for index in range(frames):
        angle = 2 * math.pi * index / frames
        position = np.array([args.radius * math.sin(angle), EYE + 0.15 * math.sin(3 * angle), -args.radius * math.cos(angle)])
        # Look outward and a little up and down, like a person filming walls.
        tilt = 0.25 * math.sin(2 * angle)
        forward = np.array([math.sin(angle + 0.35), tilt, -math.cos(angle + 0.35)])
        writer.write(render(panorama, position, look_rotation(forward), args.width, args.height, 62.0))
    writer.release()
    print(f"Wrote {frames} frames to {args.output}")


if __name__ == "__main__":
    main()
