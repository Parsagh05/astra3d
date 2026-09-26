# Astra3D — Interactive Spatial Commerce

Astra3D is a spatial-capture and commerce application. Its creation studio guides a smartphone user through photographing one room, sends the completed stills through a private local connection to the laptop, builds an optimized 2:1 panorama with a Node/OpenCV backend, and saves a shared project that both phone and desktop can open. A functional three-room retail flagship demonstrates the multi-room visitor experience.

The visual identity, environments, products, and copy were created for this project. The flagship is a fictional demonstration rather than a scan of a real store.

## Technology

- Next.js 16 App Router and React 19
- Node.js with Python/OpenCV panorama worker (containerized)
- TypeScript in strict mode
- React Three Fiber, Drei, and Three.js
- Docker with multi-stage builds
- Vitest and Playwright

## Quick Start (Docker)

```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.prod.yml up -d
```

Open `http://localhost:3000`. The room creator is at `http://localhost:3000/studio/` (requires secure origin for camera access).

## Makefile Commands

| Command | Purpose |
|---------|---------|
| `make dev` | Run development container with hot reload |
| `make prod` | Build and run production container |
| `make build` | Build production Docker image |
| `make build-dev` | Build development Docker image |
| `make logs` | Tail development logs |
| `make shell` | Open shell in development container |
| `make clean` | Remove containers and volumes (photos and test cases are kept) |
| `make stop` | Stop containers |
| `make import-volume` | Copy photos from the old `astra3d-data` Docker volume into `.astra3d-data/` |

## Project Data

Completed scans are saved to `.astra3d-data/projects/<project-id>/` containing:
- `project.json` - Project manifest (with the phone's motion data per photo)
- `panorama.jpg` - The stitched panorama
- `frames/` - Source photographs

Both compose files bind-mount `.astra3d-data/` and `test-cases/` from the project
folder on your computer, so saved photos survive container restarts, rebuilds and
`docker compose down -v`. Earlier versions kept them in a Docker volume that those
commands could delete; run `make import-volume` once to copy anything still in it.

## Features

- **Room Capture Studio** (`/studio/`): Phone-first workflow; a full 360 (36 photos: eye level, ceiling and floor) by default, or a 12-photo eye-level quick scan. Each photo uses the full camera sensor when the browser supports ImageCapture, and panoramas are blended natively at 4096 × 2048
- **Photo-sphere guided capture**: a fixed white ring marks where the camera points and an orange dot marks the next target in the room. Turn right until the dot sits in the ring and hold still; the ring fills and the photo is taken. Captured photos are painted onto a gridded sphere around the live view so coverage is visible as it grows
- **Test maker** (`/test-maker`): capture a room once with the same guidance and save it straight into `test-cases/`
- **Tests** (`/tests`): re-run any test case, or any capture saved in `.astra3d-data/`, through the current stitcher and compare quality reports
- **360° Panorama stitching**: every photo's full 3D rotation and the lens are solved together by bundle adjustment (sensor-guided SIFT matching, RANSAC, robust Levenberg–Marquardt), levelled by gravity from the phone's motion sensors, brightness and colour equalised in linear light, then graph-cut seams and multiband blending. The report explains how the photos were taken (uneven turns, a dipped or tilted phone, changing exposure)
- **Consistent photos**: exposure, white balance and focus are locked after the first photo where the browser allows it, and a photo is only taken with the dot inside the ring and the phone upright
- **3D walk-through scans** (`/scan`): a separate section from the photo studio. Film a slow walk around a room (or upload a video) and the server turns it into a Gaussian splat you can walk through in the browser. See [3D Scans](#3d-scans)
- **Optional ML matcher**: SuperPoint+LightGlue for low-texture rooms
- **Interactive tours**: WebGL panorama viewer with hotspots, floor plan, navigation
- **Demo flagship**: "Astra Atelier" - 3-room fashion boutique

## Docker

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (dev + production) |
| `docker-compose.yml` | Development workflow |
| `docker-compose.prod.yml` | Production deployment |
| `docker-compose.gpu.yml` | Adds the GPU worker for photoreal 3D scans (with the production file) |
| `Dockerfile.splat-worker` | nerfstudio-based GPU worker for 3D scans |
| `.dockerignore` | Build context exclusions |

### Development Image
- Hot reload enabled via volume mount
- All dependencies included
- Python/OpenCV for panorama processing

### Production Image
- Optimized multi-stage build
- Non-root user for security
- Healthcheck included

## Testing

### Panorama regression cases

`test-cases/<group>/<case>/` holds fixed capture sets: `01.jpg … 12.jpg` (quick) or
`01.jpg … 36.jpg` (full) plus an optional `metadata.json` with the phone's motion
data. The group folder name is only for people (`12-images`, `36-images`, `12`, …);
the plan comes from `metadata.json` or the photo count, and folders that fit
neither are listed as skipped on the Tests page.

- Capture new cases on a phone at `/test-maker` (saved directly, or as a ZIP to extract into `test-cases/`).
- Keep a capture you made in the studio with **Keep** on the Tests page.
- Render a ground-truth case from any 2:1 panorama:

```bash
python scripts/make-test-case.py --panorama public/images/tours/flagship/arrival-2048.webp \
  --extent quick --name synthetic-arrival
```

Open `/tests` and use **Run** or **Run all** to stitch them with the current algorithm.
`handheld-lounge` reproduces a careless handheld capture: uneven turns, a
dipped and tilted phone, and changing exposure.

### Stitching benchmark

`scripts/panorama-benchmark.py` renders simulated captures from known
panoramas (steady and handheld hands, quick and full scans, with or without
motion data), stitches them exactly as the server does and scores the result
against the truth: PSNR/SSIM over everything photographed, the outer edges
where cropping shows first, brightness banding, and horizon error.

```bash
python scripts/panorama-benchmark.py                        # all 12 scenarios
python scripts/panorama-benchmark.py --profile handheld --no-imu
```

### Automated checks

```bash
# Run tests inside container
docker-compose exec astra3d npm test

# E2E tests (after build)
docker-compose exec astra3d npm run test:e2e

# Full verification
docker-compose exec astra3d npm run verify

# 3D scan file formats and coordinate frames
docker-compose exec astra3d python3 scripts/test_splat_format.py
```

## 3D Scans

The photo studio makes a 360° panorama from one standing point: you can look
around but not move. The 3D scan section (`/scan`) instead reconstructs the room
itself, the way apps like Polycam and Luma do, as a **Gaussian splat**: millions of
small coloured, semi-transparent ellipsoids optimised until renders of them match
the video frames. Walking around inside it shows real depth and parallax.

**Filming.** The recorder films 1080p video with exposure and white balance locked,
and uses the phone's motion sensors to show which parts of the room have been
filmed (eye level, floor, ceiling) and to warn when you turn too fast. Walk,
don't spin; do three slow loops (eye level, tilted down, tilted up); 1–3
minutes in good light. A video from the camera app can be uploaded instead
(MP4, MOV, WebM, MKV; up to 1.5 GB, set `ASTRA3D_SCAN_MAX_BYTES` to change).

**Processing** (`scripts/splat_pipeline.py`), one folder per scan in
`.astra3d-data/scans/<id>/`:

1. **Frames**: the sharpest frame of every short time window (up to 180) is kept; motion-blurred frames are dropped.
2. **Camera poses**: COLMAP (pycolmap) finds where every frame was taken and a sparse 3D point cloud.
3. **Training**: on an NVIDIA GPU, nerfstudio's `splatfacto` trains the Gaussian splat (30,000 steps). Without a GPU, a quick *preview* places one splat per reconstructed point, so the capture can be checked right away.
4. **Export**: the scene is levelled (gravity from how the phone was held), centred on the walked path, scaled to room size, and written as `scene.splat` for the browser viewer (Spark), with `scene.ply` (full quality, spherical harmonics) for other tools.

The viewer starts where the video started. Drag to look around, WASD / arrow keys
or pinch to move, or press *Walk the capture path* to replay the walk.

**Running it.** By default the web server processes scans itself, one at a time
(preview quality without a GPU). For photoreal scenes, add the GPU worker:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.gpu.yml up -d --build
```

The worker (`Dockerfile.splat-worker`, based on the nerfstudio image) watches the
shared `.astra3d-data/scans/` folder, so it can also run on a separate GPU machine
that mounts the same folder; set `ASTRA3D_SCAN_WORKER=external` on the web server.
Earlier preview scans can be re-processed from the scan list once the worker runs;
frames and camera poses are reused.

| Resource | Preview (CPU) | Trained (GPU worker) |
|----------|---------------|----------------------|
| GPU | none | NVIDIA, 8 GB VRAM (24 GB for large rooms) |
| RAM | 4 GB | 16–32 GB |
| Time per scan | 2–10 min | 15–40 min |
| Disk per scan | video + ~100 MB | video + 0.5–1.5 GB |

Environment variables: `ASTRA3D_SCAN_WORKER` (`local` or `external`),
`ASTRA3D_SPLAT_TRAINER` (`auto`, `nerfstudio`, `preview`),
`ASTRA3D_SPLAT_MAX_FRAMES`, `ASTRA3D_SPLAT_ITERATIONS`,
`ASTRA3D_SPLAT_MAPPING_TIMEOUT` (seconds), `ASTRA3D_PYTHON`.

Outside Docker, install the pipeline's Python packages with `npm run setup:panorama`.
`python scripts/make-scan-video.py` renders a synthetic walk-through video for testing.

## Shared Phone/Laptop Projects

Phone and laptop must be on the same network. For camera access on phone, the laptop server must use HTTPS or localhost. Use ADB reverse proxy for local testing:

```powershell
adb connect PHONE_IP:PORT
adb reverse tcp:3000 tcp:3000
```

Then open `http://localhost:3000/studio/` on the phone.

## Architecture

```
src/
├── app/                    Pages, API routes, metadata
├── components/
│   ├── tour/               Panorama viewer, hotspots
│   ├── platform/           Marketing showcase
│   ├── room-capture/       Camera capture studio
│   └── scan/               3D scan recorder, job list, splat viewer
├── server/                 Panorama worker, project/test-case/scan stores, scan runner
├── data/                   Tour and platform content
└── types/                  TypeScript definitions
```

## Limitations

- No authentication or user accounts
- No cloud storage - all data is local
- The photo studio requires a fixed standing point; walkable rooms come from the 3D scan section
- Photoreal 3D scans need an NVIDIA GPU worker
- No WebXR/VR - browser-based only
- Demo cart/checkout is illustrative only

## Canonical URL

The canonical URL is `https://astra3d.com`. Update `metadataBase` in `src/app/layout.tsx` before deployment.
