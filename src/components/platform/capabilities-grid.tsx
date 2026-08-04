import {
  BarChart3,
  MonitorSmartphone,
  MousePointerClick,
  Palette,
  Plug,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";

import { capabilities } from "@/data/platform";
import type { CapabilityIcon } from "@/types/platform";

import styles from "./platform-sections.module.css";

const capabilityIcons: Record<CapabilityIcon, LucideIcon> = {
  hotspots: MousePointerClick,
  commerce: ShoppingBag,
  analytics: BarChart3,
  devices: MonitorSmartphone,
  branding: Palette,
  integrations: Plug,
};

export function CapabilitiesGrid() {
  return (
    <section
      className={`${styles.section} ${styles.capabilitiesSection}`}
      aria-labelledby="capabilities-heading"
    >
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Platform capabilities</p>
          <h2 className={styles.heading} id="capabilities-heading">
            Everything the world needs. Nothing it doesn&apos;t.
          </h2>
        </div>
        <p className={styles.lede}>
          A modular toolkit for creating depth, guiding action, and measuring
          the moments that matter.
        </p>
      </div>

      <ul className={styles.capabilityGrid}>
        {capabilities.map((capability) => {
          const Icon = capabilityIcons[capability.icon];

          return (
            <li
              className={styles.capabilityCard}
              data-layout={capability.layout}
              data-capability={capability.icon}
              key={capability.id}
            >
              <div className={styles.capabilityTopline}>
                <span className={styles.capabilityIcon}>
                  <Icon aria-hidden="true" />
                </span>
                <span className={styles.capabilitySignal}>
                  {capability.signal}
                </span>
              </div>
              <div>
                <p className={styles.detailLabel}>{capability.eyebrow}</p>
                <h3>{capability.title}</h3>
                <p>{capability.description}</p>
              </div>
              <div className={styles.cardTelemetry} aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
