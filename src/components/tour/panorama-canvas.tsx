"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { PanoramaViewInput } from "./tour-math";
import { PanoramaFallbackCanvas } from "./panorama-fallback-canvas";

const LazyPanoramaScene = dynamic(
  () => import("./panorama-scene").then((module) => module.PanoramaScene),
  { loading: () => null, ssr: false },
);

type NavigatorWithConnection = Navigator & {
  connection?: { saveData?: boolean };
};

type ErrorBoundaryProps = {
  children: ReactNode;
  onError: () => void;
};

type ErrorBoundaryState = { failed: boolean };

class PanoramaErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type PanoramaCanvasProps = PanoramaViewInput & {
  src: string;
  posterSrc: string;
  posterAlt: string;
  active?: boolean;
  className?: string;
  interactiveFallback?: boolean;
  style?: CSSProperties;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onFallbackChange?: (fallback: boolean) => void;
  onFailure?: () => void;
  onReady?: () => void;
  onVisibilityChange?: (visible: boolean) => void;
};

const emptySubscribe = () => () => undefined;
const getServerSnapshot = () => false;
let cachedWebGLSupport: boolean | undefined;

function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const mediaQuery = window.matchMedia(query);
      mediaQuery.addEventListener("change", notify);
      return () => mediaQuery.removeEventListener("change", notify);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getWebGLSupport() {
  if (cachedWebGLSupport !== undefined) {
    return cachedWebGLSupport;
  }

  try {
    const canvas = document.createElement("canvas");
    const context = window.WebGLRenderingContext
      ? canvas.getContext("webgl2", { powerPreference: "low-power" }) ||
        canvas.getContext("webgl", { powerPreference: "low-power" })
      : null;
    cachedWebGLSupport = Boolean(context);
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cachedWebGLSupport = false;
  }

  return cachedWebGLSupport;
}

function useWebGLSupport() {
  return useSyncExternalStore(
    emptySubscribe,
    getWebGLSupport,
    getServerSnapshot,
  );
}

function useViewportVisibility(
  target: React.RefObject<HTMLDivElement | null>,
) {
  const [intersectsViewport, setIntersectsViewport] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(true);

  useEffect(() => {
    const element = target.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIntersectsViewport(entry.isIntersecting),
      { threshold: 0.01 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return intersectsViewport && documentVisible;
}

export function PanoramaCanvas({
  active = true,
  className,
  fieldOfView,
  fov,
  interactiveFallback = false,
  onContextLost,
  onContextRestored,
  onFallbackChange,
  onFailure,
  onReady,
  onVisibilityChange,
  pitch,
  posterAlt,
  posterSrc,
  src,
  style,
  yaw,
}: PanoramaCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const supportsWebGL = useWebGLSupport();
  const reducedData = useMediaQuery("(prefers-reduced-data: reduce)");
  const compact = useMediaQuery("(max-width: 720px)");
  const visible = useViewportVisibility(rootRef);
  const savesData =
    typeof navigator !== "undefined" &&
    (navigator as NavigatorWithConnection).connection?.saveData === true;
  const canRender =
    active &&
    supportsWebGL &&
    !reducedData &&
    !savesData &&
    failedSrc !== src;
  const fallback = active && !canRender;
  const ready = readySrc === src;
  const resolvedFov = fov ?? fieldOfView ?? 75;

  useEffect(() => {
    onVisibilityChange?.(active && visible);
  }, [active, onVisibilityChange, visible]);

  useEffect(() => {
    onFallbackChange?.(fallback);
  }, [fallback, onFallbackChange, src]);

  const handleFailure = useCallback(() => {
    setFailedSrc(src);
    onFailure?.();
  }, [onFailure, src]);

  const handleReady = useCallback(() => {
    setReadySrc(src);
    onReady?.();
  }, [onReady, src]);

  return (
    <div
      ref={rootRef}
      className={className}
      data-panorama-ready={active && ready ? "true" : "false"}
      data-panorama-fallback={fallback ? "true" : "false"}
      style={{ height: "100%", position: "relative", width: "100%", ...style }}
    >
      {fallback && interactiveFallback ? (
        <PanoramaFallbackCanvas
          alt={posterAlt}
          fov={resolvedFov}
          onFailure={handleFailure}
          onReady={handleReady}
          pitch={pitch}
          src={posterSrc}
          yaw={yaw}
        />
      ) : (
        <Image
          alt={posterAlt}
          fill
          priority={false}
          sizes="100vw"
          src={posterSrc}
          style={{ objectFit: "cover", opacity: canRender && ready ? 0 : 1 }}
          unoptimized
        />
      )}
      {canRender ? (
        <div
          aria-hidden="true"
          style={{ inset: 0, position: "absolute" }}
        >
          <PanoramaErrorBoundary key={src} onError={handleFailure}>
            <LazyPanoramaScene
              compact={compact}
              fov={resolvedFov}
              onContextLost={onContextLost}
              onContextRestored={onContextRestored}
              onFailure={handleFailure}
              onReady={handleReady}
              pitch={pitch}
              src={src}
              yaw={yaw}
            />
          </PanoramaErrorBoundary>
        </div>
      ) : null}
    </div>
  );
}
