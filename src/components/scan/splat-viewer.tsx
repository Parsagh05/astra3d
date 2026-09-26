"use client";

import { Footprints, Pause, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ScanPathPoint, ScanScene } from "@/types/scan";

import styles from "./scan.module.css";

/** Walking pace of the "walk the capture path" tour, scene units (≈ m) per second. */
const TOUR_SPEED = 0.55;

type ViewerStatus =
  | { state: "loading"; progress: number | null }
  | { state: "ready" }
  | { state: "error"; message: string };

type ViewerApi = { reset: () => void; setTour: (on: boolean) => void };

export type TourSample = { position: [number, number, number]; forward: [number, number, number] };

/**
 * Position and gaze `distance` units along the capture path, linearly
 * interpolated between the recorded camera poses.  Exported for tests.
 */
export function sampleTour(path: ScanPathPoint[], distance: number): TourSample {
  if (path.length === 0) return { position: [0, 0, 0], forward: [0, 0, -1] };
  if (path.length === 1) return { position: path[0].position, forward: path[0].forward };
  const lengths = [0];
  for (let index = 1; index < path.length; index += 1) {
    const [ax, ay, az] = path[index - 1].position;
    const [bx, by, bz] = path[index].position;
    lengths.push(lengths[index - 1] + Math.hypot(bx - ax, by - ay, bz - az));
  }
  const total = lengths[lengths.length - 1];
  if (total <= 0) return { position: path[0].position, forward: path[0].forward };
  // Ping-pong so the tour never jumps from the last pose back to the first.
  const cycle = distance % (2 * total);
  const along = cycle <= total ? cycle : 2 * total - cycle;
  let segment = 1;
  while (segment < lengths.length - 1 && lengths[segment] < along) segment += 1;
  const span = lengths[segment] - lengths[segment - 1];
  const t = span > 0 ? (along - lengths[segment - 1]) / span : 0;
  const mix = (a: number[], b: number[]) => a.map((value, index) => value + (b[index] - value) * t) as [number, number, number];
  const forward = mix(path[segment - 1].forward, path[segment].forward);
  const length = Math.hypot(...forward) || 1;
  return {
    position: mix(path[segment - 1].position, path[segment].position),
    forward: forward.map((value) => value / length) as [number, number, number],
  };
}

/**
 * Renders a scan's Gaussian splat with Spark (WebGL2).  Starts where the
 * video started, looking where the camera looked; drag to look around,
 * WASD / arrow keys (or two-finger drag on touch) to move.
 */
export function SplatViewer({ url, scene, label }: { url: string; scene: ScanScene; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef<ViewerApi | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ state: "loading", progress: null });
  const [touring, setTouring] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      const { SparkControls, SparkRenderer, SplatFileType, SplatMesh } = await import("@sparkjsdev/spark");
      if (disposed) return;

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
      } catch {
        setStatus({ state: "error", message: "This browser cannot display 3D scenes (WebGL 2 is unavailable)." });
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const world = new THREE.Scene();
      world.background = new THREE.Color("#03070f");
      const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 500);
      world.add(camera);
      const spark = new SparkRenderer({ renderer });
      world.add(spark);

      const start = scene.path[0] ?? { position: [0, 0, 0], forward: [0, 0, -1] };
      const place = (sample: TourSample) => {
        camera.position.set(...sample.position);
        camera.up.set(0, 1, 0);
        camera.lookAt(
          sample.position[0] + sample.forward[0],
          sample.position[1] + sample.forward[1],
          sample.position[2] + sample.forward[2],
        );
      };
      place(start);

      const controls = new SparkControls({ canvas });
      // Room-scale movement: the default speed suits large outdoor captures.
      controls.fpsMovement.moveSpeed = 1.2;

      const mesh = new SplatMesh({
        url,
        fileType: SplatFileType.SPLAT,
        onProgress: (event: ProgressEvent) => {
          if (!disposed) setStatus({ state: "loading", progress: event.lengthComputable && event.total ? event.loaded / event.total : null });
        },
      });
      world.add(mesh);

      const resize = () => {
        const { width, height } = container.getBoundingClientRect();
        if (width < 1 || height < 1) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(container);

      let tourDistance = 0;
      let tourOn = false;
      let last = performance.now();
      renderer.setAnimationLoop((time: number) => {
        const delta = Math.min(0.1, (time - last) / 1000);
        last = time;
        if (tourOn) {
          tourDistance += delta * TOUR_SPEED;
          place(sampleTour(scene.path, tourDistance));
        } else {
          controls.update(camera);
        }
        renderer.render(world, camera);
      });

      apiRef.current = {
        reset: () => {
          tourOn = false;
          tourDistance = 0;
          setTouring(false);
          place(start);
        },
        setTour: (on) => {
          tourOn = on;
          if (on) tourDistance = 0;
        },
      };

      cleanup = () => {
        observer.disconnect();
        renderer.setAnimationLoop(null);
        world.remove(mesh);
        mesh.dispose();
        renderer.dispose();
      };

      try {
        await mesh.initialized;
        if (!disposed) setStatus({ state: "ready" });
      } catch {
        if (!disposed) setStatus({ state: "error", message: "The 3D scene could not be loaded." });
      }
    })().catch(() => {
      if (!disposed) setStatus({ state: "error", message: "The 3D viewer could not start in this browser." });
    });

    return () => {
      disposed = true;
      apiRef.current = null;
      cleanup();
    };
  }, [url, scene]);

  const toggleTour = () => {
    const next = !touring;
    setTouring(next);
    apiRef.current?.setTour(next);
  };

  return (
    <div className={styles.viewer} ref={containerRef}>
      <canvas ref={canvasRef} className={styles.viewerCanvas} aria-label={label} role="application" tabIndex={0} />
      {status.state === "loading" ? (
        <div className={styles.viewerOverlay} role="status">
          Loading 3D scene{status.progress !== null ? `… ${Math.round(status.progress * 100)}%` : "…"}
        </div>
      ) : null}
      {status.state === "error" ? <div className={styles.viewerOverlay} role="alert">{status.message}</div> : null}
      <div className={styles.viewerToolbar}>
        <button type="button" onClick={toggleTour} disabled={status.state !== "ready" || scene.path.length < 2} aria-pressed={touring}>
          {touring ? <Pause aria-hidden="true" /> : <Footprints aria-hidden="true" />}
          {touring ? "Stop walking" : "Walk the capture path"}
        </button>
        <button type="button" onClick={() => apiRef.current?.reset()} disabled={status.state !== "ready"}>
          <RotateCcw aria-hidden="true" /> Reset view
        </button>
      </div>
      <p className={styles.viewerHelp}>Drag to look around · WASD or arrow keys to move · pinch or scroll to go forward</p>
    </div>
  );
}
