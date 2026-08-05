"use client";

import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const ImmersiveTour = dynamic(
  () => import("./immersive-tour").then((module) => module.ImmersiveTour),
  {
    loading: () => null,
    ssr: false,
  },
);

type OpenTourOptions = {
  sceneId?: string;
  hotspotId?: string;
};

type TourState = Required<Pick<OpenTourOptions, "sceneId">> &
  Pick<OpenTourOptions, "hotspotId">;

type TourContextValue = {
  openTour: (options?: OpenTourOptions) => void;
};

const TourContext = createContext<TourContextValue | null>(null);

const defaultSceneId = "arrival";

export function TourProvider({ children }: { children: ReactNode }) {
  const [tourState, setTourState] = useState<TourState | null>(null);

  const openTour = useCallback((options: OpenTourOptions = {}) => {
    setTourState({
      sceneId: options.sceneId ?? defaultSceneId,
      hotspotId: options.hotspotId,
    });
  }, []);

  const closeTour = useCallback(() => {
    setTourState(null);

    const url = new URL(window.location.href);
    const hadTourState =
      url.searchParams.has("tour") ||
      url.searchParams.has("room") ||
      url.searchParams.has("point");

    if (hadTourState) {
      url.searchParams.delete("tour");
      url.searchParams.delete("room");
      url.searchParams.delete("point");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);

    if (search.get("tour") !== "flagship") return;

    const frame = window.requestAnimationFrame(() => {
      openTour({
        sceneId: search.get("room") ?? defaultSceneId,
        hotspotId: search.get("point") ?? undefined,
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [openTour]);

  useEffect(() => {
    document.body.dataset.tourOpen = tourState ? "true" : "false";
    window.dispatchEvent(new Event("astra3d:tour-state"));

    return () => {
      delete document.body.dataset.tourOpen;
      window.dispatchEvent(new Event("astra3d:tour-state"));
    };
  }, [tourState]);

  const value = useMemo(() => ({ openTour }), [openTour]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {tourState ? (
        <ImmersiveTour
          initialSceneId={tourState.sceneId}
          initialHotspotId={tourState.hotspotId}
          onClose={closeTour}
        />
      ) : null}
    </TourContext.Provider>
  );
}

export function useTour() {
  const context = useContext(TourContext);

  if (!context) {
    throw new Error("useTour must be used inside TourProvider");
  }

  return context;
}
