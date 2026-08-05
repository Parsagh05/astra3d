"use client";

import dynamic from "next/dynamic";
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

const HeroScene = dynamic(
  () => import("./hero-scene").then((module) => module.HeroScene),
  {
    loading: () => null,
    ssr: false,
  },
);

type ErrorBoundaryProps = {
  children: ReactNode;
  onError: () => void;
};

type ErrorBoundaryState = {
  failed: boolean;
};

class WebGLErrorBoundary extends Component<
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

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean;
  };
};

let cachedWebGLSupport: boolean | undefined;

const emptySubscribe = () => () => undefined;
const getServerSnapshot = () => false;

function getWebGLSupport() {
  if (cachedWebGLSupport !== undefined) {
    return cachedWebGLSupport;
  }

  try {
    const canvas = document.createElement("canvas");
    cachedWebGLSupport = Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl2", { powerPreference: "low-power" }) ||
          canvas.getContext("webgl", { powerPreference: "low-power" })),
    );
  } catch {
    cachedWebGLSupport = false;
  }

  return cachedWebGLSupport;
}

function useWebGLSupport(enabled: boolean) {
  const getSnapshot = useCallback(
    () => (enabled ? getWebGLSupport() : false),
    [enabled],
  );

  return useSyncExternalStore(
    emptySubscribe,
    getSnapshot,
    getServerSnapshot,
  );
}

function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mediaQuery = window.matchMedia(query);
      mediaQuery.addEventListener("change", onStoreChange);

      return () => mediaQuery.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribeToDocumentVisibility(onStoreChange: () => void) {
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

function getDocumentVisibility() {
  return document.visibilityState !== "hidden";
}

function useDocumentVisibility() {
  return useSyncExternalStore(
    subscribeToDocumentVisibility,
    getDocumentVisibility,
    getServerSnapshot,
  );
}

function subscribeToTourState(onStoreChange: () => void) {
  window.addEventListener("astra3d:tour-state", onStoreChange);
  return () => window.removeEventListener("astra3d:tour-state", onStoreChange);
}

function getTourInactive() {
  return document.body.dataset.tourOpen !== "true";
}

function useTourInactive() {
  return useSyncExternalStore(
    subscribeToTourState,
    getTourInactive,
    getServerSnapshot,
  );
}

function useViewportActivity(target: RefObject<HTMLDivElement | null>) {
  const [isVisible, setIsVisible] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    const element = target.current;

    if (!element) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      const frame = window.requestAnimationFrame(() => {
        setIsVisible(true);
        setHasEntered(true);
      });

      return () => window.cancelAnimationFrame(frame);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nextVisibility = entry.isIntersecting;
        setIsVisible(nextVisibility);

        if (nextVisibility) {
          setHasEntered(true);
        }
      },
      {
        rootMargin: "180px 0px",
        threshold: 0.05,
      },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);

  return { hasEntered, isVisible };
}

function useDeferredEnhancement(
  target: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    const element = target.current;

    if (!enabled || !element) {
      return;
    }

    const requestEnhancement = () => setRequested(true);
    const delay = window.setTimeout(requestEnhancement, 10_000);

    element.addEventListener("pointerenter", requestEnhancement, {
      once: true,
    });
    element.addEventListener("pointerdown", requestEnhancement, {
      once: true,
    });
    element.addEventListener("touchstart", requestEnhancement, {
      once: true,
      passive: true,
    });

    return () => {
      window.clearTimeout(delay);
      element.removeEventListener("pointerenter", requestEnhancement);
      element.removeEventListener("pointerdown", requestEnhancement);
      element.removeEventListener("touchstart", requestEnhancement);
    };
  }, [enabled, target]);

  return enabled && requested;
}

export function HeroCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const prefersReducedMotion = useMediaQuery(
    "(prefers-reduced-motion: reduce)",
  );
  const prefersReducedData = useMediaQuery("(prefers-reduced-data: reduce)");
  const isCompact = useMediaQuery("(max-width: 720px)");
  const documentIsVisible = useDocumentVisibility();
  const tourIsInactive = useTourInactive();
  const { hasEntered, isVisible } = useViewportActivity(containerRef);
  const savesData =
    typeof navigator !== "undefined" &&
    (navigator as NavigatorWithConnection).connection?.saveData === true;
  const enhancementRequested = useDeferredEnhancement(
    containerRef,
    !prefersReducedMotion && !prefersReducedData && !savesData,
  );
  const supportsWebGL = useWebGLSupport(enhancementRequested);
  const canRender =
    enhancementRequested &&
    supportsWebGL &&
    !prefersReducedMotion &&
    !prefersReducedData &&
    !savesData &&
    !failed;

  const handleFailure = useCallback(() => {
    setFailed(true);
    setReady(false);
  }, []);

  const handleReady = useCallback(() => setReady(true), []);

  return (
    <div
      ref={containerRef}
      className="hero-portal__canvas"
      data-ready={canRender && ready ? "true" : "false"}
      aria-hidden="true"
    >
      {canRender && hasEntered ? (
        <WebGLErrorBoundary onError={handleFailure}>
          <HeroScene
            active={isVisible && documentIsVisible && tourIsInactive}
            compact={isCompact}
            onFailure={handleFailure}
            onReady={handleReady}
          />
        </WebGLErrorBoundary>
      ) : null}
    </div>
  );
}
