"""Simulated phone captures rendered from a known 2:1 panorama.

Used by make-test-case.py (fixtures for the Tests page) and by
panorama-benchmark.py (ground-truth quality scores for the stitcher).

Scene frame: y up, heading zero along -z, positive yaw turning right, the
same convention as the web app and the stitcher.  A still is rendered with a
pinhole camera, so it has the same geometry a phone photo has.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

CAPTURE_COLUMNS = 12
BAND_TILT_DEGREES = 50.0
BANDS = (("middle", 0.0), ("upper", BAND_TILT_DEGREES), ("lower", -BAND_TILT_DEGREES))


@dataclass
class Profile:
    """How carefully the simulated person holds the phone."""

    horizontal_fov: float = 55.4
    yaw_step_range: tuple[float, float] = (27.5, 32.5)
    pitch_offset_range: tuple[float, float] = (-2.5, 2.5)
    roll_base: float = 0.0
    roll_jitter: float = 1.5
    roll_outliers: dict[int, float] = field(default_factory=dict)
    gain_range: tuple[float, float] = (0.94, 1.06)
    white_balance_jitter: float = 0.0
    imu_noise: float = 0.5
    imu_yaw_drift: float = 0.0


PROFILES = {
    # A careful user following the guide.
    "steady": Profile(),
    # What a real handheld capture reported: a 49° wide still, turns from
    # 19.5° to 39°, the phone pointing 3-10° down, an 11° sideways tilt with
    # one shot at 22°, and auto-exposure moving brightness from 98 to 166.
    "handheld": Profile(
        horizontal_fov=49.0,
        yaw_step_range=(19.5, 39.0),
        pitch_offset_range=(-10.0, -3.0),
        roll_base=11.0,
        roll_jitter=2.0,
        roll_outliers={4: 22.0},
        gain_range=(0.72, 1.22),
        white_balance_jitter=0.04,
        imu_noise=0.8,
        imu_yaw_drift=0.25,
    ),
}


def camera_rotation(yaw: float, pitch: float, roll: float) -> np.ndarray:
    """Camera-to-scene rotation for a heading, a tilt and a sideways roll."""
    y, p, r = (math.radians(v) for v in (yaw, pitch, roll))
    ry = np.array([[math.cos(y), 0, -math.sin(y)], [0, 1, 0], [math.sin(y), 0, math.cos(y)]])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return ry @ rx @ rz


# Scene axes (x east, y up, z south) in the W3C earth frame (x east, y north, z up).
SCENE_TO_EARTH = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])


def w3c_angles(rotation: np.ndarray) -> tuple[float, float, float]:
    """The deviceorientation (alpha, beta, gamma) a phone would report.

    The phone's device axes coincide with the rear camera's (x right, y up,
    looking along -z), so the device-to-earth rotation is the camera rotation
    expressed in earth axes, decomposed as Rz(alpha) Rx(beta) Ry(gamma) with
    gamma kept in [-90, 90) as the specification requires.
    """
    r = SCENE_TO_EARTH @ rotation
    beta = math.atan2(r[2, 1], math.hypot(r[2, 0], r[2, 2]))
    gamma = math.atan2(-r[2, 0], r[2, 2])
    alpha = math.atan2(-r[0, 1], r[1, 1])
    if not -math.pi / 2 <= gamma < math.pi / 2:
        beta = math.pi - beta
        gamma -= math.copysign(math.pi, gamma)
        alpha += math.pi
    return (
        math.degrees(alpha) % 360.0,
        (math.degrees(beta) + 180.0) % 360.0 - 180.0,
        math.degrees(gamma),
    )


def render_view(panorama: np.ndarray, rotation: np.ndarray, horizontal_fov: float, width: int) -> np.ndarray:
    height = round(width * 4 / 3)
    focal = (width / 2) / math.tan(math.radians(horizontal_fov / 2))
    xs, ys = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    rays = np.stack([(xs - width / 2) / focal, -(ys - height / 2) / focal, -np.ones_like(xs)], axis=-1)
    world = rays @ rotation.T
    world /= np.linalg.norm(world, axis=-1, keepdims=True)
    return sample_panorama(panorama, world)


def sample_panorama(panorama: np.ndarray, directions: np.ndarray) -> np.ndarray:
    ray_yaw = np.arctan2(directions[..., 0], -directions[..., 2])
    ray_pitch = np.arcsin(np.clip(directions[..., 1], -1, 1))
    pano_h, pano_w = panorama.shape[:2]
    map_x = ((ray_yaw / (2 * math.pi) + 0.5) * pano_w - 0.5).astype(np.float32)
    map_y = ((0.5 - ray_pitch / math.pi) * pano_h - 0.5).astype(np.float32)
    return cv2.remap(panorama, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)


def apply_exposure(still: np.ndarray, gain: float, white_balance: np.ndarray) -> np.ndarray:
    """Auto-exposure acts on linear light; the JPEG stores gamma-encoded values."""
    linear = (still.astype(np.float32) / 255.0) ** 2.2
    linear *= gain * white_balance[None, None, :]
    return np.clip(np.power(np.clip(linear, 0, 1), 1 / 2.2) * 255.0 + 0.5, 0, 255).astype(np.uint8)


@dataclass
class SimulatedFrame:
    sequence: int
    band: str
    column: int
    image: np.ndarray
    yaw: float
    pitch: float
    roll: float
    imu: dict[str, float]


def yaw_steps(rng: np.random.Generator, low: float, high: float) -> list[float]:
    """Twelve uneven turns inside [low, high] that still close one circle."""
    for _ in range(2000):
        steps = rng.uniform(low, high, CAPTURE_COLUMNS)
        steps *= 360.0 / steps.sum()
        if steps.min() >= low - 1e-6 and steps.max() <= high + 1e-6:
            return [float(value) for value in steps]
    return [360.0 / CAPTURE_COLUMNS] * CAPTURE_COLUMNS


def simulate_capture(
    panorama: np.ndarray,
    extent: str,
    profile: Profile,
    rng: np.random.Generator,
    width: int,
) -> list[SimulatedFrame]:
    bands = BANDS[:1] if extent == "quick" else BANDS
    frames: list[SimulatedFrame] = []
    for band_index, (band, band_pitch) in enumerate(bands):
        steps = yaw_steps(rng, *profile.yaw_step_range)
        yaw = float(rng.uniform(-3.0, 3.0))
        for column in range(CAPTURE_COLUMNS):
            sequence = band_index * CAPTURE_COLUMNS + column
            if column > 0:
                yaw += steps[column - 1]
            pitch = band_pitch + float(rng.uniform(*profile.pitch_offset_range))
            roll = profile.roll_outliers.get(
                sequence, profile.roll_base + float(rng.uniform(-1, 1)) * profile.roll_jitter,
            )
            rotation = camera_rotation(yaw, pitch, roll)
            still = render_view(panorama, rotation, profile.horizontal_fov, width)
            white_balance = 1.0 + rng.uniform(-1, 1, 3) * profile.white_balance_jitter
            still = apply_exposure(still, float(rng.uniform(*profile.gain_range)), white_balance)
            # The phone's sensors are good but not perfect, and the heading
            # (gyro-integrated) drifts a little over the sweep.
            noisy = camera_rotation(
                yaw + rng.normal(0, profile.imu_noise) + profile.imu_yaw_drift * sequence,
                pitch + rng.normal(0, profile.imu_noise),
                roll + rng.normal(0, profile.imu_noise),
            )
            alpha, beta, gamma = w3c_angles(noisy)
            frames.append(SimulatedFrame(
                sequence, band, column, still, yaw, pitch, roll,
                {"alpha": round(alpha, 3), "beta": round(beta, 3), "gamma": round(gamma, 3)},
            ))
    return frames


def coverage_mask(frames: list[SimulatedFrame], horizontal_fov: float, width: int, height: int) -> np.ndarray:
    """Which pixels of a panorama (heading zero at the centre column) the
    simulated photographs actually saw."""
    longitude = (np.arange(width) + 0.5) / width * 2 * math.pi - math.pi
    latitude = math.pi / 2 - (np.arange(height) + 0.5) / height * math.pi
    lon, lat = np.meshgrid(longitude, latitude)
    rays = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), -np.cos(lat) * np.cos(lon)], axis=-1)
    tan_h = math.tan(math.radians(horizontal_fov / 2))
    tan_v = tan_h * 4 / 3
    seen = np.zeros((height, width), dtype=bool)
    for frame in frames:
        local = rays @ camera_rotation(frame.yaw, frame.pitch, frame.roll)
        depth = -local[..., 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            inside = (depth > 1e-3) & (np.abs(local[..., 0] / depth) <= tan_h) & (np.abs(local[..., 1] / depth) <= tan_v)
        seen |= inside
    return seen
