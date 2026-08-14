"use client";

import {
  Download,
  Expand,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { PanoramaCanvas } from "@/components/tour/panorama-canvas";
import { clampPanoramaView } from "@/components/tour/tour-math";
import type { GeneratedRoomRecord } from "@/types/capture";

import styles from "./room-capture.module.css";

type GeneratedRoomViewerProps = {
  room: GeneratedRoomRecord;
  onRetake: () => void;
};

const initialView = { yaw: 0, pitch: 0, fov: 72 };

export function GeneratedRoomViewer({ room, onRetake }: GeneratedRoomViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    yaw: number;
    pitch: number;
  } | null>(null);
  const [panoramaUrl, setPanoramaUrl] = useState<string | null>(null);
  const [view, setView] = useState(initialView);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const alignmentPercent = room.quality ? Math.round(room.quality.alignmentScore * 100) : null;
  const coveragePercent = room.quality ? Math.round(room.quality.coverage * 100) : null;

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

  const updateView = (next: typeof initialView) => {
    setView(clampPanoramaView(next));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      yaw: view.yaw,
      pitch: view.pitch,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateView({
      ...view,
      yaw: drag.yaw - (event.clientX - drag.x) * 0.16,
      pitch: drag.pitch + (event.clientY - drag.y) * 0.12,
    });
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const handleDownload = () => {
    if (!panoramaUrl) return;

    const link = document.createElement("a");
    link.href = panoramaUrl;
    link.download = `${room.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "astra3d-room"}-360.jpg`;
    link.click();
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
        <span className={styles.localBadge}>Private · {room.processor === "laptop" ? "laptop processed" : "on device"}</span>
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
          <span>Swipe to look</span>
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
        <button
          type="button"
          onClick={() => void viewportRef.current?.requestFullscreen?.()}
          aria-label="Open fullscreen"
        >
          <Expand aria-hidden="true" />
        </button>
      </div>

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
