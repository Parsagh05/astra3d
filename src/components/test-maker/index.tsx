"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import {
  CAPTURE_COLUMNS,
  getCaptureBands,
  getCaptureProgress,
  getSignedAngleDelta,
  type CaptureExtent,
} from "@/lib/capture-plan";
import { capturePreviewStill } from "@/components/room-capture/capture-utils";
import { EMPTY_GUIDANCE, LiveCaptureGuide, type LiveCaptureGuideHandle } from "@/components/room-capture/live-capture-guide";
import { updateCaptureGuidance, type CaptureGuidanceState } from "@/components/room-capture/capture-guidance";
import { orientationToView } from "@/components/tour/tour-math";
import type { CapturedFrame, CaptureSlot } from "@/types/capture";

import styles from "./test-maker.module.css";

type CaptureMode = "automatic" | "manual";
type AutoScanStatus = "idle" | "countdown" | "scanning" | "between" | "complete";
type CameraMode = "idle" | "requesting" | "live" | "denied";

function buildTestMakerSlots(extent: CaptureExtent): CaptureSlot[] {
  const bands = getCaptureBands(extent);
  return bands.flatMap((band, bandIndex) =>
    Array.from({ length: CAPTURE_COLUMNS }, (_, column) => ({
      id: `${band.id}-${column}`,
      band: band.id,
      column,
      sequence: bandIndex * CAPTURE_COLUMNS + column,
      yaw: column * (360 / CAPTURE_COLUMNS),
    })),
  );
}

async function generateZip(caseName: string, frames: CapturedFrame[], extent: CaptureExtent): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  
  const folder = zip.folder(caseName);
  if (!folder) throw new Error("Failed to create folder");
  
  for (const frame of [...frames].sort((a, b) => a.sequence - b.sequence)) {
    const padded = String(frame.sequence + 1).padStart(2, "0");
    const filename = `${padded}.jpg`;
    
    let blob: Blob;
    if (frame.image) {
      blob = frame.image;
    } else if (frame.dataUrl) {
      const response = await fetch(frame.dataUrl);
      blob = await response.blob();
    } else {
      continue;
    }
    
    folder.file(filename, blob);
  }
  
  const metadata = {
    name: caseName,
    extent,
    imageCount: frames.length,
    createdAt: new Date().toISOString(),
    captureMode: extent === "full" ? "36-images" : "12-images",
  };
  folder.file("metadata.json", JSON.stringify(metadata, null, 2));
  
  return zip.generateAsync({ type: "blob" }) as Promise<Blob>;
}

export function TestMaker() {
  const [captureExtent, setCaptureExtent] = useState<CaptureExtent>("quick");
  const captureSlots = useMemo(() => buildTestMakerSlots(captureExtent), [captureExtent]);
  const captureBands = useMemo(() => getCaptureBands(captureExtent), [captureExtent]);
  const totalCaptureSlots = captureSlots.length;
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const framesRef = useRef<CapturedFrame[]>([]);
  const thumbnailUrlsRef = useRef(new Set<string>());
  const captureSessionRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const autoStatusRef = useRef<AutoScanStatus>("idle");
  const captureModeRef = useRef<CaptureMode>("automatic");
  const bandCaptureCountRef = useRef(0);
  const activeBandIndexRef = useRef(0);
  const guidanceRef = useRef<CaptureGuidanceState | null>(null);
  const guidanceDisplayRef = useRef<LiveCaptureGuideHandle>(null);
  const orientationRef = useRef({
    alpha: null as number | null,
    cameraYaw: null as number | null,
    cameraPitch: null as number | null,
    lastYaw: null as number | null,
    accumulated: 0,
    lastEventAt: 0,
    baselinePitch: null as number | null,
    betaSample: null as number | null,
    gammaSample: null as number | null,
  });
  const captureLockRef = useRef<MediaStreamTrack | null>(null);
  const captureInFlightRef = useRef(false);
  
  const [stage, setStage] = useState<"intro" | "capture" | "review">("intro");
  const [cameraMode, setCameraMode] = useState<CameraMode>("idle");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoScanStatus, setAutoScanStatusState] = useState<AutoScanStatus>("idle");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("automatic");
  const [countdown, setCountdown] = useState(3);
  const [caseName, setCaseName] = useState("");
  const [downloading, setDownloading] = useState(false);

  const activeSlot = captureSlots[frames.length];
  const activeBand = captureBands.find((band) => band.id === activeSlot?.band);
  const currentBandFrames = activeSlot ? frames.filter((frame) => frame.band === activeSlot.band).length : CAPTURE_COLUMNS;
  const activeDirection = currentBandFrames;
  const captureComplete = frames.length === totalCaptureSlots;

  const clearAutoTimers = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    captureSessionRef.current += 1;
    clearAutoTimers();
    guidanceRef.current = null;
    autoStatusRef.current = "idle";
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    captureLockRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [clearAutoTimers]);

  const releaseThumbnails = useCallback(() => {
    thumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    thumbnailUrlsRef.current.clear();
  }, []);

  const addFrame = useCallback((image: Blob, thumbnailUrl: string, imu?: { alpha: number; beta: number; gamma: number }, capturedAt?: number) => {
    const slot = captureSlots[frames.length];
    if (!slot) { URL.revokeObjectURL(thumbnailUrl); return; }
    thumbnailUrlsRef.current.add(thumbnailUrl);
    const capturedFrame: CapturedFrame = {
      ...slot,
      image,
      thumbnailUrl,
      capturedAt: capturedAt ?? Date.now(),
      zoom: 1,
      ...(imu ? { imu } : {}),
    };
    const next = [...framesRef.current, capturedFrame];
    framesRef.current = next;
    setFrames(next);
    if (next.length === totalCaptureSlots) stopCamera();
  }, [captureSlots, frames.length, stopCamera, totalCaptureSlots]);

  const setAutoScanStatus = useCallback((status: AutoScanStatus) => {
    autoStatusRef.current = status;
    setAutoScanStatusState(status);
  }, []);

  const captureAutomaticFrame = useCallback(async () => {
    if (!videoRef.current || autoStatusRef.current !== "scanning") return;
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;

    try {
      const orientation = orientationRef.current;
      const motionFresh = orientation.alpha !== null &&
        orientation.betaSample !== null &&
        orientation.gammaSample !== null &&
        Date.now() - orientation.lastEventAt < 1500;
      const imu = motionFresh
        ? { alpha: orientation.alpha as number, beta: orientation.betaSample as number, gamma: orientation.gammaSample as number }
        : undefined;
      const capturedAt = Date.now();
      const capture = await capturePreviewStill(videoRef.current, 1);
      addFrame(capture.image, capture.thumbnailUrl, imu, capturedAt);
      
      const count = framesRef.current.length;
      activeBandIndexRef.current = Math.floor(count / CAPTURE_COLUMNS);
      bandCaptureCountRef.current = count % CAPTURE_COLUMNS;
      
      if (count === totalCaptureSlots) {
        setAutoScanStatus("complete");
      } else if (count % CAPTURE_COLUMNS === 0) {
        setAutoScanStatus("between");
      }
    } finally {
      captureInFlightRef.current = false;
    }
  }, [addFrame, setAutoScanStatus, totalCaptureSlots]);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || !Number.isFinite(event.alpha) || !Number.isFinite(event.beta)) return;
      
      const pose = orientationToView(event.alpha, event.beta, typeof event.gamma === "number" && Number.isFinite(event.gamma) ? event.gamma : 0);
      const orientation = orientationRef.current;
      orientation.alpha = event.alpha;
      orientation.cameraYaw = pose.yaw;
      orientation.cameraPitch = pose.pitch;
      orientation.betaSample = event.beta;
      orientation.gammaSample = event.gamma;
      orientation.lastEventAt = Date.now();

      if (autoStatusRef.current !== "scanning" || captureModeRef.current !== "automatic") return;

      if (orientation.lastYaw !== null) {
        orientation.accumulated += getSignedAngleDelta(pose.yaw, orientation.lastYaw);
      }
      orientation.lastYaw = pose.yaw;
      if (orientation.baselinePitch === null) orientation.baselinePitch = pose.pitch;

      const yawTarget = bandCaptureCountRef.current * (360 / CAPTURE_COLUMNS);
      const pitchTarget = captureBands[activeBandIndexRef.current]?.pitch ?? 0;
      
      const result = updateCaptureGuidance(guidanceRef.current, {
        time: performance.now(),
        yaw: Math.abs(orientation.accumulated),
        pitch: pose.pitch - orientation.baselinePitch,
      }, { yaw: yawTarget, pitch: pitchTarget });
      
      guidanceRef.current = result.state;
      guidanceDisplayRef.current?.update(result.guidance);

      if (result.ready) {
        void captureAutomaticFrame();
      }
    };

    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => window.removeEventListener("deviceorientation", handleOrientation, true);
  }, [captureAutomaticFrame, captureBands]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraMode("denied");
      setError("Camera access requires HTTPS or localhost.");
      return false;
    }

    setCameraMode("requesting");
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 24, max: 30 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraMode("live");
      return true;
    } catch {
      setCameraMode("denied");
      setError("Camera access was blocked.");
      return false;
    }
  }, []);

  const startAutomaticSweep = async () => {
    if (cameraMode !== "live" || captureComplete) return;
    clearAutoTimers();
    setError(null);

    activeBandIndexRef.current = Math.floor(frames.length / CAPTURE_COLUMNS);
    bandCaptureCountRef.current = frames.length % CAPTURE_COLUMNS;
    orientationRef.current.lastYaw = null;
    orientationRef.current.accumulated = 0;
    guidanceRef.current = null;
    guidanceDisplayRef.current?.update(EMPTY_GUIDANCE);

    if (captureMode === "manual") {
      captureModeRef.current = "manual";
      setAutoScanStatus("scanning");
      return;
    }

    try {
      const orientationConstructor = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      if (typeof orientationConstructor.requestPermission === "function") {
        await orientationConstructor.requestPermission();
      }
    } catch {
      // Capture can continue manually when motion permission is unavailable.
    }

    setCountdown(3);
    setAutoScanStatus("countdown");

    let remaining = 3;
    countdownIntervalRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setCountdown(remaining);
        return;
      }

      if (countdownIntervalRef.current !== null) {
        window.clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }

      const motionAvailable = orientationRef.current.alpha !== null &&
        Date.now() - orientationRef.current.lastEventAt < 1500;
      const mode: CaptureMode = motionAvailable ? "automatic" : "manual";
      captureModeRef.current = mode;
      setCaptureMode(mode);
      if (!motionAvailable) {
        setError("Motion guidance is unavailable, so capture switched to Manual. Align each target and tap the shutter.");
      }
      setAutoScanStatus("scanning");
      orientationRef.current.lastYaw = orientationRef.current.cameraYaw;
      if (orientationRef.current.baselinePitch === null) {
        orientationRef.current.baselinePitch = orientationRef.current.cameraPitch;
      }
      orientationRef.current.accumulated = 0;
    }, 1000);
  };

  const beginCapture = () => {
    clearAutoTimers();
    framesRef.current = [];
    setFrames([]);
    releaseThumbnails();
    setError(null);
    setAutoScanStatus("idle");
    setCaptureMode("automatic");
    captureModeRef.current = "automatic";
    bandCaptureCountRef.current = 0;
    activeBandIndexRef.current = 0;
    orientationRef.current.baselinePitch = null;
    orientationRef.current.lastYaw = null;
    guidanceRef.current = null;
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const handleDownload = async () => {
    if (frames.length === 0) return;
    setDownloading(true);
    try {
      const name = caseName.trim() || `case-${Date.now()}`;
      const zipBlob = await generateZip(name, framesRef.current, captureExtent);
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `astra3d-test-${name}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const handleRetake = () => {
    framesRef.current = [];
    setFrames([]);
    setStage("intro");
    setAutoScanStatus("idle");
  };

  useEffect(() => () => { stopCamera(); releaseThumbnails(); }, [stopCamera, releaseThumbnails]);

  const bandCompletion = useMemo(
    () => captureBands.map((band) => ({
      ...band,
      count: frames.filter((frame) => frame.band === band.id).length,
    })),
    [frames, captureBands],
  );

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <BrandMark />
          <span>Test Maker</span>
        </div>
        <Link href="/" className={styles.backLink}>← Back to site</Link>
      </header>

      <main className={styles.main}>
        {stage === "intro" ? (
          <section className={styles.intro}>
            <h1>Create Test Case</h1>
            <p>Capture images using the same guidance system as the Astra3D application.</p>

            <label className={styles.nameField}>
              <span>Test case name</span>
              <input
                value={caseName}
                onChange={(e) => setCaseName(e.target.value)}
                placeholder="e.g., living-room-001"
              />
            </label>

            <div className={styles.modeSelect} role="group" aria-label="Capture coverage">
              <button
                type="button"
                aria-pressed={captureExtent === "quick"}
                data-active={captureExtent === "quick"}
                onClick={() => setCaptureExtent("quick")}
              >
                <strong>Quick · 12 photos</strong>
                <small>One eye-level sweep</small>
              </button>
              <button
                type="button"
                aria-pressed={captureExtent === "full"}
                data-active={captureExtent === "full"}
                onClick={() => setCaptureExtent("full")}
              >
                <strong>Full · 36 photos</strong>
                <small>Eye level, ceiling and floor</small>
              </button>
            </div>

            <p className={styles.coverageNote}>
              {captureExtent === "quick" ? "Quick scan captures 12 photos at eye level." : "Full scan captures 36 photos across three bands."}
            </p>

            <button className={styles.startButton} type="button" onClick={beginCapture}>
              Start Capture
            </button>
          </section>
        ) : null}

        {stage === "capture" ? (
          <section className={styles.capture}>
            <div className={styles.topbar}>
              <button type="button" onClick={() => { stopCamera(); setStage("intro"); }}>
                ← Exit
              </button>
              <div>
                <span>Progress</span>
                <strong>{frames.length} / {totalCaptureSlots}</strong>
              </div>
              <div className={styles.progressTrack} role="progressbar">
                <span style={{ width: `${getCaptureProgress(frames.length, totalCaptureSlots)}%` }} />
              </div>
            </div>

            <div className={styles.workspace}>
              <div className={styles.cameraPanel}>
                <div className={styles.cameraViewport}>
                  {cameraMode === "live" || cameraMode === "requesting" ? (
                    <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview" />
                  ) : (
                    <div className={styles.cameraFallback}>
                      <strong>Camera required</strong>
                      <p>Allow camera access to capture images.</p>
                    </div>
                  )}
                  <div className={styles.cameraGrid}><i /><i /></div>
                  {activeBand ? (
                    <div className={styles.cameraInstruction}>
                      <span>{activeBand.label} · {activeBand.tilt}</span>
                      <strong>Direction {Math.min(activeDirection + 1, CAPTURE_COLUMNS)} of {CAPTURE_COLUMNS}</strong>
                    </div>
                  ) : null}
                  {cameraMode === "live" && autoScanStatus === "scanning" && captureMode === "automatic" ? (
                    <LiveCaptureGuide
                      ref={guidanceDisplayRef}
                      direction={activeDirection + 1}
                      bandLabel={activeBand?.label ?? "Room"}
                      tilt={activeBand?.tilt ?? ""}
                    />
                  ) : null}
                  {cameraMode === "live" && autoScanStatus !== "idle" && !(autoScanStatus === "scanning" && captureMode === "automatic") ? (
                    <div className={styles.autoState} data-status={autoScanStatus}>
                      {autoScanStatus === "countdown" ? (
                        <><span>Starting</span><strong>{countdown}</strong><small>Hold your starting direction.</small></>
                      ) : autoScanStatus === "scanning" && captureMode === "manual" ? (
                          <><span>Manual capture</span><strong>Align and tap capture</strong></>
                      ) : autoScanStatus === "between" ? (
                        <><span>Band complete</span><strong>{activeBand?.label} next</strong></>
                      ) : autoScanStatus === "complete" ? (
                        <><span>Complete</span><strong>Ready to download</strong></>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className={styles.directionRing}>
                  <div className={styles.directionDial}>
                    <div>
                      <span style={{ "--direction-angle": `${activeSlot?.yaw ?? 360}deg` } as React.CSSProperties} />
                    </div>
                    {Array.from({ length: CAPTURE_COLUMNS }, (_, index) => {
                      const captured = frames.some((frame) => frame.band === activeSlot?.band && frame.column === index);
                      const current = index === activeDirection;
                      return <i key={index} data-captured={captured} data-current={current}><span>{index + 1}</span></i>;
                    })}
                  </div>
                  <strong>{activeBand?.label ?? "Complete"}</strong>
                </div>

                <div className={styles.controls}>
                  {!captureComplete ? (
                    cameraMode === "live" ? (
                      <button
                        className={styles.captureButton}
                        type="button"
                        onClick={() => {
                          if (autoScanStatus === "scanning" && captureMode === "manual") {
                            void captureAutomaticFrame();
                          } else {
                            void startAutomaticSweep();
                          }
                        }}
                        disabled={autoScanStatus === "countdown" || (autoScanStatus === "scanning" && captureMode === "automatic")}
                      >
                        {autoScanStatus === "countdown" ? `Starting in ${countdown}` : 
                         autoScanStatus === "scanning" && captureMode === "automatic" ? "Guided capture active" :
                         captureComplete ? "Complete" : "Begin sweep"}
                      </button>
                    ) : (
                      <button className={styles.captureButton} type="button" disabled>
                        Camera required
                      </button>
                    )
                  ) : (
                    <button className={styles.downloadButton} type="button" onClick={() => setStage("review")}>
                      Review & Download
                    </button>
                  )}
                </div>
              </div>

              <aside className={styles.rail}>
                <h2>Coverage</h2>
                <div className={styles.bandList}>
                  {bandCompletion.map((band) => (
                    <div key={band.id} data-active={band.id === activeSlot?.band} data-complete={band.count === CAPTURE_COLUMNS}>
                      <span>{band.count === CAPTURE_COLUMNS ? "✓" : band.tilt}</span>
                      <div><strong>{band.label}</strong><small>{band.count} / {CAPTURE_COLUMNS}</small></div>
                    </div>
                  ))}
                </div>
                {frames.length > 0 ? (
                  <div className={styles.thumbnails}>
                    <strong>Captured</strong>
                    <div>
                      {frames.map((frame) => (
                        <div key={frame.sequence} className={styles.thumbnail}>
                          <img src={frame.thumbnailUrl} alt={`Frame ${frame.sequence + 1}`} />
                          <span>{frame.sequence + 1}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {error ? <p className={styles.error}>{error}</p> : null}
              </aside>
            </div>
          </section>
        ) : null}

        {stage === "review" ? (
          <section className={styles.review}>
            <h1>Review Test Case</h1>
            <p>{frames.length} images captured for {captureExtent === "full" ? "36-image" : "12-image"} test case.</p>
            
            <div className={styles.reviewPreview}>
              <h2>Captured Images</h2>
              <div className={styles.previewGrid}>
                {frames.map((frame) => (
                  <div key={frame.sequence} className={styles.previewItem}>
                    <img src={frame.thumbnailUrl} alt={`Frame ${frame.sequence + 1}`} />
                    <span>{frame.sequence + 1}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.reviewActions}>
              <button className={styles.retakeButton} type="button" onClick={handleRetake}>
                Retake
              </button>
              <button
                className={styles.downloadButton}
                type="button"
                onClick={handleDownload}
                disabled={downloading}
              >
                {downloading ? "Preparing..." : "Download Test Case ZIP"}
              </button>
            </div>

            <p className={styles.downloadNote}>
              Extract the ZIP to <code>test-cases/</code> directory. The test case will be available in the Test Runner.
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
