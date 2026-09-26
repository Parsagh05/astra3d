#!/usr/bin/env python3
"""Checks for the 3D scan file formats and coordinate frames.

    python scripts/test_splat_format.py
"""

from __future__ import annotations

import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from splat_format import (  # noqa: E402
    Gaussians,
    SH_C0,
    decode_splat,
    encode_splat,
    gaussians_from_3dgs,
    nerfstudio_to_colmap,
    quaternion_from_matrix,
    read_ply,
    transform,
    viewer_frame,
)


def rotation_about(axis: np.ndarray, angle: float) -> np.ndarray:
    axis = axis / np.linalg.norm(axis)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * k @ k


def matrix_from_quaternion(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def random_gaussians(count: int, rng: np.random.Generator) -> Gaussians:
    rotations = rng.normal(size=(count, 4)).astype(np.float32)
    rotations /= np.linalg.norm(rotations, axis=1, keepdims=True)
    return Gaussians(
        positions=rng.normal(size=(count, 3)).astype(np.float32),
        scales=rng.uniform(0.01, 0.2, size=(count, 3)).astype(np.float32),
        rotations=rotations,
        colors=rng.uniform(0, 1, size=(count, 3)).astype(np.float32),
        opacities=rng.uniform(0.1, 1, size=count).astype(np.float32),
    )


def covariance(g: Gaussians, index: int) -> np.ndarray:
    r = matrix_from_quaternion(g.rotations[index].astype(np.float64))
    return r @ np.diag(g.scales[index].astype(np.float64) ** 2) @ r.T


class SplatFormatTest(unittest.TestCase):
    def test_quaternion_from_matrix_round_trips(self) -> None:
        rng = np.random.default_rng(1)
        for _ in range(50):
            r = rotation_about(rng.normal(size=3), rng.uniform(-math.pi, math.pi))
            np.testing.assert_allclose(matrix_from_quaternion(quaternion_from_matrix(r)), r, atol=1e-9)

    def test_transform_moves_whole_ellipsoids(self) -> None:
        """Rotating a Gaussian must rotate its covariance: Σ' = s² R Σ Rᵀ."""
        rng = np.random.default_rng(2)
        g = random_gaussians(20, rng)
        r = rotation_about(np.array([0.3, 1.0, -0.2]), 1.1)
        moved = transform(g, r, np.array([1.0, -2.0, 0.5]), 2.5)
        np.testing.assert_allclose(moved.positions, 2.5 * g.positions @ r.T + [1.0, -2.0, 0.5], atol=1e-5)
        for index in range(len(g)):
            np.testing.assert_allclose(covariance(moved, index), 6.25 * r @ covariance(g, index) @ r.T, atol=1e-5)

    def test_nerfstudio_to_colmap_inverts_the_dataparser(self) -> None:
        rng = np.random.default_rng(3)
        colmap = random_gaussians(10, rng)
        r = rotation_about(np.array([1.0, 0.2, 0.4]), 0.7)
        t = np.array([0.4, -0.1, 0.9])
        scale = 0.37
        # nerfstudio: p_ns = scale * (R p + t)
        ns = transform(colmap, r, scale * t, scale)
        back = nerfstudio_to_colmap(ns, {"transform": np.hstack([r, t[:, None]]).tolist(), "scale": scale})
        np.testing.assert_allclose(back.positions, colmap.positions, atol=1e-5)
        np.testing.assert_allclose(back.scales, colmap.scales, rtol=1e-5)
        for index in range(len(colmap)):
            np.testing.assert_allclose(covariance(back, index), covariance(colmap, index), atol=1e-6)

    def test_splat_encoding_round_trips(self) -> None:
        rng = np.random.default_rng(4)
        g = random_gaussians(64, rng)
        data = encode_splat(g)
        self.assertEqual(len(data), 64 * 32)
        decoded = decode_splat(data)
        # Largest-and-most-opaque first, for progressive loading.
        order = np.argsort(-(np.prod(g.scales, axis=1) * g.opacities))
        self.assertTrue(np.all(np.diff((np.prod(g.scales, axis=1) * g.opacities)[order]) <= 0))
        np.testing.assert_allclose(decoded.positions, g.positions[order], atol=1e-6)
        np.testing.assert_allclose(decoded.colors, g.colors[order], atol=1 / 255)
        # Quantised quaternions: same orientation up to sign, within ~1°.
        dots = np.abs(np.sum(decoded.rotations * g.rotations[order], axis=1))
        self.assertTrue(np.all(dots > 0.998))

    def test_reads_a_3dgs_ply(self) -> None:
        names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
        row = [1.0, 2.0, 3.0, 0.0, 1.0, -1.0, 0.0, math.log(0.1), math.log(0.2), math.log(0.3), 2.0, 0.0, 0.0, 0.0]
        header = "ply\nformat binary_little_endian 1.0\nelement vertex 1\n" + "".join(f"property float {n}\n" for n in names) + "end_header\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "splat.ply"
            path.write_bytes(header.encode() + struct.pack("<" + "f" * len(row), *row))
            g = gaussians_from_3dgs(read_ply(path))
        np.testing.assert_allclose(g.positions[0], [1, 2, 3])
        np.testing.assert_allclose(g.scales[0], [0.1, 0.2, 0.3], rtol=1e-6)
        np.testing.assert_allclose(g.rotations[0], [1, 0, 0, 0])
        np.testing.assert_allclose(g.colors[0], [0.5, 0.5 + SH_C0, 0.5 - SH_C0], atol=1e-6)
        self.assertAlmostEqual(float(g.opacities[0]), 0.5)

    def test_viewer_frame_levels_and_centres_the_capture(self) -> None:
        """A tilted, offset reconstruction comes out y-up, centred, first view along -z."""
        tilt = rotation_about(np.array([0.4, 0.1, 1.0]), 0.8)
        offset = np.array([5.0, -3.0, 2.0])
        world_up = tilt @ np.array([0.0, 1.0, 0.0])
        angles = np.linspace(0, 2 * math.pi, 24, endpoint=False)
        centers = np.stack([tilt @ np.array([0.5 * math.sin(a), 0.0, 0.5 * math.cos(a)]) + offset for a in angles])
        first_forward = tilt @ np.array([1.0, 0.0, 0.0])
        points = np.stack([tilt @ (4.0 * np.array([math.cos(a), 0.0, math.sin(a)])) + offset for a in angles])
        frame = viewer_frame(centers, np.repeat(world_up[None], len(centers), axis=0), first_forward, points)
        np.testing.assert_allclose(frame.apply_directions(world_up[None])[0], [0, 1, 0], atol=1e-9)
        np.testing.assert_allclose(frame.apply_directions(first_forward[None])[0], [0, 0, -1], atol=1e-9)
        placed = frame.apply_points(points)
        np.testing.assert_allclose(np.median(np.linalg.norm(placed, axis=1)), 3.0, rtol=1e-6)
        np.testing.assert_allclose(placed[:, 1], 0.0, atol=1e-9)


if __name__ == "__main__":
    unittest.main()
