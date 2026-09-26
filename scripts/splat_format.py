"""Gaussian splat files and coordinate frames for the 3D scan pipeline.

* reads the 3D Gaussian Splatting .ply that nerfstudio's `ns-export
  gaussian-splat` writes (x y z, f_dc_*, f_rest_*, opacity, scale_*, rot_*);
* undoes nerfstudio's dataparser transform so trained Gaussians land back in
  the COLMAP frame the camera poses live in;
* moves everything into the viewer frame: y up (from how the phone was
  held), the capture path centred on the origin, the first view along -z,
  and a room-sized scale;
* writes the compact 32-byte-per-splat `.splat` format (antimatter15) that
  the browser streams.

Quaternions are (w, x, y, z) throughout, as in 3DGS files.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814
PLY_TYPES = {
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
    "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
    "ushort": "u2", "uint16": "u2", "short": "i2", "int16": "i2",
    "uint": "u4", "uint32": "u4", "int": "i4", "int32": "i4",
}


@dataclass
class Gaussians:
    positions: np.ndarray  # (N, 3) float32
    scales: np.ndarray  # (N, 3) linear standard deviations
    rotations: np.ndarray  # (N, 4) unit quaternions, w first
    colors: np.ndarray  # (N, 3) linear 0..1 base colour
    opacities: np.ndarray  # (N,) 0..1

    def __len__(self) -> int:
        return len(self.positions)


def read_ply(path: Path) -> dict[str, np.ndarray]:
    """Reads the vertex element of a binary little-endian PLY."""
    with open(path, "rb") as handle:
        if handle.readline().strip() != b"ply":
            raise ValueError("Not a PLY file.")
        count = 0
        fields: list[tuple[str, str]] = []
        fmt = b""
        in_vertex = False
        while True:
            line = handle.readline()
            if not line:
                raise ValueError("Truncated PLY header.")
            words = line.strip().split()
            if not words:
                continue
            if words[0] == b"format":
                fmt = words[1]
            elif words[0] == b"element":
                in_vertex = words[1] == b"vertex"
                if in_vertex:
                    count = int(words[2])
            elif words[0] == b"property" and in_vertex:
                if words[1] == b"list":
                    raise ValueError("List properties are not supported in splat PLY files.")
                fields.append((words[2].decode(), "<" + PLY_TYPES[words[1].decode()]))
            elif words[0] == b"end_header":
                break
        if fmt != b"binary_little_endian":
            raise ValueError("Only binary little-endian PLY files are supported.")
        data = np.fromfile(handle, dtype=np.dtype(fields), count=count)
    return {name: data[name] for name, _ in fields}


def gaussians_from_3dgs(fields: dict[str, np.ndarray]) -> Gaussians:
    """Decodes the standard 3DGS parameterisation into plain values."""
    positions = np.stack([fields["x"], fields["y"], fields["z"]], axis=1).astype(np.float32)
    scales = np.exp(np.stack([fields[f"scale_{i}"] for i in range(3)], axis=1)).astype(np.float32)
    rotations = np.stack([fields[f"rot_{i}"] for i in range(4)], axis=1).astype(np.float32)
    rotations /= np.maximum(np.linalg.norm(rotations, axis=1, keepdims=True), 1e-12)
    if "f_dc_0" in fields:
        colors = 0.5 + SH_C0 * np.stack([fields[f"f_dc_{i}"] for i in range(3)], axis=1)
    else:
        colors = np.stack([fields["red"], fields["green"], fields["blue"]], axis=1) / 255.0
    opacities = 1.0 / (1.0 + np.exp(-fields["opacity"].astype(np.float32)))
    return Gaussians(positions, scales, rotations, np.clip(colors, 0, 1).astype(np.float32), opacities.astype(np.float32))


def quaternion_from_matrix(matrix: np.ndarray) -> np.ndarray:
    m = matrix
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q = np.array(q, dtype=np.float64)
    return q / np.linalg.norm(q)


def quaternion_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """a * b for a single quaternion `a` and a batch `b`, (w, x, y, z)."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ], axis=1)


def transform(gaussians: Gaussians, rotation: np.ndarray, translation: np.ndarray, scale: float) -> Gaussians:
    """Applies p' = scale * (rotation @ p) + translation to every Gaussian."""
    q = quaternion_from_matrix(rotation)
    rotations = quaternion_multiply(q, gaussians.rotations.astype(np.float64))
    return Gaussians(
        positions=(scale * gaussians.positions.astype(np.float64) @ rotation.T + translation).astype(np.float32),
        scales=(gaussians.scales * scale).astype(np.float32),
        rotations=(rotations / np.linalg.norm(rotations, axis=1, keepdims=True)).astype(np.float32),
        colors=gaussians.colors,
        opacities=gaussians.opacities,
    )


def nerfstudio_to_colmap(gaussians: Gaussians, dataparser: dict) -> Gaussians:
    """Undoes `p_ns = scale * (T @ [p_colmap; 1])`.

    nerfstudio's colmap dataparser saves T (which already includes its
    COLMAP-to-nerfstudio axis swap) and the scale in
    dataparser_transforms.json; the swap and the orientation are rotations,
    so the inverse is exact.
    """
    matrix = np.asarray(dataparser["transform"], dtype=np.float64)
    rotation, offset = matrix[:, :3], matrix[:, 3]
    scale = float(dataparser["scale"])
    # p_c = R^T (p_ns / scale - t)  ==  (1/scale) * R^T p_ns - R^T t
    return transform(gaussians, rotation.T, -rotation.T @ offset, 1.0 / scale)


def encode_splat(gaussians: Gaussians) -> bytes:
    """32 bytes per splat: xyz f32, scale f32 x3, rgba u8, quaternion u8 (w x y z).

    Sorted large-and-opaque first, so a streaming viewer shows the room's
    structure before the fine detail arrives.
    """
    count = len(gaussians)
    order = np.argsort(-(np.prod(gaussians.scales, axis=1) * gaussians.opacities))
    buffer = np.zeros(count, dtype=[("position", "<f4", 3), ("scale", "<f4", 3), ("color", "u1", 4), ("rotation", "u1", 4)])
    buffer["position"] = gaussians.positions[order]
    buffer["scale"] = gaussians.scales[order]
    rgba = np.concatenate([gaussians.colors[order], gaussians.opacities[order, None]], axis=1)
    buffer["color"] = np.clip(np.round(rgba * 255.0), 0, 255).astype(np.uint8)
    quats = gaussians.rotations[order]
    quats = quats * np.where(quats[:, :1] < 0, -1.0, 1.0)
    buffer["rotation"] = np.clip(np.round(quats * 128.0 + 128.0), 0, 255).astype(np.uint8)
    return buffer.tobytes()


def decode_splat(data: bytes) -> Gaussians:
    buffer = np.frombuffer(data, dtype=[("position", "<f4", 3), ("scale", "<f4", 3), ("color", "u1", 4), ("rotation", "u1", 4)])
    rotations = (buffer["rotation"].astype(np.float32) - 128.0) / 128.0
    rotations /= np.maximum(np.linalg.norm(rotations, axis=1, keepdims=True), 1e-12)
    return Gaussians(
        buffer["position"].copy(), buffer["scale"].copy(), rotations,
        buffer["color"][:, :3] / 255.0, buffer["color"][:, 3] / 255.0,
    )


@dataclass
class ViewerFrame:
    """COLMAP world -> viewer: p' = scale * rotation @ (p - center)."""

    rotation: np.ndarray
    center: np.ndarray
    scale: float

    def apply_points(self, points: np.ndarray) -> np.ndarray:
        return self.scale * (points - self.center) @ self.rotation.T

    def apply_directions(self, directions: np.ndarray) -> np.ndarray:
        return directions @ self.rotation.T

    def apply_gaussians(self, gaussians: Gaussians) -> Gaussians:
        return transform(gaussians, self.rotation, -self.scale * self.rotation @ self.center, self.scale)


def viewer_frame(
    camera_centers: np.ndarray,
    camera_ups: np.ndarray,
    first_forward: np.ndarray,
    scene_points: np.ndarray,
    room_radius: float = 3.0,
) -> ViewerFrame:
    """Levels and centres a reconstruction for the viewer.

    People film upright, so the average of the cameras' "up" directions is
    the room's vertical.  The capture path's centre becomes the origin, the
    first view looks along -z, and the scene is scaled so the median distance
    from the path to the room's surfaces is `room_radius` (about a room).
    """
    up = camera_ups.mean(axis=0)
    up /= np.linalg.norm(up)
    forward = first_forward - (first_forward @ up) * up
    if np.linalg.norm(forward) < 1e-6:
        forward = np.cross(up, [1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.cross(up, [0.0, 0.0, 1.0])
    forward /= np.linalg.norm(forward)
    back = -forward
    right = np.cross(up, back)
    rotation = np.stack([right, up, back])  # rows: new x, y, z in old coordinates
    center = np.median(camera_centers, axis=0)
    distances = np.linalg.norm(scene_points - center, axis=1) if len(scene_points) else np.array([1.0])
    typical = float(np.median(distances)) or 1.0
    return ViewerFrame(rotation, center, room_radius / typical)
