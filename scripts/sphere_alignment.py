"""Places every photograph of a capture on the sphere at once.

Each photo gets a full 3D camera rotation and all photos share one lens
focal length.  Both are solved together by bundle adjustment, the method
Hugin, PTGui and OpenCV's stitching pipeline use:

* features are matched between every pair of photos that can overlap: the
  neighbours of a sweep and the photos above and below in other sweeps;
* RANSAC keeps only matches that one camera rotation explains, and matches
  that contradict the phone's motion sensors (repeated wardrobe doors,
  patterned rugs) are dropped;
* a robust Levenberg-Marquardt solve then makes every matched pair of rays
  point the same way, while gravity from the motion sensors keeps the
  horizon level and plan/sensor headings hold photos that matched nothing.

Unlike chaining neighbour offsets on a cylinder, this handles uneven turns,
a phone held a few degrees down, and sideways tilt, and errors do not pile
up around the sweep.

Scene frame: x right, y up, heading zero along -z, positive yaw turning
right.  A rotation maps camera coordinates (x right, y up, looking along -z)
into the scene.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

UP = np.array([0.0, 1.0, 0.0])
FORWARD = np.array([0.0, 0.0, -1.0])
# Scene axes expressed in the W3C earth frame (x east, y north, z up).
SCENE_TO_EARTH = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])

MAX_MATCHES_PER_PAIR = 80


def heading_rotation(yaw_degrees: float) -> np.ndarray:
    y = math.radians(yaw_degrees)
    return np.array([[math.cos(y), 0.0, -math.sin(y)], [0.0, 1.0, 0.0], [math.sin(y), 0.0, math.cos(y)]])


def camera_rotation(yaw: float, pitch: float, roll: float = 0.0) -> np.ndarray:
    p, r = math.radians(pitch), math.radians(roll)
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return heading_rotation(yaw) @ rx @ rz


def rotation_from_orientation(alpha: float, beta: float, gamma: float) -> np.ndarray:
    """Rear-camera rotation from W3C deviceorientation angles.

    The device axes coincide with the rear camera's, so this is the full
    device-to-earth rotation Rz(alpha) Rx(beta) Ry(gamma) re-expressed in
    scene axes.  No Euler decoding is involved, so it stays exact near the
    upright pose where alpha and gamma swing wildly.
    """
    a, b, g = (math.radians(v) for v in (alpha, beta, gamma))
    rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    rx = np.array([[1, 0, 0], [0, math.cos(b), -math.sin(b)], [0, math.sin(b), math.cos(b)]])
    ry = np.array([[math.cos(g), 0, math.sin(g)], [0, 1, 0], [-math.sin(g), 0, math.cos(g)]])
    return SCENE_TO_EARTH.T @ (rz @ rx @ ry)


def heading_of(rotation: np.ndarray) -> float:
    forward = rotation @ FORWARD
    return math.degrees(math.atan2(forward[0], -forward[2]))


def pitch_of(rotation: np.ndarray) -> float:
    return math.degrees(math.asin(max(-1.0, min(1.0, float((rotation @ FORWARD)[1])))))


def roll_of(rotation: np.ndarray) -> float:
    """Sideways tilt: positive when the picture's top leans left."""
    forward = rotation @ FORWARD
    up = rotation @ UP
    level_right = np.cross(forward, UP)
    norm = np.linalg.norm(level_right)
    if norm < 1e-6:
        return 0.0
    level_right /= norm
    level_up = np.cross(level_right, forward)
    return math.degrees(math.atan2(-float(up @ level_right), float(up @ level_up)))


def skew(vectors: np.ndarray) -> np.ndarray:
    """Cross-product matrices for a batch of 3-vectors."""
    x, y, z = vectors[..., 0], vectors[..., 1], vectors[..., 2]
    zero = np.zeros_like(x)
    return np.stack([
        np.stack([zero, -z, y], axis=-1),
        np.stack([z, zero, -x], axis=-1),
        np.stack([-y, x, zero], axis=-1),
    ], axis=-2)


def exp_so3(vector: np.ndarray) -> np.ndarray:
    rotation, _ = cv2.Rodrigues(vector.reshape(3, 1).astype(np.float64))
    return rotation


def unit_rays(points: np.ndarray, focal: float, cx: float, cy: float) -> tuple[np.ndarray, np.ndarray]:
    """Camera-space unit rays for pixel coordinates, and d(ray)/d(log focal)."""
    vectors = np.stack([points[:, 0] - cx, -(points[:, 1] - cy), np.full(len(points), -focal)], axis=1)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    rays = vectors / norms
    d_vectors = np.zeros_like(vectors)
    d_vectors[:, 2] = -focal
    d_rays = d_vectors / norms - rays * np.sum(rays * d_vectors, axis=1, keepdims=True) / norms
    return rays, d_rays


@dataclass
class Keyframe:
    gray: np.ndarray
    points: np.ndarray
    descriptors: np.ndarray | None
    prior: np.ndarray
    # True when the prior is a sensor measurement rather than the plan.
    measured: bool


@dataclass
class PairMatch:
    first: int
    second: int
    points_first: np.ndarray
    points_second: np.ndarray
    learned: bool
    residual_degrees: float = 0.0


@dataclass
class Alignment:
    rotations: list[np.ndarray]
    focal: float
    pairs: list[PairMatch]
    rms_degrees: float
    iterations: int
    dropped_pairs: int = 0
    notes: list[str] = field(default_factory=list)


def detect_features(gray: np.ndarray, detector: Any) -> tuple[np.ndarray, np.ndarray | None]:
    mask = np.full(gray.shape, 255, dtype=np.uint8)
    border = max(4, round(gray.shape[1] * 0.02))
    mask[:border, :] = 0
    mask[-border:, :] = 0
    mask[:, :border] = 0
    mask[:, -border:] = 0
    keypoints, descriptors = detector.detectAndCompute(gray, mask)
    points = np.array([keypoint.pt for keypoint in keypoints], dtype=np.float32).reshape(-1, 2)
    return points, descriptors


def candidate_pairs(frames: list[Keyframe], horizontal_fov: float, vertical_fov: float) -> list[tuple[int, int]]:
    """Pairs whose prior viewing directions are close enough to overlap."""
    forwards = [frame.prior @ FORWARD for frame in frames]
    limit = math.radians(0.95 * max(horizontal_fov, vertical_fov))
    pairs = []
    for first in range(len(frames)):
        for second in range(first + 1, len(frames)):
            angle = math.acos(max(-1.0, min(1.0, float(forwards[first] @ forwards[second]))))
            if angle < limit:
                pairs.append((first, second))
    return pairs


def _ratio_matches(descriptors_a: np.ndarray | None, descriptors_b: np.ndarray | None) -> np.ndarray:
    if descriptors_a is None or descriptors_b is None or len(descriptors_a) < 2 or len(descriptors_b) < 2:
        return np.zeros((0, 2), dtype=np.int32)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    forward = matcher.knnMatch(descriptors_a, descriptors_b, k=2)
    backward = {m[0].queryIdx: m[0].trainIdx for m in matcher.knnMatch(descriptors_b, descriptors_a, k=1) if m}
    kept = [
        (pair[0].queryIdx, pair[0].trainIdx)
        for pair in forward
        if len(pair) == 2 and pair[0].distance < 0.78 * pair[1].distance
        and backward.get(pair[0].trainIdx) == pair[0].queryIdx
    ]
    return np.array(kept, dtype=np.int32).reshape(-1, 2)


def _guided_matches(
    a: "Keyframe",
    b: "Keyframe",
    focal: float,
    radius: float,
) -> np.ndarray:
    """Descriptor matches restricted to where the priors say a point lands.

    With the phone's orientation known to a degree or two, each feature of
    one photo can only appear in a small window of the other.  Comparing
    descriptors inside that window finds matches on plain walls and repeated
    wardrobe doors that a whole-image ratio test throws away as ambiguous.
    """
    if a.descriptors is None or b.descriptors is None or len(a.points) < 2 or len(b.points) < 2:
        return np.zeros((0, 2), dtype=np.int32)
    height, width = a.gray.shape[:2]
    cx, cy = (width - 1) * 0.5, (height - 1) * 0.5
    rays, _ = unit_rays(a.points, focal, cx, cy)
    local = rays @ (b.prior.T @ a.prior).T
    depth = -local[:, 2]
    safe = np.where(depth > 1e-3, depth, 1.0)
    predicted = np.stack([cx + focal * local[:, 0] / safe, cy - focal * local[:, 1] / safe], axis=1)
    visible = (depth > 1e-3) & (predicted[:, 0] > -radius) & (predicted[:, 0] < width + radius) \
        & (predicted[:, 1] > -radius) & (predicted[:, 1] < height + radius)
    if not visible.any():
        return np.zeros((0, 2), dtype=np.int32)
    index_a = np.flatnonzero(visible)
    da = a.descriptors[index_a].astype(np.float32)
    db = b.descriptors.astype(np.float32)
    distances = np.sqrt(np.maximum(
        (da ** 2).sum(1)[:, None] + (db ** 2).sum(1)[None, :] - 2.0 * da @ db.T, 0.0,
    ))
    spatial = np.linalg.norm(predicted[index_a][:, None, :] - b.points[None, :, :], axis=2)
    distances[spatial > radius] = np.inf
    order = np.argsort(distances, axis=1)[:, :2]
    best = distances[np.arange(len(index_a)), order[:, 0]]
    second = distances[np.arange(len(index_a)), order[:, 1]] if distances.shape[1] > 1 else np.full(len(index_a), np.inf)
    accepted = np.isfinite(best) & (best < 0.85 * second)
    candidates = {int(index_a[i]): int(order[i, 0]) for i in np.flatnonzero(accepted)}
    # Mutual: each photo-b point keeps only its closest photo-a partner.
    reverse: dict[int, tuple[float, int]] = {}
    for query, train in candidates.items():
        distance = float(np.linalg.norm(a.descriptors[query].astype(np.float32) - b.descriptors[train].astype(np.float32)))
        if train not in reverse or distance < reverse[train][0]:
            reverse[train] = (distance, query)
    kept = [(query, train) for train, (_, query) in reverse.items()]
    return np.array(kept, dtype=np.int32).reshape(-1, 2)


def _spread(points: np.ndarray, limit: int, width: int, height: int) -> np.ndarray:
    """Up to `limit` indices spread across the overlap instead of clustered."""
    if len(points) <= limit:
        return np.arange(len(points))
    cells = 8
    cell = (np.clip(points[:, 0] * cells // max(width, 1), 0, cells - 1) * cells
            + np.clip(points[:, 1] * cells // max(height, 1), 0, cells - 1)).astype(int)
    chosen: list[int] = []
    order = np.random.default_rng(7).permutation(len(points))
    buckets: dict[int, list[int]] = {}
    for index in order:
        buckets.setdefault(int(cell[index]), []).append(int(index))
    while len(chosen) < limit and buckets:
        for key in list(buckets):
            chosen.append(buckets[key].pop())
            if not buckets[key]:
                del buckets[key]
            if len(chosen) >= limit:
                break
    return np.array(chosen, dtype=np.int64)


def match_pair(
    frames: list[Keyframe],
    first: int,
    second: int,
    focal: float,
    learned: Any | None,
    min_inliers: int,
) -> PairMatch | None:
    a, b = frames[first], frames[second]
    height, width = a.gray.shape[:2]
    cx, cy = (width - 1) * 0.5, (height - 1) * 0.5
    used_learned = False
    # Same photos, same answer: RANSAC samples from OpenCV's global RNG.
    cv2.setRNGSeed(first * 1009 + second)
    indices = _ratio_matches(a.descriptors, b.descriptors)
    if a.measured and b.measured:
        guided = _guided_matches(a, b, focal, radius=0.07 * width)
        if len(guided) > len(indices):
            indices = guided
    points_a = a.points[indices[:, 0]] if len(indices) else np.zeros((0, 2), np.float32)
    points_b = b.points[indices[:, 1]] if len(indices) else np.zeros((0, 2), np.float32)
    if len(points_a) < 30 and learned is not None and learned.available() and a.gray.shape == b.gray.shape:
        correspondences = learned.match_pair(a.gray, b.gray)
        if len(correspondences) > len(points_a):
            points_a = correspondences[:, 0:2].astype(np.float32)
            points_b = correspondences[:, 2:4].astype(np.float32)
            used_learned = True
    if len(points_a) < max(8, min_inliers):
        return None

    # A pure rotation maps one photo onto the other by a homography.
    threshold = max(2.0, width / 240.0)
    homography, inliers = cv2.findHomography(points_a, points_b, cv2.RANSAC, threshold, maxIters=3000, confidence=0.997)
    if homography is None or inliers is None:
        return None
    keep = inliers.ravel().astype(bool)
    if int(keep.sum()) < min_inliers:
        return None
    points_a, points_b = points_a[keep], points_b[keep]

    # The matched rays must roughly agree with where the priors put the two
    # cameras; a confident match against the wrong wardrobe door does not.
    rays_a, _ = unit_rays(points_a, focal, cx, cy)
    rays_b, _ = unit_rays(points_b, focal, cx, cy)
    world_a = rays_a @ a.prior.T
    world_b = rays_b @ b.prior.T
    disagreement = math.degrees(float(np.median(np.arccos(np.clip(np.sum(world_a * world_b, axis=1), -1, 1)))))
    tolerance = 12.0 if a.measured and b.measured else 35.0
    if disagreement > tolerance:
        return None

    chosen = _spread(points_a, MAX_MATCHES_PER_PAIR, width, height)
    return PairMatch(first, second, points_a[chosen], points_b[chosen], used_learned)


@dataclass
class _Problem:
    first: np.ndarray
    second: np.ndarray
    points_first: np.ndarray
    points_second: np.ndarray
    pair_of_match: np.ndarray


def _build_problem(pairs: list[PairMatch]) -> _Problem:
    return _Problem(
        first=np.concatenate([np.full(len(p.points_first), p.first) for p in pairs]) if pairs else np.zeros(0, int),
        second=np.concatenate([np.full(len(p.points_first), p.second) for p in pairs]) if pairs else np.zeros(0, int),
        points_first=np.concatenate([p.points_first for p in pairs]) if pairs else np.zeros((0, 2)),
        points_second=np.concatenate([p.points_second for p in pairs]) if pairs else np.zeros((0, 2)),
        pair_of_match=np.concatenate([np.full(len(p.points_first), k) for k, p in enumerate(pairs)]) if pairs else np.zeros(0, int),
    )


def _wrap(radians: np.ndarray) -> np.ndarray:
    return (radians + np.pi) % (2 * np.pi) - np.pi


def bundle_adjust(
    frames: list[Keyframe],
    pairs: list[PairMatch],
    focal: float,
    iterations: int = 60,
) -> tuple[list[np.ndarray], float, float, int, np.ndarray]:
    """Robust Levenberg-Marquardt over all rotations and the shared focal."""
    count = len(frames)
    height, width = frames[0].gray.shape[:2]
    cx, cy = (width - 1) * 0.5, (height - 1) * 0.5
    problem = _build_problem(pairs)
    matches = len(problem.first)

    rotations = np.stack([frame.prior for frame in frames])
    priors = rotations.copy()
    prior_up = np.einsum("nji,j->ni", priors, UP)
    prior_heading = np.array([math.radians(heading_of(prior)) for prior in priors])
    measured = np.array([frame.measured for frame in frames])
    log_focal0 = math.log(focal)
    log_focal = log_focal0

    match_sigma = 1.2 / focal
    gravity_sigma = np.where(measured, math.radians(1.5), math.radians(10.0))
    heading_sigma = np.where(measured, math.radians(6.0), math.radians(20.0))
    # The first photo fixes where heading zero is; nothing else does.
    heading_sigma[0] = math.radians(0.05)
    focal_sigma = 0.25
    huber = 3.0

    rows = 3 * matches + 3 * count + count + 1
    params = 3 * count + 1

    def residuals(rotations_: np.ndarray, log_focal_: float, with_jacobian: bool):
        f = math.exp(log_focal_)
        rays_a, d_a = unit_rays(problem.points_first, f, cx, cy)
        rays_b, d_b = unit_rays(problem.points_second, f, cx, cy)
        r_a = rotations_[problem.first]
        r_b = rotations_[problem.second]
        world_a = np.einsum("nij,nj->ni", r_a, rays_a)
        world_b = np.einsum("nij,nj->ni", r_b, rays_b)
        match_error = (world_a - world_b) / match_sigma

        up_in_camera = np.einsum("nji,j->ni", rotations_, UP)
        gravity_error = (up_in_camera - prior_up) / gravity_sigma[:, None]
        forward = np.einsum("nij,j->ni", rotations_, FORWARD)
        heading = np.arctan2(forward[:, 0], -forward[:, 2])
        heading_error = _wrap(heading - prior_heading) / heading_sigma
        focal_error = np.array([(log_focal_ - log_focal0) / focal_sigma])

        # Huber weights per match (all three components share one).
        scale = np.linalg.norm(match_error, axis=1)
        weights = np.where(scale <= huber, 1.0, huber / np.maximum(scale, 1e-12))
        cost = float(np.sum(np.where(scale <= huber, 0.5 * scale ** 2, huber * scale - 0.5 * huber ** 2)))
        cost += 0.5 * float(np.sum(gravity_error ** 2) + np.sum(heading_error ** 2) + np.sum(focal_error ** 2))
        if not with_jacobian:
            return cost, None, None, None

        jacobian = np.zeros((rows, params))
        vector = np.zeros(rows)
        match_rows = np.arange(matches) * 3
        j_a = -skew(world_a) / match_sigma
        j_b = skew(world_b) / match_sigma
        j_f = (np.einsum("nij,nj->ni", r_a, d_a) - np.einsum("nij,nj->ni", r_b, d_b)) / match_sigma
        for axis in range(3):
            row = match_rows + axis
            for column in range(3):
                # Every match row touches exactly two different photos.
                jacobian[row, 3 * problem.first + column] = j_a[:, axis, column]
                jacobian[row, 3 * problem.second + column] = j_b[:, axis, column]
            jacobian[row, -1] = j_f[:, axis]
            vector[row] = match_error[:, axis]
        root = np.sqrt(np.repeat(weights, 3))
        jacobian[: 3 * matches] *= root[:, None]
        vector[: 3 * matches] *= root

        offset = 3 * matches
        gravity_jacobian = np.einsum("nji,jk->nik", rotations_, skew(UP)) / gravity_sigma[:, None, None]
        for index in range(count):
            jacobian[offset + 3 * index : offset + 3 * index + 3, 3 * index : 3 * index + 3] = gravity_jacobian[index]
        vector[offset : offset + 3 * count] = gravity_error.ravel()

        offset += 3 * count
        radius = np.maximum(forward[:, 0] ** 2 + forward[:, 2] ** 2, 1e-6)
        gradient = np.stack([-forward[:, 2] / radius, np.zeros(count), forward[:, 0] / radius], axis=1)
        heading_jacobian = np.einsum("ni,nij->nj", gradient, -skew(forward)) / heading_sigma[:, None]
        for index in range(count):
            jacobian[offset + index, 3 * index : 3 * index + 3] = heading_jacobian[index]
        vector[offset : offset + count] = heading_error

        jacobian[-1, -1] = 1.0 / focal_sigma
        vector[-1] = focal_error[0]
        return cost, jacobian, vector, weights

    damping = 1e-3
    cost, jacobian, vector, _ = residuals(rotations, log_focal, True)
    iteration = 0
    for iteration in range(1, iterations + 1):
        normal = jacobian.T @ jacobian
        gradient = jacobian.T @ vector
        step = np.linalg.solve(normal + damping * np.diag(np.diag(normal)) + 1e-9 * np.eye(params), -gradient)
        candidate = np.stack([exp_so3(step[3 * index : 3 * index + 3]) @ rotations[index] for index in range(count)])
        candidate_focal = log_focal + step[-1]
        candidate_cost, _, _, _ = residuals(candidate, candidate_focal, False)
        if candidate_cost < cost:
            improvement = cost - candidate_cost
            rotations, log_focal = candidate, candidate_focal
            cost, jacobian, vector, _ = residuals(rotations, log_focal, True)
            damping = max(damping / 3.0, 1e-7)
            if improvement < 1e-6 * max(cost, 1.0) and np.max(np.abs(step)) < 1e-6:
                break
        else:
            damping *= 6.0
            if damping > 1e8:
                break

    f = math.exp(log_focal)
    rays_a, _ = unit_rays(problem.points_first, f, cx, cy)
    rays_b, _ = unit_rays(problem.points_second, f, cx, cy)
    world_a = np.einsum("nij,nj->ni", rotations[problem.first], rays_a)
    world_b = np.einsum("nij,nj->ni", rotations[problem.second], rays_b)
    angles = np.degrees(np.arccos(np.clip(np.sum(world_a * world_b, axis=1), -1, 1)))
    rms = float(np.sqrt(np.mean(angles ** 2))) if len(angles) else 0.0
    pair_residuals = np.array([
        float(np.median(angles[problem.pair_of_match == k])) if np.any(problem.pair_of_match == k) else 0.0
        for k in range(len(pairs))
    ])
    return [rotation for rotation in rotations], f, rms, iteration, pair_residuals


def align_capture(
    frames: list[Keyframe],
    focal: float,
    learned: Any | None = None,
    min_inliers: int = 12,
) -> Alignment:
    height, width = frames[0].gray.shape[:2]
    horizontal_fov = math.degrees(2 * math.atan(width * 0.5 / focal))
    vertical_fov = math.degrees(2 * math.atan(height * 0.5 / focal))
    pairs = [
        match
        for first, second in candidate_pairs(frames, horizontal_fov, vertical_fov)
        if (match := match_pair(frames, first, second, focal, learned, min_inliers)) is not None
    ]
    rotations, solved_focal, rms, iterations, residuals = bundle_adjust(frames, pairs, focal)

    # A pair that still disagrees after the solve is a mismatch the sensor
    # check could not catch; drop it and solve again without it.
    dropped = 0
    if len(pairs) > 2:
        typical = float(np.median(residuals))
        limit = max(0.6, 4.0 * typical)
        keep = [index for index, residual in enumerate(residuals) if residual <= limit]
        dropped = len(pairs) - len(keep)
        if dropped:
            pairs = [pairs[index] for index in keep]
            rotations, solved_focal, rms, iterations, residuals = bundle_adjust(frames, pairs, focal)
    for pair, residual in zip(pairs, residuals):
        pair.residual_degrees = float(residual)

    # Keep the lens inside what any phone camera can be.
    minimum = (width * 0.5) / math.tan(math.radians(110.0 * 0.5))
    maximum = (width * 0.5) / math.tan(math.radians(30.0 * 0.5))
    solved_focal = float(min(max(solved_focal, minimum), maximum))
    return Alignment(rotations, solved_focal, pairs, rms, iterations, dropped)
