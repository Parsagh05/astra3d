"use client";

import dynamic from "next/dynamic";
import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Vector3 } from "three";

import { GUIDANCE_HINT_TEXT } from "@/lib/guided-capture";

import { captureViewLayout, directionForView, projectDirection, type ViewQuaternion } from "./device-pose";
import styles from "./room-capture.module.css";
import type { CaptureEngineState } from "./use-guided-capture";

const CaptureSphereScene = dynamic(
  () => import("./capture-sphere-scene").then((module) => module.CaptureSphereScene),
  { loading: () => null, ssr: false },
);

/** A captured still, placed on the sphere by its measured or planned pose. */
export type SphereShot = {
  key: string | number;
  url?: string;
  view?: ViewQuaternion;
  yaw: number;
  pitch: number;
};

const RETICLE_RADIUS = 27;
const DOT_RADIUS = 13;

class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Live capture view shared by the studio and the test maker.
 *
 * A fixed white ring marks where the camera points.  The orange dot is the
 * next target, anchored in the room: turn toward it, and once it sits inside
 * the ring the ring fills while you hold still, then the photo is taken.
 * With motion sensors and WebGL the view zooms out into a photo-sphere that
 * shows every captured still where it belongs; otherwise the camera fills
 * the frame and the same ring and dot guide the sweep.
 */
export function CaptureSphereView({
  videoRef,
  videoLabel,
  zoom = 1,
  engineRef,
  sphere,
  guiding,
  reticle,
  shots,
  targetLabel,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoLabel: string;
  zoom?: number;
  engineRef: RefObject<CaptureEngineState>;
  sphere: boolean;
  guiding: boolean;
  reticle: boolean;
  shots: readonly SphereShot[];
  targetLabel?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reticleRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [webgl] = useState(webglAvailable);
  const [sceneFailed, setSceneFailed] = useState(false);
  const sphereActive = sphere && webgl && !sceneFailed && size.width > 0;
  const layout = captureViewLayout(size.width, size.height, sphereActive);
  const layoutRef = useRef(layout);

  useLayoutEffect(() => {
    layoutRef.current = layout;
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      setSize((current) =>
        Math.abs(current.width - bounds.width) < 0.5 && Math.abs(current.height - bounds.height) < 0.5
          ? current
          : { width: bounds.width, height: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (!guiding && !reticle) return;
    const direction = new Vector3();
    let lastHint: string | null = null;
    let frame = 0;
    const paint = () => {
      frame = window.requestAnimationFrame(paint);
      const engine = engineRef.current;
      const { width, height, focal } = layoutRef.current;
      const ring = reticleRef.current;
      if (ring) {
        const hold = `${Math.round(engine.holdProgress * 360)}deg`;
        if (ring.style.getPropertyValue("--hold") !== hold) ring.style.setProperty("--hold", hold);
        ring.dataset.aligned = String(guiding && engine.aligned);
      }
      const dot = dotRef.current;
      const arrow = arrowRef.current;
      if (!guiding || !dot || !arrow) return;

      const hint = engine.hint ? GUIDANCE_HINT_TEXT[engine.hint] : "Find the orange dot";
      if (hint !== lastHint && hintRef.current) {
        hintRef.current.textContent = hint;
        lastHint = hint;
      }
      if (!engine.target || !engine.pose || width < 2 || height < 2) {
        dot.dataset.visible = "false";
        arrow.dataset.visible = "false";
        return;
      }

      directionForView(engine.target.yaw, engine.target.pitch, direction);
      const point = projectDirection(direction, engine.pose, focal, width, height);
      dot.dataset.visible = "true";
      dot.dataset.aligned = String(engine.aligned);
      dot.dataset.offscreen = String(!point.onScreen);
      dot.style.transform = `translate3d(${point.x - DOT_RADIUS}px, ${point.y - DOT_RADIUS}px, 0)`;

      const dx = point.x - width / 2;
      const dy = point.y - height / 2;
      const start = RETICLE_RADIUS + 6;
      const length = Math.hypot(dx, dy) - DOT_RADIUS - 8 - start;
      if (engine.aligned || length < 14) {
        arrow.dataset.visible = "false";
        return;
      }
      arrow.dataset.visible = "true";
      arrow.style.width = `${length}px`;
      arrow.style.transform =
        `translate3d(${width / 2}px, ${height / 2}px, 0) rotate(${Math.atan2(dy, dx)}rad) translateX(${start}px)`;
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [engineRef, guiding, reticle]);

  return (
    <div ref={rootRef} className={styles.sphereStage} data-sphere={sphereActive}>
      {sphereActive ? (
        <SceneBoundary onError={() => setSceneFailed(true)}>
          <CaptureSphereScene engineRef={engineRef} fov={layout.fov} shots={shots} />
        </SceneBoundary>
      ) : null}
      <div
        className={styles.liveWindow}
        style={sphereActive ? { width: layout.windowWidth, height: layout.windowHeight } : undefined}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label={videoLabel}
          style={{ "--capture-zoom": zoom } as CSSProperties}
        />
      </div>
      {reticle ? <div ref={reticleRef} className={styles.reticle} aria-hidden="true" /> : null}
      {guiding ? (
        <>
          <div ref={arrowRef} className={styles.guideArrow} data-visible="false" aria-hidden="true" />
          <div ref={dotRef} className={styles.guideDot} data-visible="false" aria-hidden="true" />
          <div className={styles.autoCaptureState} data-status="scanning">
            <span>{targetLabel}</span>
            <strong ref={hintRef} aria-live="polite">Find the orange dot</strong>
          </div>
        </>
      ) : null}
    </div>
  );
}
