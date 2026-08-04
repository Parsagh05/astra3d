# Astra3D — Immersive Spatial Commerce

Astra3D is an original, experience-first marketing application for a fictional spatial-commerce platform. It combines a progressively enhanced WebGL hero, interactive industry environments, an accessible demo-request flow, and a code-built product dashboard in a statically exportable Next.js application.

The visual identity and copy were created for this project. No media, source code, product screenshots, demo identifiers, or marketing statistics from the reference sites are included.

## Highlights

- One focused React Three Fiber scene with capped pixel ratio, mobile quality controls, offscreen pausing, and limited pointer/touch movement.
- Automatic static fallback for reduced motion, reduced data, unavailable WebGL, or a lost WebGL context.
- Four original optimized environment renders for retail, real estate, hospitality, and art.
- Keyboard-operable industry tabs and spatial hotspots with live detail updates.
- Import → Customize → Launch workflow, demonstrative Control Center, and capability bento grid.
- Responsive floating navigation and an accessible modal with validation, focus trapping, Escape dismissal, focus restoration, and local-only success state.
- Static metadata, canonical URL, Open Graph image, robots, sitemap, and `SoftwareApplication` structured data.
- Vitest component tests plus Playwright coverage at 1440×900 and 390×844, including axe, reduced-motion, and forced-WebGL-failure checks.

## Technology

- Next.js 16 App Router and React 19
- TypeScript in strict mode
- React Three Fiber, Drei, and Three.js
- CSS Modules plus global design tokens
- Locally bundled Inter and Space Grotesk variable fonts
- Vitest and Testing Library
- Playwright and axe-core

## Local development

Node.js 22 and npm 10 are recommended. The application has no required environment variables or external services.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server. |
| `npm run lint` | Run ESLint across application, configuration, and tests. |
| `npm run typecheck` | Run strict TypeScript checking without emitting files. |
| `npm test` | Run the Vitest component suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run build` | Create the production static export in `out/`. |
| `npm run preview` | Serve the current `out/` export at `http://127.0.0.1:4173`. |
| `npm run test:e2e` | Run Playwright against the current production export. Run `npm run build` first. |
| `npm run test:e2e:ui` | Open Playwright's interactive test runner. |
| `npm run verify` | Run lint, typecheck, unit tests, production build, and browser tests in sequence. |

The Playwright projects use the locally installed Google Chrome channel. Install Chrome before running the browser suite on a new machine.

## Release verification

The final local production audit on August 5, 2026 completed with:

- 9 Vitest tests across 6 component test files.
- 16 passing Playwright checks across 1440×900 desktop and 390×844 mobile projects, plus 2 intentional project-specific skips.
- No serious or critical axe violations on the landing page or demo dialog.
- Lighthouse scores of 91 Performance, 100 Accessibility, 100 Best Practices, and 100 SEO.
- 0 production or development dependency vulnerabilities reported by `npm audit`.

Lighthouse results are lab measurements from the local static preview and can vary by machine and hosting conditions.

## Static deployment

Create a fresh export:

```bash
npm ci
npm run build
```

Deploy the contents of `out/` to any static host. No Node.js server is required in production. Because the app uses static export, images are emitted without Next.js server-side optimization.

The canonical production URL is currently `https://astra3d.com`. If the release will live elsewhere, update `metadataBase` and the canonical value in `src/app/layout.tsx`, plus the URLs in `src/app/robots.ts` and `src/app/sitemap.ts` before building.

## Content and architecture

```text
src/
├── app/                    Route, global styles, metadata, robots, and sitemap
├── components/
│   ├── demo-request/       Accessible local demo-request experience
│   └── platform/           Showcase, workflow, dashboard, and capability sections
├── data/platform.ts        Typed experience and capability content
├── test/                   Vitest component coverage
└── types/platform.ts       Experience, Hotspot, Capability, and LeadRequest models
tests/e2e/                  Playwright interaction and accessibility coverage
public/images/              Optimized environments and Open Graph artwork
```

Edit `src/data/platform.ts` to change industries, hotspots, capabilities, workflow steps, or demonstrative dashboard values. Each `Experience` points to a local image and supplies positioned hotspots as percentages so the showcase remains responsive.

The hero's progressive-rendering decisions live in `src/components/hero-canvas.tsx`; the Three.js scene itself lives in `src/components/hero-scene.tsx` and is lazy-loaded on capable devices.

## Demo-request behavior

The request form intentionally has no backend. A valid submission changes only local React state, and the confirmation explicitly says that no details were transmitted. To connect lead delivery later, send a validated `LeadRequest` to an approved endpoint inside the form submit handler, then replace the preview disclosure with the appropriate privacy and consent language.

## Generated environment assets

The four showcase environments were generated as original visual assets for this repository and then resized to 1600×900 WebP files:

- `public/images/experience-retail.webp`
- `public/images/experience-real-estate.webp`
- `public/images/experience-hospitality.webp`
- `public/images/experience-art.webp`

The prompt direction specified premium 16:9 architectural visualizations in midnight navy, ice white, electric cyan, and restrained warm gold; clean composition zones for code-native hotspots; and no people, text, logos, trademarks, watermarks, UI, or collage layouts. The Open Graph image is a deterministic 1200×630 crop derived from the original retail render.

All logos, icons, charts, dashboard chrome, and interface treatments are code-native.
