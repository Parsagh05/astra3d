"use client";

import Image from "next/image";
import {
  ArrowUpRight,
  MonitorSmartphone,
  MousePointer2,
} from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type { Experience } from "@/types/platform";

import styles from "./platform-sections.module.css";

type ExperienceShowcaseProps = {
  experiences: readonly Experience[];
};

export function ExperienceShowcase({
  experiences,
}: ExperienceShowcaseProps) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedExperienceId, setSelectedExperienceId] = useState(
    experiences[0]?.id ?? "",
  );
  const [activeHotspotId, setActiveHotspotId] = useState(
    experiences[0]?.hotspots[0]?.id ?? "",
  );

  const selectedIndex = Math.max(
    0,
    experiences.findIndex(
      (experience) => experience.id === selectedExperienceId,
    ),
  );
  const selectedExperience = experiences[selectedIndex];
  const activeHotspot =
    selectedExperience?.hotspots.find(
      (hotspot) => hotspot.id === activeHotspotId,
    ) ?? selectedExperience?.hotspots[0];

  if (!selectedExperience || !activeHotspot) {
    return null;
  }

  function selectExperience(index: number) {
    const nextExperience = experiences[index];

    if (!nextExperience) return;

    setSelectedExperienceId(nextExperience.id);
    setActiveHotspotId(nextExperience.hotspots[0]?.id ?? "");
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | undefined;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % experiences.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + experiences.length) % experiences.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = experiences.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    selectExperience(nextIndex);
    tabRefs.current[nextIndex]?.focus();
  }

  const experienceStyle = {
    "--experience-accent": selectedExperience.accent,
  } as CSSProperties;

  return (
    <section
      className={`${styles.section} ${styles.experienceSection}`}
      id="experiences"
      aria-labelledby="experience-heading"
    >
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Experience library</p>
          <h2 className={styles.heading} id="experience-heading">
            Choose a world. Make it yours.
          </h2>
        </div>
        <p className={styles.lede}>
          Start with the way your audience already thinks about place, then
          layer in the moments that turn curiosity into action.
        </p>
      </div>

      <div
        className={styles.experienceTabs}
        role="tablist"
        aria-label="Experience industries"
      >
        {experiences.map((experience, index) => {
          const isSelected = index === selectedIndex;

          return (
            <button
              className={styles.experienceTab}
              id={`${baseId}-tab-${experience.id}`}
              key={experience.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => selectExperience(index)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {experience.industry}
            </button>
          );
        })}
      </div>

      <div
        className={styles.experiencePanel}
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${selectedExperience.id}`}
        style={experienceStyle}
      >
        <div className={styles.experienceScene}>
          <Image
            className={styles.experienceImage}
            key={selectedExperience.id}
            src={selectedExperience.image}
            alt={selectedExperience.imageAlt}
            fill
            sizes="(max-width: 780px) 100vw, (max-width: 1180px) 68vw, 820px"
          />
          <div className={styles.sceneShade} aria-hidden="true" />

          <div className={styles.sceneStatus}>
            <span className={styles.liveDot} aria-hidden="true" />
            Interactive preview
          </div>

          {selectedExperience.hotspots.map((hotspot, index) => {
            const isActive = hotspot.id === activeHotspot.id;

            return (
              <button
                className={styles.hotspot}
                key={hotspot.id}
                type="button"
                style={{
                  left: `${hotspot.position.x}%`,
                  top: `${hotspot.position.y}%`,
                }}
                aria-label={`Explore ${hotspot.label}`}
                aria-pressed={isActive}
                onClick={() => setActiveHotspotId(hotspot.id)}
              >
                <span aria-hidden="true">{index + 1}</span>
                <span className={styles.srOnly}>{hotspot.label}</span>
              </button>
            );
          })}

          <div className={styles.sceneCaption}>
            <span>{selectedExperience.industry}</span>
            <span>
              {String(selectedIndex + 1).padStart(2, "0")} /{" "}
              {String(experiences.length).padStart(2, "0")}
            </span>
          </div>
        </div>

        <div className={styles.experienceDetail} aria-live="polite">
          <div>
            <p className={styles.detailLabel}>{activeHotspot.eyebrow}</p>
            <p className={styles.hotspotIndex} aria-hidden="true">
              {String(
                selectedExperience.hotspots.findIndex(
                  (hotspot) => hotspot.id === activeHotspot.id,
                ) + 1,
              ).padStart(2, "0")}
            </p>
          </div>
          <h3>{activeHotspot.title}</h3>
          <p>{activeHotspot.description}</p>

          <div className={styles.detailMeta}>
            <span>
              <MousePointer2 aria-hidden="true" /> {activeHotspot.label}
            </span>
            <span>
              <ArrowUpRight aria-hidden="true" /> Connected action
            </span>
          </div>

          <div
            className={styles.deviceSupport}
            aria-label="Supported devices"
          >
            <MonitorSmartphone aria-hidden="true" />
            {selectedExperience.deviceSupport.map((device) => (
              <span key={device}>{device}</span>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.experienceIntro}>
        <p className={styles.detailLabel}>{selectedExperience.industry}</p>
        <h3>{selectedExperience.title}</h3>
        <p>{selectedExperience.description}</p>
      </div>
    </section>
  );
}
