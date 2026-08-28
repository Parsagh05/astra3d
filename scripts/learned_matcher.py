"""SuperPoint + LightGlue rescue matcher for low-texture room surfaces.

SIFT finds almost nothing on bare painted walls, which is the most common
real-estate capture. This module wraps a fused SuperPoint+LightGlue ONNX
pipeline that still matches faint paint gradients and soft shadows, and it is
used only when the SIFT path fails a pair, so well-textured captures pay no
extra cost.

Everything degrades gracefully: when onnxruntime or the model file is missing
the stitcher simply behaves exactly as before.
"""

from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

MODEL_FILE = "superpoint_lightglue_pipeline.onnx"
DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "models" / MODEL_FILE
# Inference width: SuperPoint keypoints stay accurate here and a CPU pair
# match takes well under a second.
MATCH_WIDTH = 512
MIN_MATCH_SCORE = 0.3


def model_path() -> Path:
    override = os.environ.get("ASTRA3D_MATCHER_MODEL")
    return Path(override) if override else DEFAULT_MODEL_PATH


class LearnedMatcher:
    """Lazily-initialized ONNX matcher shared across all pair rescues."""

    def __init__(self) -> None:
        self._session = None
        self._failed = False

    def available(self) -> bool:
        if self._failed:
            return False
        if self._session is not None:
            return True
        path = model_path()
        if not path.exists():
            self._failed = True
            return False
        try:
            import onnxruntime

            self._session = onnxruntime.InferenceSession(
                str(path), providers=["CPUExecutionProvider"],
            )
            return True
        except Exception:
            self._failed = True
            return False

    def match_pair(
        self,
        gray0: np.ndarray,
        gray1: np.ndarray,
        mask0: np.ndarray | None = None,
        mask1: np.ndarray | None = None,
    ) -> np.ndarray:
        """Matches two grayscale images of identical size.

        Returns an (N, 4) float32 array of x0, y0, x1, y1 correspondences in
        the original image coordinates, or an empty array when matching is
        unavailable or finds nothing.
        """
        empty = np.zeros((0, 4), dtype=np.float32)
        if gray0.shape != gray1.shape or not self.available():
            return empty

        scale = MATCH_WIDTH / gray0.shape[1]
        size = (MATCH_WIDTH, max(2, round(gray0.shape[0] * scale)))
        small0 = cv2.resize(gray0, size, interpolation=cv2.INTER_AREA)
        small1 = cv2.resize(gray1, size, interpolation=cv2.INTER_AREA)
        batch = np.stack([small0, small1]).astype(np.float32)[:, None] / 255.0
        try:
            keypoints, matches, scores = self._session.run(None, {"images": batch})
        except Exception:
            self._failed = True
            return empty

        good = matches[scores > MIN_MATCH_SCORE]
        if good.size == 0:
            return empty
        points0 = keypoints[0][good[:, 1]].astype(np.float32)
        points1 = keypoints[1][good[:, 2]].astype(np.float32)

        # The cylindrical warps carry black invalid borders; SuperPoint likes
        # their high-contrast edges, so matches outside the (slightly eroded)
        # valid areas are discarded.
        keep = np.ones(len(points0), dtype=bool)
        for mask, points in ((mask0, points0), (mask1, points1)):
            if mask is None:
                continue
            small_mask = cv2.erode(
                cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST),
                np.ones((9, 9), dtype=np.uint8),
            )
            xs = np.clip(points[:, 0].round().astype(int), 0, size[0] - 1)
            ys = np.clip(points[:, 1].round().astype(int), 0, size[1] - 1)
            keep &= small_mask[ys, xs] > 0
        points0, points1 = points0[keep], points1[keep]
        if len(points0) == 0:
            return empty

        correspondences = np.concatenate([points0, points1], axis=1) / scale
        return correspondences.astype(np.float32)
