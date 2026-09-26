#!/usr/bin/env python3
"""Turns a walk-through video of a room into a 3D Gaussian splat.

Stages, each reported to the job's job.json as it runs:

1. frames  - picks the sharpest frame in every short time window of the
             video (motion blur is the main enemy) and resizes to 1600 px;
2. poses   - COLMAP (pycolmap) finds the camera position of every frame
             and a sparse 3D point cloud of the room;
3. training
   * trained: nerfstudio's `splatfacto` optimises millions of Gaussians on
     an NVIDIA GPU (ns-train, then ns-export gaussian-splat);
   * preview: without a GPU, one Gaussian per reconstructed 3D point, so the
     capture can be checked and walked through at once;
4. export  - levels and centres the scene and writes scene.splat (what the
             browser streams), scene.json (camera path, counts) and poster.jpg.

Run one job:            python scripts/splat_pipeline.py --job .astra3d-data/scans/<id>
Serve a queue (GPU box): python scripts/splat_pipeline.py --watch .astra3d-data/scans

ASTRA3D_SPLAT_TRAINER picks the trainer: auto (default: nerfstudio when
`ns-train` and CUDA are available, otherwise preview), nerfstudio, preview.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from splat_format import (  # noqa: E402
    Gaussians,
    encode_splat,
    gaussians_from_3dgs,
    nerfstudio_to_colmap,
    read_ply,
    viewer_frame,
)

FRAME_MAX_DIMENSION = 1600
MIN_FRAMES = 20
MIN_REGISTERED = 12
MAX_FEATURES = 4096
PHONE_FOCAL_FACTOR = 0.75
MAPPING_TIMEOUT_SECONDS = int(os.environ.get("ASTRA3D_SPLAT_MAPPING_TIMEOUT", "2400"))
HEARTBEAT_SECONDS = 20
# Stage share of the overall progress bar.
STAGES = {"frames": (0.0, 0.1), "poses": (0.1, 0.35), "training": (0.35, 0.95), "export": (0.95, 1.0)}


class ScanError(RuntimeError):
    """A problem with the capture itself, explained to the user."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Job:
    """job.json, rewritten atomically so the web app never reads half a file."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.path = directory / "job.json"
        self.lock = threading.Lock()
        self.data: dict[str, Any] = json.loads(self.path.read_text(encoding="utf-8"))

    def update(self, **fields: Any) -> None:
        with self.lock:
            self.data.update(fields)
            self.data["updatedAt"] = now_iso()
            self.data["heartbeatAt"] = self.data["updatedAt"]
            temporary = self.path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
            os.replace(temporary, self.path)

    def progress(self, stage: str, fraction: float, message: str) -> None:
        start, end = STAGES[stage]
        self.update(stage=stage, progress=round(start + (end - start) * max(0.0, min(1.0, fraction)), 4), message=message)

    def heartbeat(self) -> None:
        self.update()

    def keep_alive(self) -> Callable[[], None]:
        """Beats in the background (feature extraction and mapping can run
        for minutes without a progress callback); returns the stop function."""
        stop = threading.Event()

        def beat() -> None:
            while not stop.wait(HEARTBEAT_SECONDS):
                try:
                    self.heartbeat()
                except OSError:
                    return

        thread = threading.Thread(target=beat, daemon=True)
        thread.start()
        return stop.set


def claim(directory: Path) -> bool:
    """Takes a queued job exclusively; another worker gets False."""
    try:
        descriptor = os.open(directory / "claim.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    with os.fdopen(descriptor, "w") as handle:
        handle.write(f"{socket.gethostname()}:{os.getpid()}\n")
    return True


def release(directory: Path) -> None:
    try:
        (directory / "claim.lock").unlink()
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------- frames

def sharpness(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def extract_frames(video: Path, output: Path, max_frames: int, report: Callable[[float, str], None]) -> list[str]:
    """Keeps the sharpest frame of each time window, up to `max_frames`."""
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise ScanError("The video could not be opened. Record again or upload an MP4 or WebM file.")
    # Pass 1: timestamps and sharpness only, on small copies.
    samples: list[tuple[int, float, float]] = []
    index = 0
    fps = capture.get(cv2.CAP_PROP_FPS)
    total = capture.get(cv2.CAP_PROP_FRAME_COUNT)
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        position = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if not math.isfinite(position) or position <= 0:
            position = index / (fps if 1 <= fps <= 240 else 30.0)
        small = cv2.resize(frame, (320, max(2, round(320 * frame.shape[0] / frame.shape[1]))), interpolation=cv2.INTER_AREA)
        samples.append((index, position, sharpness(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))))
        index += 1
        if index % 30 == 0:
            report(0.5 * min(1.0, index / total) if total > 0 else 0.25, f"Reading video… {index} frames")
    capture.release()
    if len(samples) < MIN_FRAMES:
        raise ScanError("The video is too short. Film for at least 20 seconds while walking slowly around the room.")

    duration = max(samples[-1][1] - samples[0][1], 1e-3)
    window = max(duration / max_frames, 1.0 / 6.0)
    median = float(np.median([s[2] for s in samples]))
    chosen: dict[int, tuple[int, float]] = {}
    for frame_index, position, score in samples:
        # Frames far blurrier than the video's typical frame are motion blur.
        if score < 0.35 * median:
            continue
        bucket = int((position - samples[0][1]) / window)
        if bucket not in chosen or score > chosen[bucket][1]:
            chosen[bucket] = (frame_index, score)
    keep = sorted(frame_index for frame_index, _ in chosen.values())
    if len(keep) < MIN_FRAMES:
        raise ScanError("Most of the video is blurred. Move more slowly, keep the room well lit, and film again.")

    # Pass 2: save the chosen frames at working resolution.
    output.mkdir(parents=True, exist_ok=True)
    wanted = set(keep)
    capture = cv2.VideoCapture(str(video))
    names: list[str] = []
    index = 0
    while wanted:
        ok, frame = capture.read()
        if not ok:
            break
        if index in wanted:
            height, width = frame.shape[:2]
            scale = min(1.0, FRAME_MAX_DIMENSION / max(height, width))
            if scale < 1.0:
                frame = cv2.resize(frame, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
            name = f"frame_{len(names):05d}.jpg"
            cv2.imwrite(str(output / name), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
            names.append(name)
            wanted.discard(index)
            report(0.5 + 0.5 * len(names) / len(keep), f"Keeping sharp frames… {len(names)}/{len(keep)}")
        index += 1
    capture.release()
    return names


# ----------------------------------------------------------------- poses

def solve_poses(images: Path, work: Path, sparse_out: Path, report: Callable[[float, str], None]) -> Any:
    """COLMAP: features, sequential matching (the frames are a path), mapping."""
    import pycolmap

    database = work / "database.db"
    if database.exists():
        database.unlink()
    report(0.05, "Finding features in every frame…")
    reader = pycolmap.ImageReaderOptions()
    # Phone video has square pixels and mild lens distortion: one focal
    # length and one radial term.  Separate fx/fy (OPENCV) self-calibrate
    # unstably on a walk-through and bend or fragment the reconstruction.
    reader.camera_model = "SIMPLE_RADIAL"
    # Video carries no focal length.  Phone main cameras are ~26 mm
    # equivalent (focal ≈ 0.72 x the long side); COLMAP's generic 1.2 x
    # guess is a telephoto lens and misleads self-calibration.
    reader.default_focal_length_factor = PHONE_FOCAL_FACTOR
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.max_image_size = FRAME_MAX_DIMENSION
    # 4k features per frame is plenty for neighbouring video frames and keeps
    # mapping minutes, not hours, on a CPU.
    extraction.sift.max_num_features = MAX_FEATURES
    pycolmap.extract_features(database, images, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=reader, extraction_options=extraction)
    report(0.35, "Matching neighbouring frames…")
    pairing = pycolmap.SequentialPairingOptions()
    pairing.overlap = 12
    pairing.quadratic_overlap = True
    pycolmap.match_sequential(database, pairing_options=pairing)

    report(0.6, "Solving camera positions…")
    mapping_dir = work / "mapping"
    shutil.rmtree(mapping_dir, ignore_errors=True)
    mapping_dir.mkdir(parents=True)
    options = pycolmap.IncrementalPipelineOptions()
    options.multiple_models = True
    options.max_num_models = 5
    options.extract_colors = True
    options.max_runtime_seconds = MAPPING_TIMEOUT_SECONDS
    # Neighbouring video frames are close together: accept a narrower
    # triangulation angle for the first pair than photo collections need.
    options.mapper.init_min_tri_angle = 8.0
    registered_count = {"value": 0}

    def next_image() -> None:
        registered_count["value"] += 1
        if registered_count["value"] % 5 == 0:
            report(0.6 + 0.35 * min(1.0, registered_count["value"] / max(1, len(list(images.iterdir())))),
                   f"Solving camera positions… {registered_count['value']} frames placed")

    reconstructions = pycolmap.incremental_mapping(database, images, mapping_dir, options, next_image_callback=next_image)
    if not reconstructions:
        raise ScanError("The frames could not be placed in 3D. Walk slowly, keep the room in view, and avoid pointing at blank walls.")
    best = max(reconstructions.values(), key=lambda rec: rec.num_reg_images())
    total = len(list(images.iterdir()))
    if best.num_reg_images() < max(MIN_REGISTERED, 0.5 * total):
        raise ScanError(
            f"Only {best.num_reg_images()} of {total} frames could be placed. "
            "Move more slowly and keep overlapping views of the room in every part of the video."
        )
    shutil.rmtree(sparse_out, ignore_errors=True)
    sparse_out.mkdir(parents=True)
    best.write(sparse_out)
    report(1.0, f"Placed {best.num_reg_images()} of {total} frames")
    return best


def camera_geometry(reconstruction: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """Camera centres, up and forward vectors (COLMAP world), in frame order."""
    images = sorted(reconstruction.images.values(), key=lambda image: image.name)
    centers, ups, forwards, names = [], [], [], []
    for image in images:
        pose = image.cam_from_world() if callable(image.cam_from_world) else image.cam_from_world
        rotation = np.asarray(pose.rotation.matrix())
        translation = np.asarray(pose.translation)
        centers.append(-rotation.T @ translation)
        # COLMAP cameras look along +z with image-down along +y.
        ups.append(rotation.T @ np.array([0.0, -1.0, 0.0]))
        forwards.append(rotation.T @ np.array([0.0, 0.0, 1.0]))
        names.append(image.name)
    return np.array(centers), np.array(ups), np.array(forwards), names


def sparse_points(reconstruction: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    points = list(reconstruction.points3D.values())
    if not points:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0)
    xyz = np.array([point.xyz for point in points], dtype=np.float64)
    rgb = np.array([point.color for point in points], dtype=np.float64) / 255.0
    error = np.array([point.error for point in points], dtype=np.float64)
    track = np.array([point.track.length() for point in points], dtype=np.float64)
    keep = (track >= 3) & (error < 2.0)
    return xyz[keep], rgb[keep], track[keep]


# -------------------------------------------------------------- training

def cuda_available() -> bool:
    try:
        import torch  # noqa: PLC0415

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def choose_trainer(requested: str) -> str:
    if requested in ("nerfstudio", "preview"):
        return requested
    return "nerfstudio" if shutil.which("ns-train") and shutil.which("ns-export") and cuda_available() else "preview"


def nearest_spacing(points: np.ndarray, neighbours: int = 3) -> np.ndarray:
    """Mean distance to the nearest few points, in chunks to bound memory."""
    count = len(points)
    if count <= neighbours:
        return np.full(count, 0.05)
    result = np.empty(count)
    squared = np.sum(points ** 2, axis=1)
    for start in range(0, count, 1024):
        block = points[start : start + 1024]
        distances = np.sum(block ** 2, axis=1)[:, None] + squared[None, :] - 2.0 * block @ points.T
        distances = np.sqrt(np.maximum(np.partition(distances, neighbours, axis=1)[:, 1 : neighbours + 1], 0.0))
        result[start : start + 1024] = distances.mean(axis=1)
    return result


def preview_gaussians(xyz: np.ndarray, rgb: np.ndarray) -> Gaussians:
    """One soft Gaussian per reconstructed point, sized to its neighbourhood."""
    spacing = np.clip(nearest_spacing(xyz), 1e-4, None)
    limit = float(np.percentile(spacing, 95))
    size = np.minimum(spacing, limit) * 0.6
    rotations = np.zeros((len(xyz), 4), dtype=np.float32)
    rotations[:, 0] = 1.0
    return Gaussians(
        positions=xyz.astype(np.float32),
        scales=np.repeat(size[:, None], 3, axis=1).astype(np.float32),
        rotations=rotations,
        colors=rgb.astype(np.float32),
        opacities=np.full(len(xyz), 0.9, dtype=np.float32),
    )


def run_logged(command: list[str], log: Path, on_line: Callable[[str], None], job: Job) -> None:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write("$ " + " ".join(command) + "\n")
        handle.flush()
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        last_beat = time.monotonic()
        assert process.stdout is not None
        for line in process.stdout:
            handle.write(line)
            on_line(line)
            if time.monotonic() - last_beat > HEARTBEAT_SECONDS:
                job.heartbeat()
                last_beat = time.monotonic()
        code = process.wait()
    if code != 0:
        raise RuntimeError(f"{command[0]} exited with {code}; see pipeline.log")


def train_nerfstudio(processed: Path, work: Path, job: Job, iterations: int) -> Gaussians:
    """splatfacto on the GPU; returns Gaussians in the COLMAP frame."""
    outputs = work / "nerfstudio"
    shutil.rmtree(outputs, ignore_errors=True)
    log = job.directory / "pipeline.log"
    progress_line = re.compile(r"^\s*(\d+)\s+\((\d+(?:\.\d+)?)%\)")

    def on_train_line(line: str) -> None:
        match = progress_line.match(line)
        if match:
            percent = float(match.group(2)) / 100.0
            job.progress("training", percent, f"Training the 3D scene… {match.group(2)}%")

    job.progress("training", 0.0, "Starting GPU training…")
    run_logged([
        "ns-train", "splatfacto",
        "--data", str(processed),
        "--output-dir", str(outputs),
        "--experiment-name", "scene",
        "--timestamp", "run",
        "--max-num-iterations", str(iterations),
        "--vis", "tensorboard",
        "--viewer.quit-on-train-completion", "True",
        "colmap",
        "--colmap-path", "colmap/sparse/0",
        "--images-path", "images",
        "--eval-mode", "all",
        "--downscale-factor", "1",
    ], log, on_train_line, job)

    run_dir = outputs / "scene" / "splatfacto" / "run"
    job.progress("export", 0.1, "Exporting the trained scene…")
    export_dir = work / "export"
    shutil.rmtree(export_dir, ignore_errors=True)
    run_logged([
        "ns-export", "gaussian-splat",
        "--load-config", str(run_dir / "config.yml"),
        "--output-dir", str(export_dir),
    ], log, lambda _line: None, job)
    ply = export_dir / "splat.ply"
    if not ply.exists():
        raise RuntimeError("ns-export did not write splat.ply")
    shutil.copyfile(ply, job.directory / "scene.ply")
    dataparser = json.loads((run_dir / "dataparser_transforms.json").read_text(encoding="utf-8"))
    return nerfstudio_to_colmap(gaussians_from_3dgs(read_ply(ply)), dataparser)


# ---------------------------------------------------------------- export

def write_scene(job: Job, gaussians: Gaussians, reconstruction: Any, frames_dir: Path, kind: str, total_frames: int) -> None:
    centers, ups, forwards, names = camera_geometry(reconstruction)
    xyz, _, _ = sparse_points(reconstruction)
    frame = viewer_frame(centers, ups, forwards[0], xyz if len(xyz) else gaussians.positions.astype(np.float64))
    placed = frame.apply_gaussians(gaussians)
    # Drop far-away outliers (sky through windows, mismatched points) that
    # would make the scene's bounds meaningless.
    distance = np.linalg.norm(placed.positions, axis=1)
    keep = distance < max(30.0, float(np.percentile(distance, 99.5)) * 1.5)
    placed = Gaussians(placed.positions[keep], placed.scales[keep], placed.rotations[keep], placed.colors[keep], placed.opacities[keep])

    temporary = job.directory / "scene.splat.tmp"
    temporary.write_bytes(encode_splat(placed))
    os.replace(temporary, job.directory / "scene.splat")

    path_positions = frame.apply_points(centers)
    path_forwards = frame.apply_directions(forwards)
    step = max(1, len(path_positions) // 240)
    low, high = np.percentile(placed.positions, 2, axis=0), np.percentile(placed.positions, 98, axis=0)
    scene = {
        "version": 1,
        "kind": kind,
        "gaussians": int(len(placed)),
        "frames": {"used": int(total_frames), "placed": int(len(centers))},
        "up": [0, 1, 0],
        "bounds": {"min": [round(float(v), 3) for v in low], "max": [round(float(v), 3) for v in high]},
        "path": [
            {"position": [round(float(v), 4) for v in p], "forward": [round(float(v), 4) for v in f]}
            for p, f in zip(path_positions[::step], path_forwards[::step])
        ],
    }
    (job.directory / "scene.json").write_text(json.dumps(scene), encoding="utf-8")

    poster = frames_dir / names[len(names) // 2]
    image = cv2.imread(str(poster))
    if image is not None:
        height, width = image.shape[:2]
        scale = 720.0 / max(height, width)
        image = cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(job.directory / "poster.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 85])


# ------------------------------------------------------------------ main

def process_job(directory: Path, trainer_request: str, max_frames: int, iterations: int) -> None:
    job = Job(directory)
    work = directory / "work"
    processed = work / "processed"
    images = processed / "images"
    sparse = processed / "colmap" / "sparse" / "0"
    trainer = choose_trainer(os.environ.get("ASTRA3D_SPLAT_TRAINER", trainer_request))
    job.update(status="running", stage="frames", progress=0.0, message="Starting…", error=None,
               worker={"host": socket.gethostname(), "trainer": trainer}, startedAt=now_iso())
    stop_heartbeat = job.keep_alive()
    try:
        video = directory / job.data["video"]["file"]
        # Re-processing reuses frames and poses from an earlier run.
        if images.exists() and (sparse / "images.bin").exists():
            import pycolmap

            reconstruction = pycolmap.Reconstruction(str(sparse))
            names = sorted(path.name for path in images.iterdir())
            job.progress("poses", 1.0, "Reusing frames and camera positions from the last run")
        else:
            shutil.rmtree(work, ignore_errors=True)
            names = extract_frames(video, images, max_frames, lambda f, m: job.progress("frames", f, m))
            reconstruction = solve_poses(images, work, sparse, lambda f, m: job.progress("poses", f, m))

        if trainer == "nerfstudio":
            gaussians = train_nerfstudio(processed, work, job, iterations)
        else:
            job.progress("training", 0.5, "Building a preview from the reconstructed points…")
            xyz, rgb, _ = sparse_points(reconstruction)
            if len(xyz) < 200:
                raise ScanError("Too few 3D points were found. Film a room with more visible detail and better light.")
            gaussians = preview_gaussians(xyz, rgb)
        job.progress("export", 0.5, "Writing the scene for the viewer…")
        write_scene(job, gaussians, reconstruction, images, "trained" if trainer == "nerfstudio" else "preview", len(names))
        # Keep frames and poses for a later GPU run; drop training scratch.
        for scratch in ("nerfstudio", "export", "mapping", "database.db"):
            target = work / scratch
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink()
        job.update(
            status="done", stage="done", progress=1.0, finishedAt=now_iso(),
            message="Ready" if trainer == "nerfstudio" else "Preview ready. Add a GPU worker for the photoreal scene.",
            result={
                "kind": "trained" if trainer == "nerfstudio" else "preview",
                "gaussians": len(gaussians),
                "frames": len(names),
                "placed": int(reconstruction.num_reg_images()),
                "sceneBytes": (directory / "scene.splat").stat().st_size,
            },
        )
    except ScanError as error:
        job.update(status="failed", error=str(error), message=str(error), finishedAt=now_iso())
    except Exception as error:  # noqa: BLE001 - reported to the user, details in the log
        with open(directory / "pipeline.log", "a", encoding="utf-8") as handle:
            handle.write(f"{type(error).__name__}: {error}\n")
        job.update(status="failed", error="Processing failed on the server. Details are in pipeline.log.",
                   message="Processing failed", finishedAt=now_iso())
    finally:
        stop_heartbeat()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--job", type=Path, help="process this one job directory")
    target.add_argument("--watch", type=Path, help="keep processing queued jobs in this scans folder")
    parser.add_argument("--trainer", choices=["auto", "nerfstudio", "preview"], default="auto")
    parser.add_argument("--max-frames", type=int, default=int(os.environ.get("ASTRA3D_SPLAT_MAX_FRAMES", "180")))
    parser.add_argument("--iterations", type=int, default=int(os.environ.get("ASTRA3D_SPLAT_ITERATIONS", "30000")))
    args = parser.parse_args()

    if args.job:
        if not claim(args.job):
            print("Job already claimed by another worker.", file=sys.stderr)
            return 3
        try:
            process_job(args.job, args.trainer, args.max_frames, args.iterations)
        finally:
            release(args.job)
        return 0

    print(f"Watching {args.watch} for queued scans (trainer: {choose_trainer(args.trainer)})", flush=True)
    while True:
        for job_file in sorted(args.watch.glob("*/job.json")):
            try:
                status = json.loads(job_file.read_text(encoding="utf-8")).get("status")
            except (OSError, ValueError):
                continue
            if status != "queued" or not claim(job_file.parent):
                continue
            try:
                print(f"Processing {job_file.parent.name}", flush=True)
                process_job(job_file.parent, args.trainer, args.max_frames, args.iterations)
            except Exception as error:  # noqa: BLE001 - one bad job must not stop the worker
                print(f"Job {job_file.parent.name} could not be processed: {error}", file=sys.stderr, flush=True)
            finally:
                release(job_file.parent)
        time.sleep(3)


if __name__ == "__main__":
    raise SystemExit(main())
