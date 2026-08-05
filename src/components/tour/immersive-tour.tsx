"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Compass,
  HelpCircle,
  Info,
  Layers3,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  Minus,
  Package,
  Plus,
  RotateCcw,
  Share2,
  ShoppingBag,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { BrandMark } from "@/components/brand-mark";
import { flagshipTour } from "@/data/flagship-tour";
import type {
  FlagshipProductId,
  FlagshipSceneId,
  TourHotspot,
  TourScene,
} from "@/types/tour";

import { FloorPlan } from "./floor-plan";
import { PanoramaCanvas } from "./panorama-canvas";
import { ProductViewer } from "./product-viewer";
import {
  clampPanoramaView,
  projectHotspot,
  type PanoramaView,
} from "./tour-math";
import styles from "./tour.module.css";

type ImmersiveTourProps = {
  initialSceneId: string;
  initialHotspotId?: string;
  onClose: () => void;
};

type TourOverlay = "help" | "map" | "share" | null;

type CopyFallback = {
  type: "link" | "embed";
  value: string;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startView: PanoramaView;
};

type PinchState = {
  distance: number;
  startFov: number;
};

const tour = flagshipTour;

function toPanoramaView(scene: TourScene): PanoramaView {
  return {
    yaw: scene.initialView.yaw,
    pitch: scene.initialView.pitch,
    fov: scene.initialView.fieldOfView,
  };
}

function isFlagshipSceneId(value: string): value is FlagshipSceneId {
  return tour.scenes.some((scene) => scene.id === value);
}

export function ImmersiveTour({
  initialSceneId,
  initialHotspotId,
  onClose,
}: ImmersiveTourProps) {
  const dialogTitleId = useId();
  const viewportInstructionsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRailRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hotspotOriginRef = useRef<HTMLButtonElement | null>(null);
  const hotspotOriginIdRef = useRef<string | null>(null);
  const hotspotOriginKindRef = useRef<string | null>(null);
  const overlayOriginRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pointerPositionsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState | null>(null);
  const closeTopLayerRef = useRef<() => boolean>(() => false);
  const previousInfoIdRef = useRef<string | null>(null);
  const previousProductIdRef = useRef<FlagshipProductId | null>(null);
  const previousOverlayRef = useRef<TourOverlay>(null);
  const previousShowTipsRef = useRef(false);
  const initialScene = useMemo(
    () =>
      tour.scenes.find(
        (scene) =>
          isFlagshipSceneId(initialSceneId) && scene.id === initialSceneId,
      ) ?? tour.scenes[0],
    [initialSceneId],
  );
  const [sceneId, setSceneId] = useState<FlagshipSceneId>(initialScene.id);
  const [view, setView] = useState<PanoramaView>(() =>
    toPanoramaView(initialScene),
  );
  const [activeInfoId, setActiveInfoId] = useState<string | null>(null);
  const [activeProductId, setActiveProductId] =
    useState<FlagshipProductId | null>(null);
  const [overlay, setOverlay] = useState<TourOverlay>(null);
  const [showTips, setShowTips] = useState(() => {
    try {
      return window.localStorage.getItem("astra3d-tour-tips") !== "seen";
    } catch {
      return true;
    }
  });
  const [panoramaReady, setPanoramaReady] = useState(false);
  const [panoramaFallback, setPanoramaFallback] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [railBounds, setRailBounds] = useState<DOMRect | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [toast, setToast] = useState("");
  const [shareComplete, setShareComplete] = useState<"link" | "embed" | null>(
    null,
  );
  const [copyFallback, setCopyFallback] = useState<CopyFallback | null>(null);
  const compact = useMediaQuery("(max-width: 760px)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const scene =
    tour.scenes.find((candidate) => candidate.id === sceneId) ?? tour.scenes[0];
  const panoramaSource = compact
    ? scene.panorama.mobile.src
    : scene.panorama.desktop.src;
  const activeInfo =
    scene.hotspots.find(
      (hotspot) =>
        hotspot.id === activeInfoId && hotspot.action.type === "info",
    ) ?? null;
  const activeProduct =
    tour.products.find((product) => product.id === activeProductId) ?? null;

  const restoreHotspotFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (hotspotOriginRef.current?.isConnected) {
        hotspotOriginRef.current.focus();
        return;
      }

      const hotspotId = hotspotOriginIdRef.current;
      const candidates = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "[data-hotspot-id]",
        ) ?? [],
      ).filter((button) => button.dataset.hotspotId === hotspotId);
      const replacement =
        candidates.find(
          (button) =>
            button.dataset.hotspotOrigin === hotspotOriginKindRef.current,
        ) ?? candidates[0];

      (replacement ?? viewportRef.current)?.focus();
    });
  }, []);

  const closeInfo = useCallback(() => {
    setActiveInfoId(null);
    restoreHotspotFocus();
  }, [restoreHotspotFocus]);

  const closeProduct = useCallback(() => {
    setActiveProductId(null);
    restoreHotspotFocus();
  }, [restoreHotspotFocus]);

  const dismissTips = useCallback(() => {
    setShowTips(false);
    try {
      window.localStorage.setItem("astra3d-tour-tips", "seen");
    } catch {
      // The tour remains usable when storage is unavailable.
    }
    window.requestAnimationFrame(() => {
      if (panoramaFallback) {
        dialogRef.current
          ?.querySelector<HTMLButtonElement>("[data-hotspot-id]")
          ?.focus();
      } else {
        viewportRef.current?.focus();
      }
    });
  }, [panoramaFallback]);

  const closeOverlay = useCallback((restoreFocus = true) => {
    setOverlay(null);

    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        (overlayOriginRef.current?.isConnected
          ? overlayOriginRef.current
          : viewportRef.current
        )?.focus();
      });
    }
  }, []);

  const toggleOverlay = (
    nextOverlay: Exclude<TourOverlay, null>,
    origin: HTMLButtonElement,
  ) => {
    if (overlay === nextOverlay) {
      closeOverlay();
      return;
    }

    overlayOriginRef.current = origin;
    setOverlay(nextOverlay);
  };

  const closeTopLayer = useCallback(() => {
    if (overlay) {
      closeOverlay();
      return true;
    }

    if (activeProductId) {
      closeProduct();
      return true;
    }

    if (activeInfoId) {
      closeInfo();
      return true;
    }

    if (showTips) {
      dismissTips();
      return true;
    }

    return false;
  }, [
    activeInfoId,
    activeProductId,
    closeInfo,
    closeOverlay,
    closeProduct,
    dismissTips,
    overlay,
    showTips,
  ]);

  useEffect(() => {
    closeTopLayerRef.current = closeTopLayer;
  }, [closeTopLayer]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const pageFrame = document.querySelector<HTMLElement>(".site-frame");
    const previousAriaHidden = pageFrame
      ? pageFrame.getAttribute("aria-hidden")
      : null;
    document.body.style.overflow = "hidden";

    if (pageFrame) {
      pageFrame.inert = true;
      pageFrame.setAttribute("aria-hidden", "true");
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = dialogRef.current?.querySelector<HTMLElement>(
        "[data-tour-autofocus]",
      );
      (initialFocus ?? viewportRef.current)?.focus();
    });

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();

        if (!closeTopLayerRef.current()) {
          onClose();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusScopes = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          '[data-focus-scope="active"]',
        ) ?? [],
      );
      const focusScope = focusScopes.at(-1) ?? dialogRef.current;
      const focusable = Array.from(
        focusScope?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDocumentKeyDown);
      document.body.style.overflow = previousOverflow;

      if (pageFrame) {
        pageFrame.inert = false;
        if (previousAriaHidden === null) {
          pageFrame.removeAttribute("aria-hidden");
        } else {
          pageFrame.setAttribute("aria-hidden", previousAriaHidden);
        }
      }

      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const element = viewportRef.current;
    const rail = sceneRailRef.current;
    if (!element || !rail) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
      const railRect = rail.getBoundingClientRect();
      setRailBounds(
        new DOMRect(
          railRect.left - rect.left,
          railRect.top - rect.top,
          railRect.width,
          railRect.height,
        ),
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === dialogRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!initialHotspotId) return;

    const hotspot = scene.hotspots.find(
      (candidate) => candidate.id === initialHotspotId,
    );

    const frame = window.requestAnimationFrame(() => {
      if (hotspot?.action.type === "info") {
        setActiveInfoId(hotspot.id);
      } else if (hotspot?.action.type === "product") {
        setActiveProductId(hotspot.action.productId);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [initialHotspotId, scene.hotspots]);

  useEffect(() => {
    let selector: string | null = null;

    if (overlay && overlay !== previousOverlayRef.current) {
      selector = "[data-overlay-autofocus]";
    } else if (
      activeProductId &&
      activeProductId !== previousProductIdRef.current &&
      !overlay
    ) {
      selector = "[data-panel-autofocus]";
    } else if (
      activeInfoId &&
      activeInfoId !== previousInfoIdRef.current &&
      !overlay
    ) {
      selector = "[data-panel-autofocus]";
    } else if (showTips && !previousShowTipsRef.current && !overlay) {
      selector = "[data-tour-autofocus]";
    }

    previousInfoIdRef.current = activeInfoId;
    previousProductIdRef.current = activeProductId;
    previousOverlayRef.current = overlay;
    previousShowTipsRef.current = showTips;

    if (!selector) return;

    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(selector)?.focus();
    });

    return () => window.cancelAnimationFrame(focusFrame);
  }, [activeInfoId, activeProductId, overlay, showTips]);

  useEffect(() => {
    if (compact || panoramaFallback) return;

    const nextScene = tour.scenes.find((candidate) =>
      scene.hotspots.some(
        (hotspot) =>
          hotspot.action.type === "navigate" &&
          hotspot.action.targetSceneId === candidate.id,
      ),
    );

    if (!nextScene) return;
    const image = new Image();
    image.src = nextScene.panorama.desktop.src;
  }, [compact, panoramaFallback, scene.hotspots]);

  useEffect(() => {
    if (!panoramaFallback || document.activeElement !== viewportRef.current) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLButtonElement>("[data-hotspot-id]")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(focusFrame);
  }, [panoramaFallback, scene.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const navigateTo = (nextSceneId: FlagshipSceneId) => {
    const nextScene = tour.scenes.find(
      (candidate) => candidate.id === nextSceneId,
    );

    if (!nextScene || nextScene.id === scene.id) return;

    setSceneId(nextScene.id);
    setView(toPanoramaView(nextScene));
    setActiveInfoId(null);
    setActiveProductId(null);
    setOverlay(null);
    setShareComplete(null);
    setCopyFallback(null);
    setPanoramaReady(false);
    setPanoramaFallback(false);
    setAnnouncement(
      `${nextScene.label}, scene ${nextScene.sequence} of ${tour.scenes.length}`,
    );

    window.requestAnimationFrame(() => viewportRef.current?.focus());
  };

  const activateHotspot = (
    hotspot: TourHotspot,
    origin?: HTMLButtonElement | null,
  ) => {
    hotspotOriginRef.current = origin ?? null;
    hotspotOriginIdRef.current = hotspot.id;
    hotspotOriginKindRef.current = origin?.dataset.hotspotOrigin ?? null;

    if (hotspot.action.type === "navigate") {
      navigateTo(hotspot.action.targetSceneId);
    } else if (hotspot.action.type === "product") {
      setActiveInfoId(null);
      setActiveProductId(hotspot.action.productId);
    } else {
      setActiveProductId(null);
      setActiveInfoId(hotspot.id);
    }
  };

  const updateView = (nextView: PanoramaView) => {
    setView(clampPanoramaView(nextView));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input")) return;

    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerPositionsRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointerPositionsRef.current.size === 1) {
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startView: view,
      };
      setIsDragging(true);
    } else if (pointerPositionsRef.current.size === 2) {
      const [first, second] = Array.from(pointerPositionsRef.current.values());
      pinchRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        startFov: view.fov,
      };
      dragRef.current = null;
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerPositionsRef.current.has(event.pointerId)) return;

    pointerPositionsRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointerPositionsRef.current.size >= 2 && pinchRef.current) {
      const [first, second] = Array.from(pointerPositionsRef.current.values());
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      updateView({
        ...view,
        fov: pinchRef.current.startFov -
          (distance - pinchRef.current.distance) * 0.055,
      });
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    updateView({
      ...view,
      yaw: drag.startView.yaw + (event.clientX - drag.startX) * 0.105,
      pitch: drag.startView.pitch - (event.clientY - drag.startY) * 0.09,
    });
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerPositionsRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }

    if (pointerPositionsRef.current.size < 2) pinchRef.current = null;
    if (pointerPositionsRef.current.size === 0) setIsDragging(false);
  };

  const handleViewportKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 16 : 7;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateView({ ...view, yaw: view.yaw - step });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updateView({ ...view, yaw: view.yaw + step });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      updateView({ ...view, pitch: view.pitch + step * 0.65 });
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      updateView({ ...view, pitch: view.pitch - step * 0.65 });
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      updateView({ ...view, fov: view.fov - 5 });
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      updateView({ ...view, fov: view.fov + 5 });
    } else if (event.key === "Home") {
      event.preventDefault();
      updateView(toPanoramaView(scene));
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    updateView({ ...view, fov: view.fov + event.deltaY * 0.028 });
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (dialogRef.current?.requestFullscreen) {
        await dialogRef.current.requestFullscreen();
      } else {
        setToast("This tour already fills the available browser window.");
      }
    } catch {
      setToast("Full-screen mode is unavailable in this browser.");
    }
  };

  const buildShareUrl = () => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.set("tour", "flagship");
    url.searchParams.set("room", scene.id);

    if (activeInfoId) {
      url.searchParams.set("point", activeInfoId);
    } else if (activeProductId) {
      const productPoint = scene.hotspots.find(
        (hotspot) =>
          hotspot.action.type === "product" &&
          hotspot.action.productId === activeProductId,
      );
      if (productPoint) url.searchParams.set("point", productPoint.id);
    } else {
      url.searchParams.delete("point");
    }

    return url.toString();
  };

  const copyText = async (value: string, type: "link" | "embed") => {
    try {
      await navigator.clipboard.writeText(value);
      setShareComplete(type);
      setCopyFallback(null);
      setAnnouncement(type === "link" ? "Tour link copied" : "Embed code copied");
    } catch {
      setCopyFallback({ type, value });
      setToast("Clipboard access is unavailable. A manual copy field is ready.");
    }
  };

  const shareTour = async () => {
    const url = buildShareUrl();

    if (navigator.share) {
      try {
        await navigator.share({
          title: `${tour.title} — ${scene.label}`,
          text: "Explore this interactive Astra3D demonstration.",
          url,
        });
        setAnnouncement("Tour share menu opened");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }

    await copyText(url, "link");
  };

  const projectedHotspots = scene.hotspots.map((hotspot) => {
    const projection = projectHotspot(
      hotspot,
      view,
      viewportSize.width,
      viewportSize.height,
    );
    const obscuredByRail = Boolean(
      railBounds &&
        projection.x >= railBounds.left &&
        projection.x <= railBounds.right &&
        projection.y >= railBounds.top &&
        projection.y <= railBounds.bottom,
    );

    return {
      hotspot,
      projection: {
        ...projection,
        visible: projection.visible && !obscuredByRail,
      },
    };
  });

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        className={styles.tourDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        data-reduced-motion={reducedMotion}
        data-scene-id={scene.id}
        data-active-product={activeProduct?.id ?? undefined}
        data-show-tips={showTips}
      >
        <header className={styles.tourHeader}>
          <div className={styles.tourBrand}>
            <BrandMark />
            <div>
              <p>{tour.eyebrow}</p>
              <h1 id={dialogTitleId}>{tour.title}</h1>
            </div>
          </div>

          <div className={styles.sceneIdentity}>
            <span>{String(scene.sequence).padStart(2, "0")}</span>
            <div>
              <small>Now exploring</small>
              <strong>{scene.label}</strong>
            </div>
          </div>

          <nav
            className={styles.tourActions}
            aria-label="Tour controls"
            inert={showTips ? true : undefined}
          >
            <button
              type="button"
              onClick={(event) => toggleOverlay("map", event.currentTarget)}
              aria-pressed={overlay === "map"}
              aria-label="Open floor plan"
            >
              <MapIcon aria-hidden="true" /> <span>Map</span>
            </button>
            <button
              type="button"
              onClick={(event) => toggleOverlay("help", event.currentTarget)}
              aria-pressed={overlay === "help"}
              aria-label="Open tour help"
            >
              <HelpCircle aria-hidden="true" /> <span>Help</span>
            </button>
            <button
              type="button"
              onClick={(event) => toggleOverlay("share", event.currentTarget)}
              aria-pressed={overlay === "share"}
              aria-label="Share tour"
            >
              <Share2 aria-hidden="true" /> <span>Share</span>
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-pressed={isFullscreen}
              aria-label={isFullscreen ? "Exit full screen" : "View full screen"}
            >
              {isFullscreen ? (
                <Minimize2 aria-hidden="true" />
              ) : (
                <Maximize2 aria-hidden="true" />
              )}
              <span>{isFullscreen ? "Exit" : "Full screen"}</span>
            </button>
            <button
              className={styles.closeTour}
              type="button"
              onClick={onClose}
              aria-label="Exit tour"
            >
              <X aria-hidden="true" />
            </button>
          </nav>
        </header>

        <main className={styles.tourMain}>
          <div
            ref={viewportRef}
            className={styles.viewport}
            role="group"
            tabIndex={panoramaFallback ? -1 : 0}
            aria-label={
              panoramaFallback
                ? `Static room view: ${scene.label}`
                : `Interactive 360 tour: ${scene.label}`
            }
            aria-describedby={viewportInstructionsId}
            data-dragging={isDragging}
            data-fallback={panoramaFallback}
            data-panorama-ready={panoramaReady}
            data-view-yaw={view.yaw.toFixed(2)}
            data-view-pitch={view.pitch.toFixed(2)}
            data-view-fov={view.fov.toFixed(2)}
            onKeyDown={panoramaFallback ? undefined : handleViewportKeyDown}
            onPointerDown={panoramaFallback ? undefined : handlePointerDown}
            onPointerMove={panoramaFallback ? undefined : handlePointerMove}
            onPointerUp={panoramaFallback ? undefined : handlePointerEnd}
            onPointerCancel={panoramaFallback ? undefined : handlePointerEnd}
            onWheel={panoramaFallback ? undefined : handleWheel}
          >
            <PanoramaCanvas
              active={!showTips}
              fov={view.fov}
              pitch={view.pitch}
              yaw={view.yaw}
              src={panoramaSource}
              posterSrc={scene.panorama.poster.src}
              posterAlt={scene.panorama.alt}
              onFailure={() => setPanoramaFallback(true)}
              onFallbackChange={setPanoramaFallback}
              onReady={() => setPanoramaReady(true)}
            />
            <div className={styles.viewportShade} aria-hidden="true" />

            {!panoramaFallback
              ? projectedHotspots.map(({ hotspot, projection }, index) =>
                  projection.visible ? (
                    <button
                      className={styles.spatialHotspot}
                      key={hotspot.id}
                      type="button"
                      style={
                        {
                          "--hotspot-x": `${projection.x}px`,
                          "--hotspot-y": `${projection.y}px`,
                          "--hotspot-depth": projection.depth,
                        } as CSSProperties
                      }
                      data-type={hotspot.action.type}
                      data-hotspot-id={hotspot.id}
                      data-hotspot-origin="spatial"
                      aria-label={hotspot.ariaLabel}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => activateHotspot(hotspot, event.currentTarget)}
                    >
                      <span>{hotspot.action.type === "navigate" ? <ChevronRight aria-hidden="true" /> : index + 1}</span>
                      <small>{hotspot.label}</small>
                    </button>
                  ) : null,
                )
              : null}

            {!panoramaReady && !panoramaFallback ? (
              <div className={styles.loadingState} role="status">
                <span aria-hidden="true" /> Preparing {scene.label}
              </div>
            ) : null}

            {panoramaFallback ? (
              <div className={styles.fallbackNotice} role="status">
                <Layers3 aria-hidden="true" />
                <div>
                  <strong>Static browsing mode</strong>
                  <span>
                    The interactive view is unavailable, but every room and item remains accessible.
                  </span>
                </div>
              </div>
            ) : null}

            {showTips ? (
              <>
                <div className={styles.tipsScrim} aria-hidden="true" />
                <section
                  className={styles.tourTips}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="tour-tips-title"
                  data-focus-scope="active"
                >
                  <p>Welcome inside</p>
                  <h2 id="tour-tips-title">
                    {panoramaFallback
                      ? "Browse every room and point."
                      : "Look around. Move deeper. Discover more."}
                  </h2>
                  <div>
                    <span>
                      <Compass aria-hidden="true" />
                      {panoramaFallback
                        ? "Use the room list or floor plan"
                        : "Drag, swipe, or use arrow keys"}
                    </span>
                    <span><ChevronRight aria-hidden="true" /> Choose arrows to change rooms</span>
                    <span><ShoppingBag aria-hidden="true" /> Open numbered product points</span>
                  </div>
                  <button
                    type="button"
                    data-tour-autofocus
                    onClick={dismissTips}
                  >
                    {panoramaFallback ? "Start browsing" : "Start exploring"}
                    <ChevronRight aria-hidden="true" />
                  </button>
                </section>
              </>
            ) : null}

            <div className={styles.viewportMeta}>
              <span>
                <i aria-hidden="true" />
                {panoramaFallback ? "Static view" : "360° live"} · {scene.label}
              </span>
              <span>Desktop · Mobile · Tablet</span>
            </div>

            {!panoramaFallback ? (
            <div
              className={styles.lookControls}
              role="group"
              aria-label="Look and zoom controls"
            >
              <button
                type="button"
                aria-label="Look left"
                onClick={() => updateView({ ...view, yaw: view.yaw - 8 })}
              >
                <ArrowLeft aria-hidden="true" />
              </button>
              <div>
                <button
                  type="button"
                  aria-label="Look up"
                  onClick={() => updateView({ ...view, pitch: view.pitch + 6 })}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Reset view"
                  onClick={() => updateView(toPanoramaView(scene))}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Look down"
                  onClick={() => updateView({ ...view, pitch: view.pitch - 6 })}
                >
                  <ArrowDown aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                aria-label="Look right"
                onClick={() => updateView({ ...view, yaw: view.yaw + 8 })}
              >
                <ArrowRight aria-hidden="true" />
              </button>
              <span />
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => updateView({ ...view, fov: view.fov + 5 })}
              >
                <Minus aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => updateView({ ...view, fov: view.fov - 5 })}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            ) : null}

            <p id={viewportInstructionsId} className={styles.srOnly}>
              {panoramaFallback
                ? "This is a static room poster. Use the points list or floor plan to open every item and move between rooms."
                : "Drag or swipe to look around. With this view focused, use arrow keys to look, plus and minus to zoom, and Home to reset. Tab to reach spatial points and tour controls."}
            </p>
          </div>

          <aside
            ref={sceneRailRef}
            className={styles.sceneRail}
            aria-label="Current room and interactive points"
          >
            {activeProduct ? (
              <ProductViewer
                product={activeProduct}
                enhancedAvailable={!panoramaFallback}
                onClose={closeProduct}
              />
            ) : activeInfo && activeInfo.action.type === "info" ? (
              <section className={styles.infoPanel} aria-labelledby="tour-info-title">
                <div className={styles.panelTopline}>
                  <span>{activeInfo.action.eyebrow}</span>
                  <button
                    type="button"
                    data-panel-autofocus
                    onClick={closeInfo}
                    aria-label="Close information"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.infoIcon}><Info aria-hidden="true" /></div>
                <h2 id="tour-info-title">{activeInfo.action.title}</h2>
                <p>{activeInfo.action.description}</p>
                {activeInfo.action.facts ? (
                  <dl>
                    {activeInfo.action.facts.map((fact) => (
                      <div key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </section>
            ) : (
              <SceneOverview
                scene={scene}
                panoramaFallback={panoramaFallback}
                onActivate={activateHotspot}
                onOpenMap={(origin) => toggleOverlay("map", origin)}
              />
            )}
          </aside>

          <div className={styles.desktopMap} inert={showTips ? true : undefined}>
            <FloorPlan
              currentScene={scene}
              tour={tour}
              yaw={view.yaw}
              onNavigate={navigateTo}
            />
          </div>

          {overlay ? (
            <OverlayPanel
              overlay={overlay}
              scene={scene}
              view={view}
              shareComplete={shareComplete}
              copyFallback={copyFallback}
              onClose={() => closeOverlay()}
              onCopyEmbed={() => {
                const url = buildShareUrl();
                void copyText(
                  `<iframe src="${url}" title="Astra Atelier interactive tour" allow="fullscreen"></iframe>`,
                  "embed",
                );
              }}
              onCopyLink={() => void copyText(buildShareUrl(), "link")}
              onNavigate={navigateTo}
              onShare={() => void shareTour()}
            />
          ) : null}
        </main>

        {toast ? <div className={styles.toast} role="status">{toast}</div> : null}
        <p className={styles.srOnly} role="status" aria-live="polite">
          {announcement}
        </p>
      </div>
    </div>
  );
}

function SceneOverview({
  scene,
  panoramaFallback,
  onActivate,
  onOpenMap,
}: {
  scene: TourScene;
  panoramaFallback: boolean;
  onActivate: (hotspot: TourHotspot, origin?: HTMLButtonElement | null) => void;
  onOpenMap: (origin: HTMLButtonElement) => void;
}) {
  return (
    <section className={styles.sceneOverview}>
      <p>Scene {String(scene.sequence).padStart(2, "0")}</p>
      <h2>{scene.title}</h2>
      <p>{scene.description}</p>
      <div className={styles.sceneFacts}>
        <span>
          <Compass aria-hidden="true" />
          {panoramaFallback ? "Static room poster" : "360° panorama"}
        </span>
        <span><Package aria-hidden="true" /> {scene.hotspots.length} points</span>
      </div>
      <div className={styles.pointList}>
        <div>
          <strong>Points in this space</strong>
          <span>{scene.hotspots.length}</span>
        </div>
        {scene.hotspots.map((hotspot, index) => (
          <button
            key={hotspot.id}
            type="button"
            data-hotspot-id={hotspot.id}
            data-hotspot-origin="rail"
            onClick={(event) => onActivate(hotspot, event.currentTarget)}
          >
            <span data-type={hotspot.action.type}>
              {hotspot.action.type === "navigate" ? (
                <ChevronRight aria-hidden="true" />
              ) : hotspot.action.type === "product" ? (
                <ShoppingBag aria-hidden="true" />
              ) : (
                <Info aria-hidden="true" />
              )}
            </span>
            <span>
              <strong>{hotspot.label}</strong>
              <small>
                {hotspot.action.type === "navigate"
                  ? "Move to another scene"
                  : hotspot.action.type === "product"
                    ? "View product in 3D"
                    : "Open story point"}
              </small>
            </span>
            <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
          </button>
        ))}
      </div>
      <button
        className={styles.openMapButton}
        type="button"
        onClick={(event) => onOpenMap(event.currentTarget)}
      >
        <MapIcon aria-hidden="true" /> Open floor plan
      </button>
    </section>
  );
}

function OverlayPanel({
  overlay,
  copyFallback,
  scene,
  shareComplete,
  view,
  onClose,
  onCopyEmbed,
  onCopyLink,
  onNavigate,
  onShare,
}: {
  overlay: Exclude<TourOverlay, null>;
  copyFallback: CopyFallback | null;
  scene: TourScene;
  shareComplete: "link" | "embed" | null;
  view: PanoramaView;
  onClose: () => void;
  onCopyEmbed: () => void;
  onCopyLink: () => void;
  onNavigate: (sceneId: FlagshipSceneId) => void;
  onShare: () => void;
}) {
  const overlayTitleId = useId();

  return (
    <div className={styles.overlayScrim} onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className={styles.overlayPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={overlayTitleId}
        data-focus-scope="active"
      >
        <h2 id={overlayTitleId} className={styles.srOnly}>
          {overlay === "map"
            ? "Tour floor plan"
            : overlay === "help"
              ? "Tour help"
              : "Share tour"}
        </h2>
        <div className={styles.panelTopline}>
          <span>Tour controls</span>
          <button
            type="button"
            data-overlay-autofocus
            onClick={onClose}
            aria-label={`Close ${overlay}`}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        {overlay === "map" ? (
          <FloorPlan
            currentScene={scene}
            tour={tour}
            yaw={view.yaw}
            onNavigate={(sceneId) => {
              onNavigate(sceneId);
            }}
          />
        ) : null}

        {overlay === "help" ? (
          <div className={styles.helpPanel}>
            <p>Tour help</p>
            <h2>Explore at your own pace.</h2>
            <div>
              <article>
                <Compass aria-hidden="true" />
                <h3>Look around</h3>
                <p>Drag or swipe the space. With the view focused, arrow keys look in every direction.</p>
              </article>
              <article>
                <ChevronRight aria-hidden="true" />
                <h3>Move through rooms</h3>
                <p>Choose directional points, the room list, or any location on the floor plan.</p>
              </article>
              <article>
                <ShoppingBag aria-hidden="true" />
                <h3>Discover products</h3>
                <p>Numbered points open stories and interactive demonstration products.</p>
              </article>
            </div>
            <dl>
              <div><dt>Zoom</dt><dd>Wheel, pinch, plus or minus</dd></div>
              <div><dt>Reset</dt><dd>Home key or reset control</dd></div>
              <div><dt>Close layer</dt><dd>Escape</dd></div>
            </dl>
          </div>
        ) : null}

        {overlay === "share" ? (
          <div className={styles.sharePanel}>
            <p>Share this exact room</p>
            <h2>Send the experience anywhere.</h2>
            <p>
              The generated link reopens {scene.label}. The embed is ready for a site that permits iframe content.
            </p>
            <button type="button" onClick={onShare}>
              <Share2 aria-hidden="true" /> Share tour
            </button>
            <button type="button" onClick={onCopyLink}>
              {shareComplete === "link" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
              {shareComplete === "link" ? "Tour link copied" : "Copy tour link"}
            </button>
            <button type="button" onClick={onCopyEmbed}>
              {shareComplete === "embed" ? <Check aria-hidden="true" /> : <Code2 aria-hidden="true" />}
              {shareComplete === "embed" ? "Embed code copied" : "Copy embed code"}
            </button>
            {copyFallback ? (
              <label className={styles.manualCopy}>
                <span>
                  Copy the {copyFallback.type === "link" ? "tour link" : "embed code"} manually
                </span>
                <textarea
                  readOnly
                  rows={copyFallback.type === "embed" ? 4 : 2}
                  value={copyFallback.value}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ) : null}
            <small>Sharing uses only the public URL and current scene. No visitor data is transmitted by this demo.</small>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}
