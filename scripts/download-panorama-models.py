#!/usr/bin/env python3
"""Fetches the optional SuperPoint+LightGlue matcher model for the stitcher.

The learned matcher rescues low-texture overlaps (bare painted walls) that
SIFT cannot align. It is optional: without the model the stitcher works
exactly as before. The download is pinned to a specific release artifact and
verified by SHA-256 before it is moved into place.
"""

from __future__ import annotations

import hashlib
import sys
import tempfile
import urllib.request
from pathlib import Path

MODEL_URL = (
    "https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v2.0/"
    "superpoint_lightglue_pipeline.onnx"
)
MODEL_SHA256 = "228994cea8c010146fa2aef933baa3ffaa4bcdc522bc8aa560087fcff8134526"
MODEL_PATH = Path(__file__).resolve().parent / "models" / "superpoint_lightglue_pipeline.onnx"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    if MODEL_PATH.exists() and file_sha256(MODEL_PATH) == MODEL_SHA256:
        print(f"Matcher model already installed: {MODEL_PATH}")
        return 0

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {MODEL_URL} ...")
    try:
        with tempfile.NamedTemporaryFile(dir=MODEL_PATH.parent, delete=False) as staging:
            staging_path = Path(staging.name)
        urllib.request.urlretrieve(MODEL_URL, staging_path)
    except Exception as error:
        print(
            "Could not download the learned matcher model "
            f"({type(error).__name__}). The stitcher still works with SIFT only; "
            "re-run this script later to enable bare-wall matching.",
        )
        return 0

    if file_sha256(staging_path) != MODEL_SHA256:
        staging_path.unlink(missing_ok=True)
        print("Downloaded model failed its checksum and was discarded.", file=sys.stderr)
        return 1
    staging_path.replace(MODEL_PATH)
    print(f"Installed matcher model: {MODEL_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
