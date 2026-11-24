"use client";

import {
  ArrowLeft,
  Box,
  Camera,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Film,
  ImagePlus,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import studio from "@/components/room-capture/room-capture.module.css";
import { MAX_SCAN_PHOTOS, MIN_SCAN_PHOTOS } from "@/lib/photo-scan-guide";
import type { ScanJob } from "@/types/scan";

import {
  deleteScan,
  fetchScans,
  formatBytes,
  formatCount,
  packPhotos,
  preparePhoto,
  retryScan,
  scanFileUrl,
  STAGE_LABELS,
  uploadScan,
  type ScansListing,
  type UploadHandle,
} from "./scan-api";
import { ScanPhotoCapture } from "./scan-photo-capture";
import { ScanRecorder, type RecordedVideo } from "./scan-recorder";
import styles from "./scan.module.css";

const POLL_MS = 3000;

type UploadState =
  | { status: "idle" }
  | { status: "preparing"; text: string }
  | { status: "uploading"; progress: number; name: string }
  | { status: "error"; error: string };

function statusIcon(job: ScanJob) {
  if (job.status === "done") return <CheckCircle2 aria-hidden="true" />;
  if (job.status === "failed") return <CircleAlert aria-hidden="true" />;
  if (job.status === "running") return <Loader2 aria-hidden="true" className={styles.spin} />;
  return <Clock3 aria-hidden="true" />;
}

function jobSummary(job: ScanJob) {
  if (job.status === "done" && job.result) {
    const unit = job.source === "photos" ? "photos" : "frames";
    return `${job.result.kind === "trained" ? "Photoreal" : "Preview"} · ${formatCount(job.result.gaussians)} splats · ${job.result.placed}/${job.result.frames} ${unit}`;
  }
  if (job.status === "failed") return job.error ?? "Processing failed";
  if (job.status === "running") return `${STAGE_LABELS[job.stage]} · ${job.message}`;
  if (job.photos) return `Waiting for a worker · ${job.photos.count} photos`;
  return `Waiting for a worker · ${formatBytes(job.video?.bytes ?? 0)} video`;
}

/**
 * The 3D scan section: take photos while walking around a room (or film /
 * upload a walk-through video), and the server turns them into a Gaussian
 * splat you can walk through.  Separate from the photo studio, which builds
 * 360° panoramas from a fixed spot.
 */
export function ScanStudio() {
  const [listing, setListing] = useState<ScansListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });
  const [recording, setRecording] = useState(false);
  const [takingPhotos, setTakingPhotos] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<UploadHandle | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setListing(await fetchScans(signal));
      setLoadError(null);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : "Scans could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const request = window.setTimeout(() => void refresh(controller.signal), 0);
    return () => {
      window.clearTimeout(request);
      controller.abort();
    };
  }, [refresh]);

  const pending = listing?.scans.some((scan) => scan.status === "queued" || scan.status === "running") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  useEffect(() => () => uploadRef.current?.abort(), []);

  const send = async (file: Blob & { name?: string }) => {
    const scanName = name.trim() || "My room";
    if (listing && file.size > listing.maxBytes) {
      setUpload({ status: "error", error: `The upload is ${formatBytes(file.size)}; the server accepts up to ${formatBytes(listing.maxBytes)}.` });
      return;
    }
    setUpload({ status: "uploading", progress: 0, name: scanName });
    const handle = uploadScan(file, scanName, (progress) => setUpload({ status: "uploading", progress, name: scanName }));
    uploadRef.current = handle;
    try {
      const scan = await handle.promise;
      setUpload({ status: "idle" });
      setName("");
      setListing((current) => current ? { ...current, scans: [scan, ...current.scans.filter((item) => item.id !== scan.id)] } : current);
      void refresh();
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setUpload({ status: "idle" });
        return;
      }
      setUpload({ status: "error", error: error instanceof Error ? error.message : "The upload failed." });
    } finally {
      uploadRef.current = null;
    }
  };

  const onRecorded = ({ blob }: RecordedVideo) => {
    setRecording(false);
    void send(blob);
  };

  const sendPhotos = async (photos: readonly Blob[]) => {
    setUpload({ status: "preparing", text: `Packing ${photos.length} photos…` });
    try {
      const archive = await packPhotos(photos);
      await send(archive);
    } catch (error) {
      setUpload({ status: "error", error: error instanceof Error ? error.message : "The photos could not be packed." });
    }
  };

  const onPhotosTaken = (photos: Blob[]) => {
    setTakingPhotos(false);
    void sendPhotos(photos);
  };

  /** Photos picked from the gallery: shrunk one at a time, in file-name order. */
  const onPhotosPicked = async (files: File[]) => {
    const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    if (sorted.length < MIN_SCAN_PHOTOS) {
      setUpload({ status: "error", error: `Choose at least ${MIN_SCAN_PHOTOS} photos (you chose ${sorted.length}). Take one photo per small step around the room.` });
      return;
    }
    if (sorted.length > MAX_SCAN_PHOTOS) {
      setUpload({ status: "error", error: `Choose up to ${MAX_SCAN_PHOTOS} photos (you chose ${sorted.length}).` });
      return;
    }
    const prepared: Blob[] = [];
    let skipped = 0;
    for (const [index, file] of sorted.entries()) {
      setUpload({ status: "preparing", text: `Preparing photos… ${index + 1}/${sorted.length}` });
      try {
        prepared.push(await preparePhoto(file));
      } catch {
        skipped += 1;
      }
    }
    if (prepared.length < MIN_SCAN_PHOTOS) {
      setUpload({ status: "error", error: `${skipped} of the photos could not be opened (HEIC photos may need converting to JPEG), leaving fewer than ${MIN_SCAN_PHOTOS}.` });
      return;
    }
    await sendPhotos(prepared);
  };

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
      await refresh();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The action failed.");
    } finally {
      setBusy(null);
    }
  };

  const scans = listing?.scans ?? [];
  const uploading = upload.status === "uploading" || upload.status === "preparing";

  return (
    <div className={studio.studioShell}>
      <header className={studio.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span aria-hidden="true" /> 3D scan</div>
        <Link href="/studio" className={studio.backLink}><ArrowLeft aria-hidden="true" /> Photo 360 studio</Link>
      </header>

      <main className={`${studio.studioMain} ${styles.layout}`}>
        <section className={styles.intro} aria-labelledby="scan-title">
          <p className={studio.kicker}><Box aria-hidden="true" /> Walk-through 3D</p>
          <h1 id="scan-title">Scan a room in 3D</h1>
          <p className={styles.lead}>
            Take photos while you walk around the room, or film a slow walk. The server finds where every
            photo was taken and builds a Gaussian splat scene you can walk through, with real depth and parallax.
          </p>
          <ol className={styles.tips}>
            <li><strong>Walk, don’t spin.</strong> Take a small step between photos so every spot is seen from several positions. Turning on the spot only makes a panorama.</li>
            <li><strong>Overlap.</strong> Each photo should share about two thirds of the last one. Go round at eye level, then tilted down, then tilted up.</li>
            <li><strong>Steady and bright.</strong> Lights on, hold still for each photo, no blank-wall close-ups. 40–100 photos for a normal room.</li>
          </ol>

          <div className={styles.uploadCard}>
            <label className={studio.roomNameField}>
              <span>Scan name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Living room"
                maxLength={80}
                disabled={uploading}
              />
            </label>
            <div className={styles.captureModes}>
              <section className={styles.captureMode} aria-labelledby="mode-photos">
                <h2 id="mode-photos"><Camera aria-hidden="true" /> Photos</h2>
                <p>Tap to take each photo while you step around the room ({MIN_SCAN_PHOTOS}–{MAX_SCAN_PHOTOS}). Works on any phone.</p>
                <div className={styles.actions}>
                  <button type="button" className={studio.primaryButton} onClick={() => setTakingPhotos(true)} disabled={uploading}>
                    <Camera aria-hidden="true" /> Take photos for 3D
                  </button>
                  <button type="button" className={studio.secondaryButton} onClick={() => photoInputRef.current?.click()} disabled={uploading}>
                    <ImagePlus aria-hidden="true" /> Upload photos
                  </button>
                  <input
                    ref={photoInputRef}
                    className={studio.hiddenInput}
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp,image/*"
                    aria-label="Choose photos of the room"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = "";
                      if (files.length > 0) void onPhotosPicked(files);
                    }}
                  />
                </div>
              </section>
              <section className={styles.captureMode} aria-labelledby="mode-video">
                <h2 id="mode-video"><Video aria-hidden="true" /> Video</h2>
                <p>Film one to three minutes of slow walking. More frames, so usually a denser 3D room.</p>
                <div className={styles.actions}>
                  <button type="button" className={studio.secondaryButton} onClick={() => setRecording(true)} disabled={uploading}>
                    <Video aria-hidden="true" /> Film the room
                  </button>
                  <button type="button" className={studio.secondaryButton} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    <Upload aria-hidden="true" /> Upload a video
                  </button>
                  <input
                    ref={fileInputRef}
                    className={studio.hiddenInput}
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv"
                    aria-label="Choose a video of the room"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void send(file);
                    }}
                  />
                </div>
              </section>
            </div>
            {upload.status === "preparing" ? (
              <p className={styles.uploadProgress} role="status">
                <span><Loader2 aria-hidden="true" className={styles.spin} /> {upload.text}</span>
              </p>
            ) : null}
            {upload.status === "uploading" ? (
              <div className={styles.uploadProgress} role="status">
                <span>Uploading “{upload.name}”… {Math.round(upload.progress * 100)}%</span>
                <progress max={1} value={upload.progress} aria-label="Upload progress" />
                <button type="button" onClick={() => uploadRef.current?.abort()}>Cancel</button>
              </div>
            ) : null}
            {upload.status === "error" ? <p className={studio.errorMessage} role="alert">{upload.error}</p> : null}
          </div>
        </section>

        <section className={styles.jobs} aria-labelledby="scans-title">
          <div className={styles.jobsHeader}>
            <h2 id="scans-title">Your scans</h2>
            <button type="button" className={styles.iconButton} onClick={() => void refresh()} aria-label="Reload scans">
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
          {listing?.worker === "local" ? (
            <p className={styles.workerNote}>
              Processing runs on this server. Without an NVIDIA GPU you get a quick preview; add the GPU worker
              (docker-compose.gpu.yml) for photoreal scenes, then re-process.
            </p>
          ) : null}
          {loadError ? <p className={studio.errorMessage} role="alert">{loadError}</p> : null}
          {!listing && !loadError ? <p className={styles.empty}>Loading…</p> : null}
          {listing && scans.length === 0 ? (
            <div className={styles.emptyState}>
              <Film aria-hidden="true" />
              <p>No scans yet. Take photos or film a room to start.</p>
            </div>
          ) : null}
          <ul className={styles.jobList}>
            {scans.map((job) => (
              <li key={job.id} className={styles.job} data-status={job.status}>
                <Link href={`/scan/${job.id}`} className={styles.jobMain}>
                  <span className={styles.poster}>
                    {job.status === "done" ? (
                      // eslint-disable-next-line @next/next/no-img-element -- served by the scan API, not static
                      <img src={scanFileUrl(job.id, "poster.jpg", job.updatedAt)} alt="" loading="lazy" />
                    ) : (
                      <span className={styles.statusIcon}>{statusIcon(job)}</span>
                    )}
                  </span>
                  <span className={styles.jobText}>
                    <strong>{job.name}</strong>
                    <small>{jobSummary(job)}</small>
                    {job.status === "running" || job.status === "queued" ? (
                      <progress max={1} value={job.progress} aria-label={`${job.name} progress`} />
                    ) : null}
                  </span>
                </Link>
                <div className={styles.jobActions}>
                  {job.status === "failed" || (job.status === "done" && job.result?.kind === "preview") ? (
                    <button
                      type="button"
                      onClick={() => void act(job.id, () => retryScan(job.id))}
                      disabled={busy === job.id}
                      aria-label={`${job.status === "failed" ? "Retry" : "Re-process"} ${job.name}`}
                      title={job.status === "failed" ? "Retry" : "Re-process (e.g. after adding a GPU worker)"}
                    >
                      <RefreshCw aria-hidden="true" />
                    </button>
                  ) : null}
                  {job.status !== "running" ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete “${job.name}” and its ${job.source === "photos" ? "photos" : "video"}?`)) void act(job.id, () => deleteScan(job.id));
                      }}
                      disabled={busy === job.id}
                      aria-label={`Delete ${job.name}`}
                      title="Delete"
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {recording ? <ScanRecorder onRecorded={onRecorded} onCancel={() => setRecording(false)} /> : null}
      {takingPhotos ? <ScanPhotoCapture onDone={onPhotosTaken} onCancel={() => setTakingPhotos(false)} /> : null}
    </div>
  );
}
