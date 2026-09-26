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
- **Optional ML matcher**: SuperPoint+LightGlue for low-texture rooms
- **Interactive tours**: WebGL panorama viewer with hotspots, floor plan, navigation
- **Demo flagship**: "Astra Atelier" - 3-room fashion boutique

## Docker

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (dev + production) |
| `docker-compose.yml` | Development workflow |
| `docker-compose.prod.yml` | Production deployment |
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
```

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
│   └── room-capture/       Camera capture studio
├── server/                 Panorama worker, project store, test-case store
├── data/                   Tour and platform content
└── types/                  TypeScript definitions
```

## Limitations

- No authentication or user accounts
- No cloud storage - all data is local
- Studio requires fixed standing point (no walkable reconstruction)
- No WebXR/VR - browser-based only
- Demo cart/checkout is illustrative only

## Canonical URL

The canonical URL is `https://astra3d.com`. Update `metadataBase` in `src/app/layout.tsx` before deployment.
