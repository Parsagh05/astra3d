# Astra3D — Interactive Spatial Commerce

Astra3D is an original spatial-capture and commerce application. Its creation studio guides a smartphone user through photographing one room, sends the completed stills through a private local connection to the laptop, builds an optimized 2:1 panorama with a Node/Sharp backend, saves the returned result in the phone browser, and opens it in an interactive 360° viewer. A functional three-room retail flagship demonstrates the later multi-room visitor experience.

The visual identity, environments, products, and copy were created for this project. The flagship is a fictional demonstration rather than a scan of a real store. No media, source code, product screenshots, demo identifiers, or marketing statistics from the reference sites are included.

## Highlights

- A phone-first `/studio/` workflow for naming and scanning one room from a fixed standing point.
- A persistent rear-camera preview on a secure origin, with IMU-guided still capture at eight overlapping targets per sweep. The app never records a video.
- Explicit eye-level, +35°, and −35° passes. Final assembly remains locked until all 24 target photos have been captured.
- Switchable Automatic and Manual capture, preview-matched zoom, detected ultrawide/rear-lens selection, last-angle retake, and a thumbnail map for replacing any completed angle without losing progress. Real hardware zoom reaches 0.6× when the browser exposes it; the software fallback remains 1.0×–1.4×.
- Laptop-side 3072×1536 panorama assembly with validated uploads, bounded memory input, overlap feathering, IndexedDB result persistence, retake support, and JPG download. Stills are processed in server memory and are not sent to a cloud service or retained on disk.
- An interactive generated-room viewer with drag, swipe, keyboard, zoom, reset, fullscreen, and WebGL fallback behavior.
- One focused React Three Fiber scene with capped pixel ratio, mobile quality controls, offscreen pausing, and limited pointer/touch movement.
- Automatic static fallback for reduced motion, reduced data, unavailable WebGL, or a lost WebGL context.
- A functional three-room flagship tour with linked 360° panoramas for Arrival, Collection, and Private Lounge.
- Drag, swipe, arrow-key, zoom, reset, and fullscreen controls, with projected hotspots that stay attached to points in each scene.
- Navigation, product, and editorial hotspots; a clickable floor plan; scene lists; and shareable scene/hotspot URLs.
- Code-built product previews with rotation, zoom, and finish selection. Prices, availability, and the local demo bag are illustrative and never create an order or payment.
- Four original optimized environment renders for retail, real estate, hospitality, and art.
- Keyboard-operable industry tabs and spatial hotspots with live detail updates.
- Import → Customize → Launch workflow, illustrative Control Center, and capability bento grid.
- Responsive floating navigation and an accessible modal with validation, focus trapping, Escape dismissal, focus restoration, and local-only success state.
- Static metadata, canonical URL, Open Graph image, robots, sitemap, and `SoftwareApplication` structured data.
- Vitest component tests plus Playwright browser coverage, including accessibility, responsive layouts, reduced-motion, and WebGL-failure behavior.

## Technology

- Next.js 16 App Router and React 19
- Node.js Route Handlers and Sharp for laptop-side image processing
- TypeScript in strict mode
- React Three Fiber, Drei, and Three.js
- CSS Modules plus global design tokens
- Locally bundled Inter and Space Grotesk variable fonts
- Vitest and Testing Library
- Playwright and axe-core

## Local development

Node.js 22 and npm 10 are recommended. The application has no required environment variables or external cloud services. It must run as a Node.js application because `/api/panorama` performs the image work on the laptop.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

The room creator is available at `http://localhost:3000/studio/`. Its persistent camera preview and motion-sensor guidance require a secure browser context (`https://` or `localhost`). The user follows one on-screen target at a time; when the target is centered and the phone is steady, the app copies one still image from the live camera stream. It does not start or save a video recording. If motion data is unavailable, the same live preview remains open and the user taps one in-app capture button per target.

### Test from an Android phone with the full live scanner

The most reliable local setup is Android Debug Bridge (ADB), including Android's Wireless debugging mode. It maps the phone's `localhost` to the laptop, so the browser allows the live camera without a certificate and the same connection reaches the laptop processor:

```powershell
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
```

In a second PowerShell window, after enabling Android Developer options and Wireless debugging, connect using the current phone address shown by Android:

```powershell
cd C:\platform-tools
.\adb.exe connect PHONE_IP:CONNECT_PORT
.\adb.exe devices
.\adb.exe -s PHONE_IP:CONNECT_PORT reverse tcp:3000 tcp:3000
```

If Android asks for pairing first, choose **Pair device with pairing code** and run `.\adb.exe pair PHONE_IP:PAIR_PORT` before `connect`. On the phone, open `http://localhost:3000/studio/` in Chrome and allow camera and motion access. No cable is required after Wireless debugging is connected. A trusted HTTPS URL also works. An ordinary URL such as `http://192.168.x.x:3000` can display the website, but mobile browsers intentionally block this live scanner on insecure LAN HTTP.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server. |
| `npm run lint` | Run ESLint across application, configuration, and tests. |
| `npm run typecheck` | Run strict TypeScript checking without emitting files. |
| `npm test` | Run the Vitest component suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run build` | Create the production Next.js server build. |
| `npm run start` | Run the production website and processing API on port 3000. |
| `npm run preview` | Run the production build at `http://127.0.0.1:4173` for browser tests. |
| `npm run test:e2e` | Run Playwright against the current production server build. Run `npm run build` first. |
| `npm run test:e2e:ui` | Open Playwright's interactive test runner. |
| `npm run verify` | Run lint, typecheck, unit tests, production build, and browser tests in sequence. |

The Playwright projects use the locally installed Google Chrome channel. Install Chrome before running the browser suite on a new machine.

## Release verification

Run `npm run verify` against every release candidate. It exercises linting, strict type checking, unit tests, the production static export, and browser interaction tests. Accessibility and performance audits are lab measurements and can vary by machine and hosting conditions; do not treat a previous local score as a guarantee for a new build.

## Production deployment

Create and run a fresh Node.js build:

```bash
npm ci
npm run build
npm run start
```

Deploy the application to a Node.js-capable host. A static-only host is no longer sufficient because the panorama route validates and processes incoming room images. For local phone testing, keep the Node process on the laptop and use the ADB reverse connection described above.

The canonical production URL is currently `https://astra3d.com`. If the release will live elsewhere, update `metadataBase` and the canonical value in `src/app/layout.tsx`, plus the URLs in `src/app/robots.ts` and `src/app/sitemap.ts` before building.

## Content and architecture

```text
src/
├── app/                    Pages, processing API, metadata, robots, and sitemap
├── components/
│   ├── demo-request/       Accessible local demo-request experience
│   ├── platform/           Showcase, workflow, dashboard, and capability sections
│   └── tour/               Panorama, hotspot, floor-plan, and product interactions
├── data/
│   ├── flagship-tour.ts    Three-scene tour, hotspots, and demo product catalog
│   └── platform.ts         Typed experience and capability content
├── server/                 Sharp panorama composition used only by the laptop
├── test/                   Vitest component, API, and processor coverage
└── types/
    ├── platform.ts         Marketing experience and lead-request models
    └── tour.ts             Panorama, scene, hotspot, and product models
tests/e2e/                  Playwright interaction and accessibility coverage
public/images/              Optimized environments and Open Graph artwork
```

Edit `src/data/platform.ts` to change industries, hotspots, capabilities, workflow steps, or demonstrative dashboard values. Each `Experience` points to a local image and supplies positioned hotspots as percentages so the showcase remains responsive.

The hero's progressive-rendering decisions live in `src/components/hero-canvas.tsx`; the Three.js scene itself lives in `src/components/hero-scene.tsx` and is lazy-loaded on capable devices.

## Functional flagship tour

The flagship content model lives in `src/data/flagship-tour.ts`. Each scene defines responsive equirectangular panorama sources, a poster fallback, an initial camera view, a floor-plan position, and typed hotspots. Hotspot actions are discriminated as navigation, information, or product interactions. Product entries include local finish options and visibly marked demonstration-commerce metadata.

The tour UI is lazy-loaded from `src/components/tour/`. Its enhanced path maps a panorama to the inside of a WebGL sphere and projects hotspot yaw/pitch coordinates into the current viewport. Visitors can drag or swipe to look around, use keyboard controls, zoom and reset the camera, jump between rooms from the floor plan, open detail panels, inspect code-built products, enter fullscreen where supported, and copy a deep link or iframe snippet. If enhanced rendering is unavailable, the same scene content and interactions remain available over a static poster.

The share controls create a URL for the currently hosted build and, where available, use the browser share or clipboard API. They do not publish the site, provision an embed service, or create a Google Business listing.

## Demonstration boundaries

This repository does not include authentication, a CMS, cloud storage, a no-code tour builder, persistent analytics, inventory synchronization, checkout, payment processing, or a lead-delivery backend. It now includes a local single-viewpoint panorama creator, with these explicit boundaries:

- The capture studio takes 24 individual stills from a persistent live camera stream and uploads them only to the connected Astra3D Node server. Sharp assembles one 360° viewpoint using deterministic crop and overlap feathering, returns the JPEG, and discards the request buffers. It never records a video. Browser device orientation provides angular guidance only; it is not ARCore/ARKit VIO and does not calculate `(x, y, z)` movement. The app does not yet perform feature-matched stitching, depth estimation, NeRF reconstruction, or 3D Gaussian Splatting.
- The user must remain at one fixed point. The generated result supports looking around but is not a walkable geometric model and cannot move between reconstructed camera positions.
- Ultrawide access depends on the phone and browser exposing either a hardware zoom range below 1× or multiple rear `videoinput` devices. When neither is available, Astra3D cannot reproduce a real 0.6× field of view and keeps the honest 1× minimum.
- IndexedDB keeps only the latest generated panorama in the current browser profile. Clearing site data removes it; downloading the JPG is the durable export path.
- The broader Import, Customize, and Launch workflow still describes the proposed multi-room product. Users cannot yet add floor nodes, hotspots, room connections, or publish a generated tour.
- Control Center metrics, journey paths, engagement totals, and inventory rows are illustrative demo data. No visitor behavior is collected or stored.
- Product prices and availability are fictional. Finish selection and the demo bag exist only in local React state and do not reserve stock, create a cart, place an order, or charge a payment method.
- The demo-request form validates in the browser and shows a local confirmation, but it does not transmit or retain contact information.
- Share links and embed snippets work only after the Node application is hosted at the configured canonical origin.
- This release supports desktop, mobile, and tablet browsers. It does not start a WebXR session or provide headset/controller interaction, so it is not advertised as a VR experience.
- Retail is the only fully walkable multi-room tour in this release. Real-estate, hospitality, and art sections are labeled interactive concept previews.

## Demo-request behavior

The request form intentionally has no backend. A valid submission changes only local React state, and the confirmation explicitly says that no details were transmitted. To connect lead delivery later, send a validated `LeadRequest` to an approved endpoint inside the form submit handler, then replace the preview disclosure with the appropriate privacy and consent language.

## Generated environment assets

The four showcase environments were generated as original visual assets for this repository and then resized to 1600×900 WebP files:

- `public/images/experience-retail.webp`
- `public/images/experience-real-estate.webp`
- `public/images/experience-hospitality.webp`
- `public/images/experience-art.webp`

The prompt direction specified premium 16:9 architectural visualizations in midnight navy, ice white, electric cyan, and restrained warm gold; clean composition zones for code-native hotspots; and no people, text, logos, trademarks, watermarks, UI, or collage layouts. The Open Graph image is a deterministic 1200×630 crop derived from the original retail render.

The interactive flagship uses three original equirectangular demonstration scenes, each exported in 2048×1024 desktop and 1280×640 mobile variants plus a 960×540 poster fallback under `public/images/tours/flagship/`. They depict the same fictional boutique across Arrival, Collection, and Private Lounge; they are not photographs or scans of an existing property.

All logos, icons, charts, dashboard chrome, and interface treatments are code-native.
