# photo-3d-and-house-tour: New Features

This branch adds two ways to turn photos of a house into something you can move around in:

1. **Take photos for 3D** (`/scan`): take photos while stepping around a room; the server
   builds a 3D room (Gaussian splat) you can walk through freely.
2. **House tours** (`/tours`): link the 360° rooms from the studio with arrows and walk
   from room to room, like Street View or GeoGuessr. No GPU needed.

---

## Added

### 1. Take photos for 3D (`/scan`)

- **"Take photos for 3D" button**: opens a full-screen camera. The user takes a photo,
  steps sideways, takes the next one, and so on.
  - Photo counter: at least 20 photos, aim for 60+, maximum 180.
  - Live tips: start in a corner, step between photos, then tilt down for the floor
    and tilt up for the ceiling.
  - Warns when the phone turned more than ~35° since the last photo (too little overlap).
  - Refuses blurry photos so they can be taken again.
  - Coverage map (up / eye level / down × 12 directions) fills in as the room is covered.
  - Locks exposure and white balance after the first photo so colours stay even.
  - Undo last photo; Done is enabled from 20 photos.
- **"Upload photos" button**: pick photos from the gallery instead. They are shrunk to
  1920 px on the phone, sorted by file name, and unreadable ones are skipped.
- Photos are packed into **one ZIP** (no compression) and uploaded with a progress bar.
- The scan list and scan page say "photos" instead of "frames" for photo scans.

**Server**
- `POST /api/scans` now also accepts `Content-Type: application/zip`. It checks that the
  ZIP is real and holds 20–400 photos before queueing it, and saves it as `photos.zip`.
- `scripts/splat_pipeline.py`:
  - New `extract_photos()`: unpacks the photos in capture order, resizes them to 1600 px
    and drops very blurry ones. ZIP entry names are never used as paths, so a crafted
    ZIP cannot write outside the scan folder.
  - Up to 150 photos are matched every pair with every pair (order doesn't matter);
    larger sets are matched with their neighbours.
  - Photos of different sizes (portrait + landscape) get separate camera models.
  - Photo-specific error messages, such as "take a small step between photos so each
    one overlaps the last".

### 2. House tours (`/tours`)

- **Tours page** (`/tours`): explains the three steps, lets you name a tour and tick
  studio rooms in walking order, and lists existing tours (open / edit / delete).
- **Tour viewer** (`/tours/<id>`):
  - Drag or swipe to look around; pinch or scroll to zoom.
  - An arrow button in each doorway, plus a GeoGuessr-style ring of arrows at the bottom.
  - Keyboard: ← → or A / D turn, ↑ or W walks to the arrow ahead, ↓ or S turns around.
  - After each step you keep facing the way you walked, with a short fade between rooms.
- **Arrow editor** (`/tours/<id>?edit=1` or "Edit arrows"):
  - "Arrow to… → Place arrow", then click where the doorway is.
  - After placing an arrow, offers to go to the other room and place the arrow back.
  - Rename rooms, "Start facing this way", "Start the tour here", remove arrows or rooms,
    and add more rooms from the studio.
  - Warns about rooms no arrow leads to, and asks before leaving with unsaved changes.
- **API**: `GET/POST /api/tours` and `GET/PUT/DELETE /api/tours/<id>`. Tours are saved
  as `.astra3d-data/tours/<id>.json`; panoramas stay in the projects folder. Input is
  validated: sizes, ids, angles, and arrows to missing rooms.
- Links to House Tour in the site menu and on the studio start screen.

### New files

| File | What it is |
|------|------------|
| `src/components/scan/scan-photo-capture.tsx` | Full-screen photo camera for 3D scans |
| `src/lib/photo-scan-guide.ts` | Photo tips, coverage, turn and blur checks |
| `src/components/house-tour/house-tour-library.tsx` | `/tours` page |
| `src/components/house-tour/house-tour-viewer.tsx` | Tour viewer and arrow editor |
| `src/components/house-tour/house-tour-api.ts` | Browser calls to the tours API |
| `src/components/house-tour/house-tour.module.css` | Tour styles |
| `src/lib/house-tour.ts` | Tour rules: validation, arrows, walking direction, click-to-direction maths |
| `src/server/house-tour-store.ts` | Saves and loads tours on disk |
| `src/types/house-tour.ts` | Tour types |
| `src/app/tours/page.tsx`, `src/app/tours/[tourId]/page.tsx` | Pages |
| `src/app/api/tours/route.ts`, `src/app/api/tours/[tourId]/route.ts` | API routes |
| `scripts/test_photo_scan.py` | Python tests for photo unpacking |
| `src/test/photo-scan-guide.test.ts` | Tests for photo tips |
| `src/test/house-tour.test.ts` | Tests for tour rules |
| `src/test/tours-api.test.ts` | Tests for the tours API |
| `tests/e2e/house-tour.spec.ts` | Browser tests: create a tour, walk, place arrows |

---

## Changed

| File | Change |
|------|--------|
| `src/components/scan/scan-studio.tsx` | `/scan` now has two cards, **Photos** (Take photos for 3D, Upload photos) and **Video** (Film the room, Upload a video). Tips rewritten for both. "Take photos for 3D" is the main button; "Film the room" is now a secondary button. |
| `src/components/scan/scan-api.ts` | Added `preparePhoto()` and `packPhotos()`; accepts ZIP uploads. The stage label "Picking sharp frames" is now "Preparing frames" (fits photos too). |
| `src/components/scan/scan-view.tsx` | Shows "Photos placed" for photo scans. |
| `src/components/scan/scan.module.css` | Styles for the photo camera and mode cards. |
| `src/types/scan.ts` | `ScanJob` gets `source` (`"video"` or `"photos"`) and `photos`; `video` is now optional (only set for video scans). Old scans without `source` are treated as videos. |
| `src/server/scan-store.ts` | Accepts photo ZIPs, counts the photos, and records them on the job. Error text says "upload" instead of "video" where it applies to both. |
| `src/app/api/scans/route.ts` | Comments and error messages mention photos. |
| `scripts/splat_pipeline.py` | Photo support (see above). Video processing works the same as before. |
| `src/components/room-capture/room-studio.tsx` | The 3D scan link says "Take photos or film a video"; new House tour link. |
| `src/components/site-header.tsx` | New "House Tour" menu item. |
| `src/test/scans-api.test.ts` | New photo upload test; checks `source: "video"`. |
| `tests/e2e/scan.spec.ts` | New browser test for taking photos for 3D. |
| `README.md` | Documents photo scans and house tours. |

---

## Removed

Nothing was removed. All earlier features (photo 360 studio, video 3D scans, demo store
tour, tests pages) work as before.

Small renames:

- `MIN_VIDEO_BYTES` → `MIN_UPLOAD_BYTES` in `scan-store.ts`, now used for both videos and photo ZIPs.
- "The video is larger than…" → "The upload is larger than…".

---

## How to check it

```bash
npm install
npm run verify          # lint, types, unit tests, build, browser tests
python scripts/test_photo_scan.py
python scripts/test_splat_format.py
```

Then try both features on a real phone (camera, motion sensors, tapping and swiping).

## Known limits

- Photo 3D scans need an NVIDIA GPU worker for a sharp result; without one you get the preview.
- House tour arrows are placed by hand; they are not worked out from the phone's compass.
- Not yet run end to end on a real phone. The unit and API tests passed while building
  this; the full `npm run verify` still needs to be run.
