"use client";

import { MapPin } from "lucide-react";
import { useId } from "react";

import type { FlagshipSceneId, FlagshipTour, TourScene } from "@/types/tour";

import styles from "./tour.module.css";

type FloorPlanProps = {
  currentScene: TourScene;
  tour: FlagshipTour;
  yaw: number;
  onNavigate: (sceneId: FlagshipSceneId) => void;
};

export function FloorPlan({
  currentScene,
  tour,
  yaw,
  onNavigate,
}: FloorPlanProps) {
  const titleId = useId();

  return (
    <section className={styles.floorPlan} aria-labelledby={titleId}>
      <div className={styles.floorPlanHeader}>
        <div>
          <p>Orientation</p>
          <h2 id={titleId}>Floor plan</h2>
        </div>
        <span>{currentScene.sequence} / {tour.scenes.length}</span>
      </div>

      <div className={styles.planDrawing}>
        <svg viewBox="0 0 340 200" aria-hidden="true">
          <path d="M20 70h92v78H20z" />
          <path d="M112 30h118v88H112z" />
          <path d="M230 62h90v96h-90z" />
          <path d="M112 82H96M230 88h16" className={styles.planConnector} />
          <path d="M122 118l-18 24h18M220 118l18 24h-18" className={styles.planDoor} />
        </svg>

        {tour.scenes.map((scene) => {
          const isCurrent = scene.id === currentScene.id;

          return (
            <button
              className={styles.planNode}
              key={scene.id}
              type="button"
              style={{ left: `${scene.mapPosition.x}%`, top: `${scene.mapPosition.y}%` }}
              aria-label={
                isCurrent
                  ? `${scene.label}, current location`
                  : `Jump to ${scene.label}`
              }
              aria-current={isCurrent ? "location" : undefined}
              data-current={isCurrent}
              onClick={() => onNavigate(scene.id)}
            >
              <span>{scene.sequence}</span>
              {isCurrent ? (
                <i style={{ transform: `rotate(${yaw}deg)` }} aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>

      <p className={styles.youAreHere}>
        <MapPin aria-hidden="true" /> You are here: <strong>{currentScene.label}</strong>
      </p>

      <div className={styles.locationList} aria-label="Tour locations">
        {tour.scenes.map((scene) => (
          <button
            type="button"
            key={scene.id}
            data-current={scene.id === currentScene.id}
            aria-current={scene.id === currentScene.id ? "location" : undefined}
            onClick={() => onNavigate(scene.id)}
          >
            <span>{String(scene.sequence).padStart(2, "0")}</span>
            {scene.label}
          </button>
        ))}
      </div>
    </section>
  );
}
