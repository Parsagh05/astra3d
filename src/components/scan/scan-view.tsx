"use client";

import { ArrowLeft, CircleAlert, Download, FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import studio from "@/components/room-capture/room-capture.module.css";
import type { ScanJob, ScanScene } from "@/types/scan";

import { fetchScan, fetchScene, formatBytes, formatCount, retryScan, scanFileUrl, STAGE_LABELS } from "./scan-api";
import styles from "./scan.module.css";

// WebGL and Spark's WASM only exist in the browser.
const SplatViewer = dynamic(() => import("./splat-viewer").then((module) => module.SplatViewer), {
  ssr: false,
  loading: () => <div className={styles.viewer}><div className={styles.viewerOverlay} role="status">Loading 3D viewer…</div></div>,
});

const POLL_MS = 2500;

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; scan: ScanJob; scene: ScanScene | null };

export function ScanView({ scanId }: { scanId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const scan = await fetchScan(scanId, signal);
      if (!scan) {
        setLoaded({ state: "missing" });
        return;
      }
      if (scan.status !== "done") {
        setLoaded((current) => ({ state: "ready", scan, scene: current.state === "ready" ? current.scene : null }));
        return;
      }
      const scene = await fetchScene(scanId, signal);
      setLoaded({ state: "ready", scan, scene });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setLoaded({ state: "error", message: error instanceof Error ? error.message : "The scan could not be loaded." });
    }
  }, [scanId]);

  useEffect(() => {
    const controller = new AbortController();
    const request = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(request);
      controller.abort();
    };
  }, [load]);

  const scan = loaded.state === "ready" ? loaded.scan : null;
  const processing = scan?.status === "queued" || scan?.status === "running";
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [processing, load]);

  const retry = async () => {
    setRetrying(true);
    setActionError(null);
    try {
      const queued = await retryScan(scanId);
      setLoaded({ state: "ready", scan: queued, scene: null });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The scan could not be queued again.");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`${studio.studioShell} ${styles.viewShell}`}>
      <header className={studio.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span aria-hidden="true" /> 3D scan</div>
        <Link href="/scan" className={studio.backLink}><ArrowLeft aria-hidden="true" /> All scans</Link>
      </header>

      <main className={`${studio.studioMain} ${styles.viewMain}`}>
        {loaded.state === "loading" ? <p className={styles.empty}>Loading…</p> : null}
        {loaded.state === "missing" ? (
          <div className={styles.emptyState}>
            <CircleAlert aria-hidden="true" />
            <h1>Scan not found</h1>
            <p>It may have been deleted. <Link href="/scan">Back to your scans</Link></p>
          </div>
        ) : null}
        {loaded.state === "error" ? <p className={studio.errorMessage} role="alert">{loaded.message}</p> : null}

        {scan ? (
          <>
            <div className={styles.viewHeader}>
              <div>
                <p className={studio.kicker}>
                  {scan.result?.kind === "trained" ? <><Sparkles aria-hidden="true" /> Photoreal scene</> : "3D scan"}
                </p>
                <h1>{scan.name}</h1>
              </div>
              {scan.status === "done" && scan.result ? (
                <dl className={styles.stats}>
                  <div><dt>Splats</dt><dd>{formatCount(scan.result.gaussians)}</dd></div>
                  <div><dt>Frames placed</dt><dd>{scan.result.placed}/{scan.result.frames}</dd></div>
                  <div><dt>Scene</dt><dd>{formatBytes(scan.result.sceneBytes)}</dd></div>
                </dl>
              ) : null}
            </div>

            {processing ? (
              <div className={styles.processingCard} role="status">
                <Loader2 aria-hidden="true" className={styles.spin} />
                <h2>{STAGE_LABELS[scan.stage]}</h2>
                <p>{scan.message}</p>
                <progress max={1} value={scan.progress} aria-label="Processing progress" />
                <small>
                  {Math.round(scan.progress * 100)}%
                  {scan.worker ? ` · ${scan.worker.trainer === "nerfstudio" ? "GPU training" : "preview"} on ${scan.worker.host}` : ""}
                </small>
                <p className={styles.processingNote}>
                  You can close this page; processing continues on the server
                  {scan.worker?.trainer === "nerfstudio" ? " (GPU training takes about 15–40 minutes)." : "."}
                </p>
              </div>
            ) : null}

            {scan.status === "failed" ? (
              <div className={styles.failedCard} role="alert">
                <CircleAlert aria-hidden="true" />
                <h2>Processing failed</h2>
                <p>{scan.error}</p>
                <div className={styles.actions}>
                  <button type="button" className={studio.primaryButton} onClick={() => void retry()} disabled={retrying}>
                    <RefreshCw aria-hidden="true" /> Try again
                  </button>
                  <a className={studio.secondaryButton} href={scanFileUrl(scan.id, "pipeline.log")} target="_blank" rel="noreferrer">
                    <FileText aria-hidden="true" /> Processing log
                  </a>
                </div>
              </div>
            ) : null}

            {scan.status === "done" && loaded.state === "ready" && loaded.scene ? (
              <>
                {loaded.scene.kind === "preview" ? (
                  <div className={styles.previewBanner}>
                    <p>
                      <strong>Preview.</strong> Built from the reconstructed points without a GPU, so it shows the room’s
                      layout, not photoreal detail. Run the GPU worker (docker-compose.gpu.yml) and re-process for the full scene.
                    </p>
                    <button type="button" onClick={() => void retry()} disabled={retrying}>
                      <RefreshCw aria-hidden="true" /> Re-process
                    </button>
                  </div>
                ) : null}
                <SplatViewer url={scanFileUrl(scan.id, "scene.splat", scan.updatedAt)} scene={loaded.scene} label={`3D scene of ${scan.name}`} />
                <div className={styles.downloads}>
                  <a href={scanFileUrl(scan.id, "scene.splat")} download><Download aria-hidden="true" /> scene.splat</a>
                  {loaded.scene.kind === "trained" ? (
                    <a href={scanFileUrl(scan.id, "scene.ply")} download><Download aria-hidden="true" /> scene.ply (full quality)</a>
                  ) : null}
                </div>
              </>
            ) : null}
            {actionError ? <p className={studio.errorMessage} role="alert">{actionError}</p> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
