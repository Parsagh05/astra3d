"use client";

import {
  Compass,
  Download,
  Expand,
  Minus,
  Orbit,
  Plus,
  RotateCcw,
  Share2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { PanoramaCanvas } from "@/components/tour/panorama-canvas";
import { clampPanoramaView, orientationToView, wrapDegrees } from "@/components/tour/tour-math";
import type { GeneratedRoomRecord } from "@/types/capture";

import styles from "./room-capture.module.css";

type GeneratedRoomViewerProps = {
  room: GeneratedRoomRecord;
  onRetake: () => void;
};

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const initialView = { yaw: 0, pitch: 0, fov: 72 };

/** Degrees of auto-rotation per millisecond (~45 seconds per revolution). */
const AUTO_ROTATE_SPEED = 0.008;

const emptySubscribe = () => () => undefined;
const getServerSnapshot = () => false;
const getGyroSupport = () => "DeviceOrientationEvent" in window;
const getReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function GeneratedRoomViewer({ room, onRetake }: GeneratedRoomViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    lastX: number;
    yaw: number;
    pitch: number;
  } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; fov: number } | null>(null);
  const gyroRef = useRef({ yawOffset: 0, hasSample: false });
  const [panoramaUrl, setPanoramaUrl] = useState<string | null>(null);
  const [view, setView] = useState(initialView);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [gyroActive, setGyroActive] = useState(false);
  const [gyroError, setGyroError] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const gyroAvailable = useSyncExternalStore(emptySubscribe, getGyroSupport, getServerSnapshot);
  const reducedMotion = useSyncExternalStore(emptySubscribe, getReducedMotion, getServerSnapshot);
  const alignmentPercent = room.quality ? Math.round(room.quality.alignmentScore * 100) : null;
  const coveragePercent = room.quality ? Math.round(room.quality.coverage * 100) : null;
  const shareLink = room.serverProjectId && typeof window !== "undefined"
    ? `${window.location.origin}/studio/?project=${encodeURIComponent(room.serverProjectId)}`
    : null;

  useEffect(() => {
    let active = true;
    const nextPanoramaUrl = URL.createObjectURL(room.panorama);

    queueMicrotask(() => {
      if (!active) return;
      setPanoramaUrl(nextPanoramaUrl);
      setReady(false);
      setFallback(false);
    });

    return () => {
      active = false;
      URL.revokeObjectURL(nextPanoramaUrl);
    };
  }, [room.panorama]);

  useEffect(() => {
    if (!gyroActive) return;

    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return;
      const look = orientationToView(event.alpha, event.beta, event.gamma);
      setView((current) => {
        const gyro = gyroRef.current;
        if (!gyro.hasSample) {
          gyro.hasSample = true;
          gyro.yawOffset = wrapDegrees(current.yaw - look.yaw);
        }
        return clampPanoramaView({
          yaw: look.yaw + gyro.yawOffset,
          pitch: look.pitch,
          fov: current.fov,
        });
      });
    };

    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => window.removeEventListener("deviceorientation", handleOrientation, true);
  }, [gyroActive]);

  useEffect(() => {
    if (!autoRotate) return;

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsed = now - last;
      last = now;
      setView((current) => clampPanoramaView({ ...current, yaw: current.yaw + elapsed * AUTO_ROTATE_SPEED }));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [autoRotate]);

  const updateView = (next: typeof initialView) => {
    setView(clampPanoramaView(next));
  };

  const toggleGyro = async () => {
    if (gyroActive) {
      setGyroActive(false);
      return;
    }
    setGyroError(null);
    try {
      const orientationConstructor = window.DeviceOrientationEvent as OrientationEventConstructor;
      if (typeof orientationConstructor.requestPermission === "function") {
        const answer = await orientationConstructor.requestPermission();
        if (answer !== "granted") {
          setGyroError("Motion access was blocked. Allow motion sensors in the browser to look around by moving the phone.");
          return;
        }
      }
    } catch {
      setGyroError("Motion access was blocked. Allow motion sensors in the browser to look around by moving the phone.");
      return;
    }
    gyroRef.current = { yawOffset: 0, hasSample: false };
    setAutoRotate(false);
    setGyroActive(true);
  };

  const toggleAutoRotate = () => {
    setAutoRotate((current) => {
      if (!current) setGyroActive(false);
      return !current;
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setAutoRotate(false);
    if (pointersRef.current.size >= 2) {
      const [first, second] = [...pointersRef.current.values()];
      pinchRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        fov: view.fov,
      };
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      yaw: view.yaw,
      pitch: view.pitch,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const tracked = pointersRef.current.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [first, second] = [...pointersRef.current.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      if (distance > 0) {
        updateView({ ...view, fov: pinch.fov * (pinch.distance / distance) });
      }
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (gyroActive) {
      // Horizontal drag re-aims the sensor-driven view; pitch stays on the phone.
      gyroRef.current.yawOffset = wrapDegrees(
        gyroRef.current.yawOffset - (event.clientX - drag.lastX) * 0.16,
      );
      drag.lastX = event.clientX;
      return;
    }
    updateView({
      ...view,
      yaw: drag.yaw - (event.clientX - drag.x) * 0.16,
      pitch: drag.pitch + (event.clientY - drag.y) * 0.12,
    });
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleDownload = () => {
    if (!panoramaUrl) return;

    const link = document.createElement("a");
    link.href = panoramaUrl;
    link.download = `${room.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "astra3d-room"}-360.jpg`;
    link.click();
  };

  const handleShare = async () => {
    if (!shareLink) return;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: `${room.name} · Astra3D 360° room`, url: shareLink });
        return;
      }
      await navigator.clipboard.writeText(shareLink);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2400);
    } catch {
      // Dismissed share sheets and blocked clipboards leave the current state unchanged.
    }
  };

  return (
    <section className={styles.result} aria-labelledby="generated-room-title">
      <div className={styles.resultHeader}>
        <div>
          <p className={styles.kicker}>Privately generated room</p>
          <h1 id="generated-room-title">{room.name}</h1>
          <p>
            Drag or swipe to look around. This 2:1 panorama was assembled {room.processor === "laptop" ? "by your connected laptop" : "on this device"} from {room.photoCount} automatically selected views.
          </p>
        </div>
        <span className={styles.localBadge}>
          {room.serverProjectId ? "Shared on laptop" : "Private"} · {room.hasSourceFrames ? "24 source photos saved" : room.processor === "laptop" ? "laptop processed" : "on device"}
        </span>
      </div>

      <div
        ref={viewportRef}
        className={styles.generatedViewport}
        role="application"
        tabIndex={0}
        aria-label={`Interactive 360 degree view of ${room.name}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onWheel={(event) => {
          event.preventDefault();
          updateView({ ...view, fov: view.fov + event.deltaY * 0.025 });
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") updateView({ ...view, yaw: view.yaw - 8 });
          if (event.key === "ArrowRight") updateView({ ...view, yaw: view.yaw + 8 });
          if (event.key === "ArrowUp") updateView({ ...view, pitch: view.pitch + 6 });
          if (event.key === "ArrowDown") updateView({ ...view, pitch: view.pitch - 6 });
          if (event.key === "+" || event.key === "=") updateView({ ...view, fov: view.fov - 5 });
          if (event.key === "-") updateView({ ...view, fov: view.fov + 5 });
          if (event.key === "Home") updateView(initialView);
        }}
      >
        {panoramaUrl ? (
          <PanoramaCanvas
            active
            fov={view.fov}
            interactiveFallback
            pitch={view.pitch}
            yaw={view.yaw}
            src={panoramaUrl}
            posterSrc={panoramaUrl}
            posterAlt={`Flat panorama preview of ${room.name}`}
            onReady={() => setReady(true)}
            onFallbackChange={setFallback}
          />
        ) : null}
        <div className={styles.viewerShade} aria-hidden="true" />
        {!ready ? <p className={styles.viewerStatus}>{fallback ? "Preparing compatible 360° viewer…" : "Preparing your room…"}</p> : null}
        <div className={styles.viewerLabel}>
          <span><i /> {fallback ? "Compatible 360°" : "WebGL 360°"}</span>
          <span>{gyroActive ? "Move the phone to look" : "Swipe to look · pinch to zoom"}</span>
        </div>
      </div>

      <div className={styles.viewerControls} aria-label="Room viewer controls">
        <button type="button" onClick={() => updateView({ ...view, fov: view.fov + 5 })} aria-label="Zoom out">
          <Minus aria-hidden="true" />
        </button>
        <button type="button" onClick={() => updateView(initialView)} aria-label="Reset view">
          <RotateCcw aria-hidden="true" />
        </button>
        <button type="button" onClick={() => updateView({ ...view, fov: view.fov - 5 })} aria-label="Zoom in">
          <Plus aria-hidden="true" />
        </button>
        {gyroAvailable ? (
          <button
            type="button"
            onClick={() => void toggleGyro()}
            aria-label="Look around by moving the phone"
            aria-pressed={gyroActive}
            data-active={gyroActive}
          >
            <Compass aria-hidden="true" />
          </button>
        ) : null}
        {!reducedMotion ? (
          <button
            type="button"
            onClick={toggleAutoRotate}
            aria-label="Rotate the room automatically"
            aria-pressed={autoRotate}
            data-active={autoRotate}
          >
            <Orbit aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void viewportRef.current?.requestFullscreen?.()}
          aria-label="Open fullscreen"
        >
          <Expand aria-hidden="true" />
        </button>
      </div>

      {gyroError ? <p className={styles.compatibilityNotice} role="status">{gyroError}</p> : null}

      {fallback ? (
        <p className={styles.compatibilityNotice} role="status">
          <strong>Compatibility viewer active.</strong> WebGL is unavailable in this browser session, so Astra3D is using the compatible 360° viewer. Swipe, zoom, and fullscreen still work.
        </p>
      ) : null}

      {room.quality ? (
        <div className={styles.alignmentReport} aria-label="Panorama processing quality">
          <div>
            <strong>Feature-aligned result</strong>
            <span>OpenCV checked every neighboring view before blending.</span>
          </div>
          <dl>
            <div><dt>Matched overlaps</dt><dd>{room.quality.matchedPairs} / 24</dd></div>
            <div><dt>Alignment</dt><dd>{alignmentPercent}%</dd></div>
            <div><dt>Coverage</dt><dd>{coveragePercent}%</dd></div>
          </dl>
          {room.quality.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}

      <div className={styles.resultActions}>
        <button className={styles.primaryButton} type="button" onClick={handleDownload} disabled={!panoramaUrl}>
          <Download aria-hidden="true" /> Download 360 JPG
        </button>
        {shareLink ? (
          <button className={styles.secondaryButton} type="button" onClick={() => void handleShare()} aria-live="polite">
            <Share2 aria-hidden="true" /> {shareCopied ? "Link copied" : "Share room link"}
          </button>
        ) : null}
        <button className={styles.secondaryButton} type="button" onClick={onRetake}>
          Scan another room
        </button>
      </div>

      <div className={styles.qualityNote}>
        <strong>About this single-position result</strong>
        <p>
          OpenCV aligns visual features, corrects exposure, selects graph-cut seams, and multiband blends the overlaps. It is still one standing point—not a 3D model—so keep the phone lens over one center point and avoid moving objects for the cleanest geometry.
        </p>
      </div>
    </section>
  );
}
