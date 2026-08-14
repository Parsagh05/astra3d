import { Check, Cloud, Images, RefreshCw } from "lucide-react";

import type { SharedRoomProject } from "@/types/capture";

import styles from "./room-capture.module.css";

type SharedProjectLibraryProps = {
  projects: readonly SharedRoomProject[];
  loading: boolean;
  openingId: string | null;
  onOpen: (project: SharedRoomProject) => void;
  onRefresh: () => void;
};

export function SharedProjectLibrary({
  projects,
  loading,
  openingId,
  onOpen,
  onRefresh,
}: SharedProjectLibraryProps) {
  return (
    <section className={styles.sharedLibrary} aria-labelledby="shared-projects-title">
      <div className={styles.sharedLibraryHeader}>
        <div>
          <p className={styles.kicker}><Cloud aria-hidden="true" /> Shared through this laptop</p>
          <h2 id="shared-projects-title">Phone and laptop projects</h2>
          <p>New phone scans are saved on this laptop with their source photographs and appear here on both devices.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw aria-hidden="true" /> Refresh
        </button>
      </div>

      {loading ? <p className={styles.libraryStatus}>Loading the laptop library…</p> : null}
      {!loading && projects.length === 0 ? (
        <div className={styles.emptyLibrary}>
          <Images aria-hidden="true" />
          <div><strong>No shared projects yet</strong><span>Your next completed phone scan will appear here automatically.</span></div>
        </div>
      ) : null}
      {projects.length > 0 ? (
        <div className={styles.projectGrid}>
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              onClick={() => onOpen(project)}
              disabled={openingId !== null}
            >
              <span className={styles.projectGlyph}><Images aria-hidden="true" /></span>
              <span>
                <strong>{project.name}</strong>
                <small>{new Date(project.createdAt).toLocaleString()}</small>
                <em>
                  <Check aria-hidden="true" /> {project.hasSourceFrames ? `${project.photoCount} source photos saved` : "Panorama only · migrated"}
                </em>
              </span>
              <b>{openingId === project.id ? "Opening…" : "Open 360°"}</b>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
