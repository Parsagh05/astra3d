"use client";

import { ArrowLeft, Camera, Check, Download, FolderCheck, LockKeyhole, RotateCcw, ScanLine } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { BrandMark } from "@/components/brand-mark";
import {
  captureFullStill,
  lockCameraAppearance,
  type AppearanceLock,
  type PreviewStillCapture,
} from "@/components/room-capture/capture-utils";
import { CaptureSphereView, type SphereShot } from "@/components/room-capture/capture-sphere-view";
import { createPanoramaUpload } from "@/components/room-capture/panorama-api";
import studio from "@/components/room-capture/room-capture.module.css";
import { useGuidedCapture, type CaptureMode, type CapturePose } from "@/components/room-capture/use-guided-capture";
import {
  buildCaptureSlots,
  CAPTURE_COLUMNS,
  getCaptureBands,
  getCaptureProgress,
  type CaptureExtent,
} from "@/lib/capture-plan";
import type { CapturedFrame } from "@/types/capture";

import styles from "./test-maker.module.css";

type CameraMode = "idle" | "requesting" | "live" | "denied";
type SavedCase = { path: string; name: string; imageCount: number };

function caseGroup(extent: CaptureExtent) {
  return extent === "quick" ? `${CAPTURE_COLUMNS}-images` : `${CAPTURE_COLUMNS * 3}-images`;
}

/** Same layout the server writes, so an extracted ZIP is a ready test case. */
async function generateZip(caseName: string, frames: readonly CapturedFrame[], extent: CaptureExtent): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const folder = zip.folder(caseGroup(extent))?.folder(caseName);
  if (!folder) throw new Error("The ZIP folder could not be created.");
  const ordered = [...frames].sort((a, b) => a.sequence - b.sequence);
  const records = [];
  for (const frame of ordered) {
    const file = `${String(frame.sequence + 1).padStart(2, "0")}.jpg`;
    const image = frame.image ?? (frame.dataUrl ? await (await fetch(frame.dataUrl)).blob() : null);
    if (!image) continue;
    folder.file(file, image);
    records.push({
      sequence: frame.sequence,
      band: frame.band,
      column: frame.column,
      file,
      zoom: frame.zoom,
      ...(frame.imu ? { imu: frame.imu } : {}),
    });
  }
  folder.file("metadata.json", `${JSON.stringify({
    version: 1,
    name: caseName,
    extent,
    imageCount: records.length,
    createdAt: new Date().toISOString(),
    source: "test-maker",
    frames: records,
  }, null, 2)}\n`);
  return zip.generateAsync({ type: "blob" });
}

function caseSlug(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
    `case-${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Captures fixed photo sets for the Tests page using exactly the studio's
 * guidance: same targets, same heading, same hold-to-capture rule and the
 * same stored motion data, so a case replays like a real studio upload.
 */
export function TestMaker() {
  const [captureExtent, setCaptureExtent] = useState<CaptureExtent>("full");
  const captureSlots = useMemo(() => buildCaptureSlots(captureExtent), [captureExtent]);
  const captureBands = useMemo(() => getCaptureBands(captureExtent), [captureExtent]);
  const totalCaptureSlots = captureSlots.length;

  const videoRef = useRef<HTMLVideoElement>(null);
  const framesRef = useRef<CapturedFrame[]>([]);
  const thumbnailUrlsRef = useRef(new Set<string>());
  const captureSessionRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const captureInFlightRef = useRef(false);
  const captureLockRef = useRef<MediaStreamTrack | null>(null);
  const captureFrameRef = useRef<() => Promise<void>>(async () => undefined);

  const [stage, setStage] = useState<"intro" | "capture" | "review">("intro");
  const [cameraMode, setCameraMode] = useState<CameraMode>("idle");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [caseName, setCaseName] = useState("");
  const [busy, setBusy] = useState<"saving" | "zipping" | null>(null);
  const [savedCase, setSavedCase] = useState<SavedCase | null>(null);
  const [appearanceLock, setAppearanceLock] = useState<AppearanceLock | null>(null);

  const handleAutoCapture = useCallback(() => void captureFrameRef.current(), []);
  const {
    status: autoScanStatus,
    mode: captureMode,
    countdown,
    motionLive,
    engineRef,
    statusRef,
    startSweep,
    selectMode,
    afterCapture,
    stop: stopGuidance,
    reset: resetGuidance,
    capturePose,
  } = useGuidedCapture({ bands: captureBands, onAutoCapture: handleAutoCapture, onNotice: setError });

  const activeSlot = captureSlots[frames.length];
  const activeBand = captureBands.find((band) => band.id === activeSlot?.band);
  const activeDirection = activeSlot?.column ?? CAPTURE_COLUMNS;
  const captureComplete = frames.length === totalCaptureSlots;

  const stopCamera = useCallback(() => {
    captureSessionRef.current += 1;
    stopGuidance();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    captureLockRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [stopGuidance]);

  // Same as the studio: freeze exposure, white balance and focus right after
  // the first photo so the whole case shares one brightness and colour.
  const lockCaptureAppearance = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track || captureLockRef.current === track) return;
    captureLockRef.current = track;
    setAppearanceLock(await lockCameraAppearance(track));
  }, []);

  const releaseThumbnails = useCallback(() => {
    thumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    thumbnailUrlsRef.current.clear();
  }, []);

  useEffect(() => () => { stopCamera(); releaseThumbnails(); }, [stopCamera, releaseThumbnails]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraMode("denied");
      setError("Camera access needs HTTPS or localhost. On a phone, use an Android USB reverse connection to http://localhost:3000.");
      return false;
    }
    setCameraMode("requesting");
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
        if (!video.videoWidth) {
          await new Promise<void>((resolve) => {
            video.addEventListener("loadeddata", () => resolve(), { once: true });
            window.setTimeout(resolve, 1500);
          });
        }
      }
      setCameraMode("live");
      return true;
    } catch {
      setCameraMode("denied");
      setError("Camera access was blocked. Allow camera and motion access in the browser, then retry.");
      return false;
    }
  }, []);

  const addFrame = useCallback((capture: PreviewStillCapture, pose: CapturePose, capturedAt: number) => {
    const current = framesRef.current;
    const slot = captureSlots[current.length];
    if (!slot) {
      URL.revokeObjectURL(capture.thumbnailUrl);
      return current.length;
    }
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    thumbnailUrlsRef.current.add(capture.thumbnailUrl);
    const next = [...current, {
      ...slot,
      image: capture.image,
      thumbnailUrl: capture.thumbnailUrl,
      capturedAt,
      zoom: 1,
      ...(pose.imu ? { imu: pose.imu } : {}),
      ...(pose.view ? { view: pose.view } : {}),
    }];
    framesRef.current = next;
    setFrames(next);
    return next.length;
  }, [captureSlots]);

  const captureFrame = useCallback(async () => {
    if (!videoRef.current || statusRef.current !== "scanning") return;
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    const session = captureSessionRef.current;
    try {
      const pose = capturePose();
      const capturedAt = Date.now();
      const capture = await captureFullStill(videoRef.current, streamRef.current?.getVideoTracks?.()[0], 1);
      if (statusRef.current !== "scanning" || session !== captureSessionRef.current) {
        URL.revokeObjectURL(capture.thumbnailUrl);
        return;
      }
      const count = addFrame(capture, pose, capturedAt);
      afterCapture(count, totalCaptureSlots);
      void lockCaptureAppearance();
    } catch (captureError) {
      if (session !== captureSessionRef.current) return;
      stopGuidance();
      setError(captureError instanceof Error ? captureError.message : "Capture stopped unexpectedly.");
    } finally {
      captureInFlightRef.current = false;
    }
  }, [addFrame, afterCapture, capturePose, lockCaptureAppearance, statusRef, stopGuidance, totalCaptureSlots]);

  useEffect(() => {
    captureFrameRef.current = captureFrame;
  }, [captureFrame]);

  const clearFrames = () => {
    framesRef.current = [];
    setFrames([]);
    releaseThumbnails();
  };

  const beginCapture = () => {
    resetGuidance();
    setAppearanceLock(null);
    clearFrames();
    setError(null);
    setSavedCase(null);
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const exitCapture = () => {
    stopCamera();
    resetGuidance();
    clearFrames();
    setCameraMode("idle");
    setStage("intro");
  };

  const retakeLast = () => {
    const last = framesRef.current.at(-1);
    if (!last) return;
    if (last.thumbnailUrl) {
      URL.revokeObjectURL(last.thumbnailUrl);
      thumbnailUrlsRef.current.delete(last.thumbnailUrl);
    }
    const next = framesRef.current.slice(0, -1);
    framesRef.current = next;
    setFrames(next);
    setError(null);
    afterCapture(next.length, totalCaptureSlots);
  };

  const startAutomaticSweep = async () => {
    if (cameraMode !== "live" || captureComplete) return;
    setError(null);
    await startSweep(frames.length);
  };

  const selectCaptureMode = (mode: CaptureMode) => {
    setError(null);
    selectMode(mode, frames.length);
  };

  const goToReview = () => {
    stopCamera();
    setCameraMode("idle");
    setStage("review");
  };

  const saveToProject = async () => {
    if (framesRef.current.length !== totalCaptureSlots) return;
    setBusy("saving");
    setError(null);
    try {
      const name = caseName.trim() || caseSlug("");
      const response = await fetch("/api/tests", {
        method: "POST",
        headers: { "X-Astra3D-Client": "room-studio-v1" },
        body: createPanoramaUpload(framesRef.current, name, captureExtent),
      });
      const payload = await response.json() as { testCase?: SavedCase; error?: string };
      if (!response.ok || !payload.testCase) throw new Error(payload.error ?? `Saving failed (HTTP ${response.status}).`);
      setSavedCase(payload.testCase);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The test case could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const downloadZip = async () => {
    if (framesRef.current.length === 0) return;
    setBusy("zipping");
    try {
      const name = caseSlug(caseName);
      const zip = await generateZip(name, framesRef.current, captureExtent);
      const url = URL.createObjectURL(zip);
      const link = document.createElement("a");
      link.href = url;
      link.download = `astra3d-test-${name}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (zipError) {
      setError(zipError instanceof Error ? zipError.message : "The ZIP could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const bandCompletion = useMemo(
    () => captureBands.map((band) => ({
      ...band,
      count: frames.filter((frame) => frame.band === band.id).length,
    })),
    [frames, captureBands],
  );
  const sphereShots = useMemo<SphereShot[]>(
    () => frames.map((frame) => ({
      key: frame.sequence,
      url: frame.thumbnailUrl,
      view: frame.view,
      yaw: frame.yaw,
      pitch: captureBands.find((band) => band.id === frame.band)?.pitch ?? 0,
    })),
    [frames, captureBands],
  );
  const guidingLive = cameraMode === "live" && autoScanStatus === "scanning" && captureMode === "automatic";
  const sphereView = cameraMode === "live" && captureMode === "automatic" && motionLive &&
    (autoScanStatus === "scanning" || autoScanStatus === "between" || autoScanStatus === "complete" ||
      (autoScanStatus === "countdown" && frames.length > 0));

  return (
    <div className={studio.studioShell}>
      <header className={studio.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span /> Test Maker · capture fixed photo sets</div>
        <Link href="/tests" className={studio.backLink}>Tests page <ArrowLeft aria-hidden="true" style={{ transform: "scaleX(-1)" }} /></Link>
      </header>

      <main className={studio.studioMain}>
        {stage === "intro" ? (
          <section className={styles.intro} aria-labelledby="test-maker-title">
            <p className={studio.kicker}><ScanLine aria-hidden="true" /> Test case capture</p>
            <h1 id="test-maker-title">Create a test case</h1>
            <p>
              Capture a room once with the same guidance as the studio. The photos and motion data are saved to
              <code> test-cases/</code> so every new stitching algorithm can be tested on exactly the same shots.
            </p>

            <label className={styles.nameField}>
              <span>Test case name</span>
              <input
                value={caseName}
                maxLength={48}
                onChange={(event) => setCaseName(event.target.value)}
                placeholder="e.g. living-room-window"
              />
            </label>

            <div className={styles.modeSelect} role="group" aria-label="Capture coverage">
              <button type="button" aria-pressed={captureExtent === "full"} data-active={captureExtent === "full"} onClick={() => setCaptureExtent("full")}>
                <strong>Full 360 · 36 photos</strong>
                <small>Eye level, ceiling and floor</small>
              </button>
              <button type="button" aria-pressed={captureExtent === "quick"} data-active={captureExtent === "quick"} onClick={() => setCaptureExtent("quick")}>
                <strong>Quick · 12 photos</strong>
                <small>One eye-level sweep</small>
              </button>
            </div>

            <button className={studio.primaryButton} type="button" onClick={beginCapture}>
              <Camera aria-hidden="true" /> Start capture
            </button>
            <p className={styles.hint}>
              Stand in one spot and turn right. Line the orange dot up inside the white ring and hold still — each
              photo is taken automatically.
            </p>
          </section>
        ) : null}

        {stage === "capture" ? (
          <section className={studio.captureStage} aria-labelledby="test-capture-title">
            <div className={studio.captureTopbar}>
              <button type="button" onClick={exitCapture}>
                <ArrowLeft aria-hidden="true" /> Exit
              </button>
              <div>
                <span>Test case progress</span>
                <strong>{frames.length} / {totalCaptureSlots}</strong>
              </div>
              <div
                className={studio.progressTrack}
                role="progressbar"
                aria-label="Test case capture progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={getCaptureProgress(frames.length, totalCaptureSlots)}
              >
                <span style={{ width: `${getCaptureProgress(frames.length, totalCaptureSlots)}%` }} />
              </div>
            </div>

            <div className={studio.captureWorkspace}>
              <div className={studio.cameraPanel}>
                <div className={studio.cameraViewport} data-flash={flash}>
                  <CaptureSphereView
                    videoRef={videoRef}
                    videoLabel="Camera preview"
                    engineRef={engineRef}
                    sphere={sphereView}
                    guiding={guidingLive}
                    reticle={cameraMode === "live" && autoScanStatus === "scanning"}
                    shots={sphereShots}
                    targetLabel={`Target ${Math.min(activeDirection + 1, CAPTURE_COLUMNS)} of ${CAPTURE_COLUMNS}`}
                  />
                  {cameraMode === "live" || cameraMode === "requesting" ? null : (
                    <div className={studio.fileCameraFallback}>
                      <LockKeyhole aria-hidden="true" />
                      <strong>Camera required</strong>
                      <p>Open this page over HTTPS or http://localhost and allow camera and motion access.</p>
                    </div>
                  )}
                  {sphereView ? null : <div className={studio.cameraGrid} aria-hidden="true"><i /><i /></div>}
                  {activeBand ? (
                    <div className={studio.cameraInstruction}>
                      <span>{activeBand.label} · {activeBand.tilt}</span>
                      <strong>Direction {Math.min(activeDirection + 1, CAPTURE_COLUMNS)} of {CAPTURE_COLUMNS}</strong>
                    </div>
                  ) : null}
                  {cameraMode === "requesting" ? <p className={studio.cameraLoading}>Starting camera…</p> : null}
                  {cameraMode === "live" && autoScanStatus !== "idle" && !guidingLive ? (
                    <div className={studio.autoCaptureState} data-status={autoScanStatus}>
                      {autoScanStatus === "countdown" ? (
                        <><span>Starting sweep</span><strong>{countdown}</strong><small>Hold your starting direction.</small></>
                      ) : autoScanStatus === "scanning" ? (
                        <><span>Manual capture</span><strong>Center the view in the ring</strong><small>Tap the shutter when it looks right.</small></>
                      ) : autoScanStatus === "between" ? (
                        <><span>Sweep complete</span><strong>{activeBand?.label} is next</strong><small>{activeBand?.instruction}</small></>
                      ) : (
                        <><span>Coverage complete</span><strong>Ready to save</strong><small>All {totalCaptureSlots} photos are captured.</small></>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className={studio.directionRing} aria-label="Current rotation coverage">
                  <div className={studio.directionDial} style={{ "--slot-count": CAPTURE_COLUMNS } as CSSProperties}>
                    <div>
                      <span style={{ "--direction-angle": `${activeSlot?.yaw ?? 360}deg` } as CSSProperties} />
                    </div>
                    {Array.from({ length: CAPTURE_COLUMNS }, (_, index) => {
                      const captured = frames.some((frame) => frame.band === (activeSlot?.band ?? frame.band) && frame.column === index);
                      return (
                        <i key={index} data-captured={captured} data-current={index === activeDirection} style={{ "--index": index } as CSSProperties}>
                          {captured ? <Check aria-hidden="true" /> : index + 1}
                        </i>
                      );
                    })}
                  </div>
                  <strong>{activeBand?.label ?? "Complete"}</strong>
                  <small>{activeBand?.instruction ?? "All angles captured."}</small>
                </div>

                <div className={studio.captureControls}>
                  <button
                    type="button"
                    onClick={retakeLast}
                    disabled={frames.length === 0 || autoScanStatus === "countdown"}
                    aria-label="Retake previous captured view"
                  >
                    <RotateCcw aria-hidden="true" /> Retake last
                  </button>
                  {captureComplete ? (
                    <button className={studio.buildButton} type="button" onClick={goToReview}>
                      <FolderCheck aria-hidden="true" /> Review &amp; save
                    </button>
                  ) : cameraMode === "live" ? (
                    <button
                      className={studio.fileCaptureButton}
                      type="button"
                      onClick={() => {
                        if (autoScanStatus === "scanning" && captureMode === "manual") void captureFrame();
                        else void startAutomaticSweep();
                      }}
                      disabled={autoScanStatus === "countdown" || guidingLive}
                    >
                      {autoScanStatus === "scanning" && captureMode === "manual" ? <Camera aria-hidden="true" /> : <ScanLine aria-hidden="true" />}
                      {autoScanStatus === "countdown"
                        ? `Starting in ${countdown}`
                        : guidingLive
                          ? "Live guidance active"
                          : autoScanStatus === "scanning"
                            ? `Capture target ${activeDirection + 1}`
                            : frames.length === 0
                              ? "Begin eye-level capture"
                              : `Begin ${activeBand?.tilt} capture`}
                    </button>
                  ) : (
                    <button className={studio.fileCaptureButton} type="button" disabled>
                      <LockKeyhole aria-hidden="true" /> Camera required
                    </button>
                  )}
                  <button
                    className={studio.quickModeSwitch}
                    type="button"
                    aria-label={`Switch to ${captureMode === "automatic" ? "Manual" : "Automatic"} capture`}
                    onClick={() => selectCaptureMode(captureMode === "automatic" ? "manual" : "automatic")}
                  >
                    {captureMode === "automatic" ? <ScanLine aria-hidden="true" /> : <Camera aria-hidden="true" />}
                    {captureMode === "automatic" ? "Auto" : "Manual"}
                  </button>
                </div>
              </div>

              <aside className={studio.captureRail}>
                <p className={studio.kicker}>Test case · {caseSlug(caseName)}</p>
                <h1 id="test-capture-title">Turn right. Hold still.</h1>
                <p>Bring the orange dot into the white ring and pause. The ring fills and the photo is taken.</p>
                <div className={studio.bandList}>
                  {bandCompletion.map((band) => (
                    <div key={band.id} data-active={band.id === activeSlot?.band} data-complete={band.count === CAPTURE_COLUMNS}>
                      <span>{band.count === CAPTURE_COLUMNS ? <Check aria-hidden="true" /> : band.tilt}</span>
                      <div><strong>{band.label}</strong><small>{band.count} / {CAPTURE_COLUMNS} views</small></div>
                      <i><b style={{ width: `${(band.count / CAPTURE_COLUMNS) * 100}%` }} /></i>
                    </div>
                  ))}
                </div>
{appearanceLock ? (
                  <p className={studio.lockStatus} data-state={appearanceLock} role="status">
                    {appearanceLock === "locked"
                      ? "Exposure and colour locked after photo 1, so every photo matches."
                      : "This browser can't lock exposure; the laptop evens out brightness instead."}
                  </p>
                ) : null}
                {frames.length > 0 ? (
                  <div className={styles.thumbnails}>
                    {frames.map((frame) => (
                      // eslint-disable-next-line @next/next/no-img-element -- local blob thumbnails
                      <img key={frame.sequence} src={frame.thumbnailUrl} alt={`Photo ${frame.sequence + 1}`} />
                    ))}
                  </div>
                ) : null}
                {error ? <p className={studio.errorMessage} role="alert">{error}</p> : null}
                {cameraMode === "denied" ? (
                  <button className={studio.retryCamera} type="button" onClick={() => void startCamera()}>
                    <Camera aria-hidden="true" /> Retry camera
                  </button>
                ) : null}
              </aside>
            </div>
          </section>
        ) : null}

        {stage === "review" ? (
          <section className={styles.review} aria-labelledby="test-review-title">
            <p className={studio.kicker}><FolderCheck aria-hidden="true" /> Review</p>
            <h1 id="test-review-title">{frames.length} photos ready</h1>
            <p>
              {captureExtent === "full" ? "Full 36-photo" : "Quick 12-photo"} test case
              {frames.some((frame) => frame.imu) ? " with motion data" : " without motion data"}.
            </p>

            <label className={styles.nameField}>
              <span>Test case name</span>
              <input value={caseName} maxLength={48} onChange={(event) => setCaseName(event.target.value)} placeholder="e.g. living-room-window" />
            </label>

            <div className={styles.previewGrid}>
              {frames.map((frame) => (
                <figure key={frame.sequence}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local blob thumbnails */}
                  <img src={frame.thumbnailUrl} alt={`Photo ${frame.sequence + 1}`} />
                  <figcaption>{frame.sequence + 1}</figcaption>
                </figure>
              ))}
            </div>

            {savedCase ? (
              <div className={styles.savedNotice} role="status">
                <Check aria-hidden="true" />
                <div>
                  <strong>Saved to test-cases/{savedCase.path}</strong>
                  <small>It is listed on the Tests page now.</small>
                </div>
                <Link href="/tests" className={studio.primaryButton}>Open Tests page</Link>
              </div>
            ) : null}
            {error ? <p className={studio.errorMessage} role="alert">{error}</p> : null}

            <div className={styles.reviewActions}>
              <button className={styles.secondaryButton} type="button" onClick={beginCapture}>
                <RotateCcw aria-hidden="true" /> Capture again
              </button>
              <button className={styles.secondaryButton} type="button" onClick={() => void downloadZip()} disabled={busy !== null}>
                <Download aria-hidden="true" /> {busy === "zipping" ? "Preparing ZIP…" : "Download ZIP"}
              </button>
              <button className={studio.primaryButton} type="button" onClick={() => void saveToProject()} disabled={busy !== null || savedCase !== null}>
                <FolderCheck aria-hidden="true" /> {busy === "saving" ? "Saving…" : savedCase ? "Saved" : "Save to test-cases/"}
              </button>
            </div>
            <p className={styles.hint}>
              The ZIP holds the same <code>{caseGroup(captureExtent)}/&lt;name&gt;/</code> folder — extract it into
              <code> test-cases/</code> on another machine.
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
