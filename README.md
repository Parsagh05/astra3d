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
| `make clean` | Remove containers and volumes |
| `make stop` | Stop containers |

## Project Data

Completed scans are saved to `.astra3d-data/projects/<project-id>/` containing:
- `project.json` - Project manifest
- `panorama.jpg` - The stitched panorama
- `frames/` - Source photographs

The Docker compose file mounts a named volume for persistent project data.

## Features

- **Room Capture Studio** (`/studio/`): Phone-first workflow with 12 (quick) or 36 (full) photos per room
- **IMU-guided capture**: Motion-sensor guidance with automatic still capture
- **360° Panorama stitching**: SIFT alignment, exposure compensation, blending
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
├── server/                 Panorama worker orchestration
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
