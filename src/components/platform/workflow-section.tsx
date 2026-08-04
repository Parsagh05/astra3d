import {
  ArrowRight,
  Box,
  Rocket,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import { workflowSteps } from "@/data/platform";
import type { WorkflowStep } from "@/types/platform";

import styles from "./platform-sections.module.css";

const workflowIcons: Record<WorkflowStep["icon"], LucideIcon> = {
  import: Box,
  customize: SlidersHorizontal,
  launch: Rocket,
};

export function WorkflowSection() {
  return (
    <section
      className={`${styles.section} ${styles.workflowSection}`}
      id="workflow"
      aria-labelledby="workflow-heading"
    >
      <div className={styles.centeredHeader}>
        <p className={styles.eyebrow}>From source to spatial</p>
        <h2 className={styles.heading} id="workflow-heading">
          Your world, live in three moves.
        </h2>
        <p className={styles.lede}>
          A focused workflow keeps the technology in the background and the
          experience in your hands.
        </p>
      </div>

      <ol className={styles.workflowList}>
        {workflowSteps.map((step, index) => {
          const Icon = workflowIcons[step.icon];

          return (
            <li className={styles.workflowCard} key={step.id}>
              <div className={styles.workflowTopline}>
                <span className={styles.workflowIcon}>
                  <Icon aria-hidden="true" />
                </span>
                <span className={styles.workflowNumber}>{step.number}</span>
              </div>
              <p className={styles.detailLabel}>{step.label}</p>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
              {index < workflowSteps.length - 1 ? (
                <span className={styles.workflowConnector} aria-hidden="true">
                  <ArrowRight />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
