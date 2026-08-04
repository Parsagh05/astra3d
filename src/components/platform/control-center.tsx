import {
  Activity,
  BarChart3,
  Box,
  ChevronDown,
  CircleGauge,
  Eye,
  LayoutDashboard,
} from "lucide-react";

import {
  dashboardMetrics,
  inventoryItems,
  trafficSeries,
} from "@/data/platform";

import styles from "./platform-sections.module.css";

const chartPoints = trafficSeries.map((point, index) => ({
  ...point,
  x: (index / (trafficSeries.length - 1)) * 600,
  y: 126 - point.value * 1.05,
}));

const linePath = chartPoints
  .map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
  )
  .join(" ");

const areaPath = `${linePath} L 600 136 L 0 136 Z`;

export function ControlCenter() {
  return (
    <section
      className={`${styles.section} ${styles.controlSection}`}
      id="platform"
      aria-labelledby="control-heading"
    >
      <div className={styles.controlIntro}>
        <div>
          <p className={styles.eyebrow}>One spatial platform</p>
          <h2 className={styles.heading} id="control-heading">
            The signal behind every scene.
          </h2>
        </div>
        <p className={styles.lede}>
          Manage live experiences, inventory, and visitor behavior from one
          calm control layer—without losing sight of the world you built.
        </p>
      </div>

      <div className={styles.dashboardFrame}>
        <aside
          className={styles.dashboardSidebar}
          aria-label="Control Center demo navigation"
        >
          <div className={styles.miniBrand} aria-label="Astra3D">
            <span aria-hidden="true" />
            ASTRA<span>3D</span>
          </div>
          <nav aria-label="Dashboard areas">
            <span data-active="true">
              <LayoutDashboard aria-hidden="true" /> Overview
            </span>
            <span>
              <Box aria-hidden="true" /> Experiences
            </span>
            <span>
              <BarChart3 aria-hidden="true" /> Analytics
            </span>
            <span>
              <CircleGauge aria-hidden="true" /> Inventory
            </span>
          </nav>
          <div className={styles.sidebarSignal}>
            <Activity aria-hidden="true" />
            <span>
              System status
              <strong>All scenes live</strong>
            </span>
          </div>
        </aside>

        <div className={styles.dashboardMain}>
          <div className={styles.dashboardBar}>
            <div>
              <span className={styles.detailLabel}>Control Center</span>
              <strong>Retail / Flagship 01</strong>
            </div>
            <div className={styles.demoBadge}>
              <span aria-hidden="true" /> Demo data
            </div>
            <span className={styles.profileChip} aria-hidden="true">
              A3 <ChevronDown />
            </span>
          </div>

          <div className={styles.dashboardContent}>
            <div className={styles.metrics} aria-label="Demo performance metrics">
              {dashboardMetrics.map((metric) => (
                <div className={styles.metricCard} key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                  <small data-direction={metric.direction}>
                    {metric.change}
                  </small>
                </div>
              ))}
            </div>

            <div className={styles.dashboardGrid}>
              <article className={styles.chartCard}>
                <div className={styles.cardHeading}>
                  <div>
                    <span className={styles.detailLabel}>Visitor activity</span>
                    <h3>Attention over time</h3>
                  </div>
                  <span>Last 7 days</span>
                </div>
                <svg
                  className={styles.activityChart}
                  viewBox="0 0 600 140"
                  role="img"
                  aria-labelledby="activity-chart-title activity-chart-description"
                  preserveAspectRatio="none"
                >
                  <title id="activity-chart-title">
                    Demo visitor activity over seven days
                  </title>
                  <desc id="activity-chart-description">
                    Activity rises from 42 on Monday to a high of 82 on
                    Saturday, ending at 76 on Sunday.
                  </desc>
                  {[24, 58, 92, 126].map((y) => (
                    <line
                      className={styles.chartGridline}
                      x1="0"
                      x2="600"
                      y1={y}
                      y2={y}
                      key={y}
                    />
                  ))}
                  <path className={styles.chartArea} d={areaPath} />
                  <path className={styles.chartLine} d={linePath} />
                  {chartPoints.map((point) => (
                    <circle
                      className={styles.chartPoint}
                      cx={point.x}
                      cy={point.y}
                      r="4"
                      key={point.label}
                    />
                  ))}
                </svg>
                <div className={styles.chartLabels} aria-hidden="true">
                  {trafficSeries.map((point) => (
                    <span key={point.label}>{point.label}</span>
                  ))}
                </div>
              </article>

              <article className={styles.inventoryCard}>
                <div className={styles.cardHeading}>
                  <div>
                    <span className={styles.detailLabel}>Scene inventory</span>
                    <h3>Most explored</h3>
                  </div>
                  <Eye aria-hidden="true" />
                </div>
                <ul>
                  {inventoryItems.map((item, index) => (
                    <li key={item.name}>
                      <span className={styles.itemIndex} aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.category}</small>
                      </span>
                      <span className={styles.itemEngagement}>
                        {item.engagements}
                        <small>opens</small>
                      </span>
                      <span className={styles.itemStatus} data-status={item.status}>
                        {item.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          </div>
        </div>
      </div>
      <p className={styles.demoNote}>
        Interface and values are illustrative demo data, shown to preview the
        Astra3D management experience.
      </p>
    </section>
  );
}
