"use client";

import {
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  CircleGauge,
  ImagePlus,
  LockKeyhole,
  RotateCcw,
  ScanLine,
  Sparkles,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import type { CapturedFrame, GeneratedRoomRecord } from "@/types/capture";

import {
  buildCaptureSlots,
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  captureVideoFrame,
  extractFramesFromScanVideo,
  getCaptureProgress,
  getSignedAngleDelta,
  hasReachedSweepTarget,
  normalizeRoomPhoto,
  stitchRoomPanorama,
  TOTAL_CAPTURE_SLOTS,
} from "./capture-utils";
import { GeneratedRoomViewer } from "./generated-room-viewer";
import {
  deleteGeneratedRoom,
  loadGeneratedRoom,
  saveGeneratedRoom,
} from "./room-storage";
import styles from "./room-capture.module.css";

type StudioStage = "intro" | "capture" | "processing" | "result";
type CameraMode = "idle" | "requesting" | "live" | "file" | "denied";
type AutoScanStatus = "idle" | "countdown" | "scanning" | "between" | "complete";
type SensorMode = "imu" | "timed";

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const captureSlots = buildCaptureSlots();

export function RoomStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoIntervalRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const autoStatusRef = useRef<AutoScanStatus>("idle");
  const sensorModeRef = useRef<SensorMode>("timed");
  const bandCaptureCountRef = useRef(0);
  const activeBandIndexRef = useRef(0);
  const orientationRef = useRef({
    alpha: null as number | null,
    lastAlpha: null as number | null,
    accumulated: 0,
    lastEventAt: 0,
  });
  const [stage, setStage] = useState<StudioStage>("intro");
  const [cameraMode, setCameraMode] = useState<CameraMode>("idle");
  const [roomName, setRoomName] = useState("My room");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [room, setRoom] = useState<GeneratedRoomRecord | null>(null);
  const [loadingSavedRoom, setLoadingSavedRoom] = useState(true);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [liveCameraAvailable, setLiveCameraAvailable] = useState(false);
  const [autoScanStatus, setAutoScanStatus] = useState<AutoScanStatus>("idle");
  const [sensorMode, setSensorMode] = useState<SensorMode>("timed");
  const [countdown, setCountdown] = useState(3);
  const [processingLabel, setProcessingLabel] = useState("Assembling panorama");
  const [processingDescription, setProcessingDescription] = useState(
    "Normalizing perspective bands, feathering overlap, and exporting a 2:1 panorama.",
  );

  const activeSlot = captureSlots[frames.length];
  const activeBand = CAPTURE_BANDS.find((band) => band.id === activeSlot?.band);
  const currentBandFrames = activeSlot
    ? frames.filter((frame) => frame.band === activeSlot.band).length
    : CAPTURE_COLUMNS;
  const captureComplete = frames.length === TOTAL_CAPTURE_SLOTS;

  const clearAutoTimers = useCallback(() => {
    if (autoIntervalRef.current !== null) {
      window.clearInterval(autoIntervalRef.current);
      autoIntervalRef.current = null;
    }
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    clearAutoTimers();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [clearAutoTimers]);

  useEffect(() => {
    let active = true;
    loadGeneratedRoom()
      .then((savedRoom) => {
        if (active && savedRoom) setRoom(savedRoom);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadingSavedRoom(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraMode("file");
      return;
    }

    setLiveCameraAvailable(true);
    setCameraMode("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (!videoRef.current.videoWidth) {
          await new Promise<void>((resolve) => {
            const video = videoRef.current;
            if (!video) {
              resolve();
              return;
            }
            const ready = () => resolve();
            video.addEventListener("loadeddata", ready, { once: true });
            window.setTimeout(ready, 1500);
          });
        }
      }
      setCameraMode("live");
    } catch {
      setCameraMode("denied");
      setError("Camera preview was blocked. Record one guided scan video with Android’s native camera instead.");
    }
  }, []);

  const beginCapture = () => {
    clearAutoTimers();
    setFrames([]);
    setError(null);
    setAutoScanStatus("idle");
    autoStatusRef.current = "idle";
    bandCaptureCountRef.current = 0;
    activeBandIndexRef.current = 0;
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const addFrame = useCallback((dataUrl: string) => {
    setError(null);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    setFrames((current) => {
      const slot = captureSlots[current.length];
      if (!slot) return current;
      const next = [...current, { ...slot, dataUrl, capturedAt: Date.now() }];
      if (next.length === TOTAL_CAPTURE_SLOTS) stopCamera();
      return next;
    });
  }, [stopCamera]);

  const setAutomaticStatus = useCallback((status: AutoScanStatus) => {
    autoStatusRef.current = status;
    setAutoScanStatus(status);
  }, []);

  const captureAutomaticFrame = useCallback(() => {
    if (!videoRef.current || autoStatusRef.current !== "scanning") return;

    try {
      addFrame(captureVideoFrame(videoRef.current));
      const nextBandCount = bandCaptureCountRef.current + 1;
      bandCaptureCountRef.current = nextBandCount;

      if (nextBandCount >= CAPTURE_COLUMNS) {
        clearAutoTimers();
        if (activeBandIndexRef.current >= CAPTURE_BANDS.length - 1) {
          setAutomaticStatus("complete");
        } else {
          setAutomaticStatus("between");
        }
      }
    } catch (captureError) {
      clearAutoTimers();
      setAutomaticStatus("idle");
      setError(captureError instanceof Error ? captureError.message : "Automatic capture stopped unexpectedly.");
    }
  }, [addFrame, clearAutoTimers, setAutomaticStatus]);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null) return;
      const orientation = orientationRef.current;
      orientation.alpha = event.alpha;
      orientation.lastEventAt = Date.now();

      if (
        autoStatusRef.current !== "scanning" ||
        sensorModeRef.current !== "imu"
      ) {
        return;
      }

      if (orientation.lastAlpha === null) {
        orientation.lastAlpha = event.alpha;
        return;
      }

      orientation.accumulated += getSignedAngleDelta(
        event.alpha,
        orientation.lastAlpha,
      );
      orientation.lastAlpha = event.alpha;

      if (
        hasReachedSweepTarget(
          orientation.accumulated,
          bandCaptureCountRef.current,
        )
      ) {
        captureAutomaticFrame();
      }
    };

    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => window.removeEventListener("deviceorientation", handleOrientation, true);
  }, [captureAutomaticFrame]);

  const startAutomaticSweep = async () => {
    if (cameraMode !== "live" || captureComplete) return;
    clearAutoTimers();
    setError(null);

    try {
      const orientationConstructor = DeviceOrientationEvent as OrientationEventConstructor;
      if (typeof orientationConstructor.requestPermission === "function") {
        await orientationConstructor.requestPermission();
      }
    } catch {
      // Timed capture remains available when motion-sensor permission is denied.
    }

    activeBandIndexRef.current = Math.floor(frames.length / CAPTURE_COLUMNS);
    bandCaptureCountRef.current = frames.length % CAPTURE_COLUMNS;
    orientationRef.current.lastAlpha = null;
    orientationRef.current.accumulated = 0;
    setCountdown(3);
    setAutomaticStatus("countdown");

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

      const mode: SensorMode =
        orientationRef.current.alpha !== null &&
        Date.now() - orientationRef.current.lastEventAt < 1500
          ? "imu"
          : "timed";
      sensorModeRef.current = mode;
      setSensorMode(mode);
      setAutomaticStatus("scanning");
      orientationRef.current.lastAlpha = orientationRef.current.alpha;
      orientationRef.current.accumulated = 0;
      window.setTimeout(() => captureAutomaticFrame(), 80);

      if (mode === "timed") {
        autoIntervalRef.current = window.setInterval(
          captureAutomaticFrame,
          1450,
        );
      }
    }, 1000);
  };

  const importPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      addFrame(await normalizeRoomPhoto(file));
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The photo could not be prepared.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const undoLast = () => {
    clearAutoTimers();
    setFrames((current) => current.slice(0, -1));
    setAutomaticStatus("idle");
    setError(null);
    if (!streamRef.current && cameraMode === "live") void startCamera();
  };

  const assembleRoom = async (
    capturedFrames: readonly CapturedFrame[],
    stitchingStartsAt = 0,
  ) => {
    setStage("processing");
    if (stitchingStartsAt === 0) setProcessingProgress(0);
    setProcessingLabel("Assembling panorama");
    setProcessingDescription(
      "Normalizing perspective bands, feathering overlap, and exporting a 2:1 panorama.",
    );
    setError(null);
    stopCamera();

    try {
      const panorama = await stitchRoomPanorama(capturedFrames, (progress) => {
        setProcessingProgress(
          Math.round(
            stitchingStartsAt +
              progress * ((100 - stitchingStartsAt) / 100),
          ),
        );
      });
      const generatedRoom: GeneratedRoomRecord = {
        id: "latest-room",
        name: roomName.trim() || "My room",
        createdAt: new Date().toISOString(),
        photoCount: capturedFrames.length,
        panorama,
      };
      setRoom(generatedRoom);
      setFrames([]);
      try {
        await saveGeneratedRoom(generatedRoom);
      } catch {
        setError("The panorama is ready, but this browser did not allow persistent local storage.");
      }
      setStage("result");
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : "The room could not be assembled.");
      setStage("capture");
    }
  };

  const importScanVideo = async (file: File | undefined) => {
    if (!file) return;
    setStage("processing");
    setProcessingProgress(0);
    setProcessingLabel("Reading continuous scan");
    setProcessingDescription(
      "Selecting evenly spaced views from your three room sweeps before panorama assembly.",
    );
    setError(null);
    stopCamera();

    try {
      const extractedFrames = await extractFramesFromScanVideo(file, (progress) => {
        setProcessingProgress(Math.round(progress * 0.42));
      });
      setFrames(extractedFrames);
      await assembleRoom(extractedFrames, 42);
    } catch (videoError) {
      setError(videoError instanceof Error ? videoError.message : "The scan video could not be processed.");
      setStage("capture");
      setCameraMode("file");
    } finally {
      if (videoFileInputRef.current) videoFileInputRef.current.value = "";
    }
  };

  const resetStudio = async () => {
    stopCamera();
    setFrames([]);
    setRoom(null);
    setStage("intro");
    setCameraMode("idle");
    setAutomaticStatus("idle");
    setError(null);
    try {
      await deleteGeneratedRoom();
    } catch {
      // The in-memory reset still succeeds when private browsing blocks IndexedDB.
    }
  };

  const bandCompletion = useMemo(
    () => CAPTURE_BANDS.map((band) => ({
      ...band,
      count: frames.filter((frame) => frame.band === band.id).length,
    })),
    [frames],
  );

  return (
    <div className={styles.studioShell}>
      <header className={styles.studioHeader}>
        <Link href="/" aria-label="Astra3D home"><BrandMark /></Link>
        <div><span /> Room Capture Lab · local MVP</div>
        <Link href="/" className={styles.backLink}><ArrowLeft aria-hidden="true" /> Back to site</Link>
      </header>

      <main className={styles.studioMain}>
        {stage === "intro" ? (
          <section className={styles.intro} aria-labelledby="studio-title">
            <div className={styles.introCopy}>
              <p className={styles.kicker}><ScanLine aria-hidden="true" /> Single-room capture</p>
              <h1 id="studio-title">Scan once. Look around forever.</h1>
              <p>
                Stand in one fixed spot and rotate through three guided sweeps. Astra3D watches the live camera and motion sensors, captures useful views automatically, and builds your 360° room.
              </p>

              <label className={styles.roomNameField}>
                <span>Room name</span>
                <input
                  value={roomName}
                  maxLength={48}
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="Living room"
                />
              </label>

              <button className={styles.primaryButton} type="button" onClick={beginCapture}>
                <Camera aria-hidden="true" /> Start room scan <ChevronRight aria-hidden="true" />
              </button>

              {!loadingSavedRoom && room ? (
                <button className={styles.savedRoomButton} type="button" onClick={() => setStage("result")}>
                  <span><Check aria-hidden="true" /></span>
                  <span><strong>Open saved room</strong><small>{room.name} · {room.photoCount} photos</small></span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className={styles.captureBlueprint} aria-label="Capture process overview">
              <div className={styles.blueprintPhone}>
                <span className={styles.phoneCamera} />
                <div><ScanLine aria-hidden="true" /><strong>Auto</strong><small>continuous capture</small></div>
              </div>
              <div className={styles.orbitRing} aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => <i key={index} style={{ "--index": index } as React.CSSProperties} />)}
              </div>
              <div className={styles.blueprintStats}>
                <span><CircleGauge aria-hidden="true" /><strong>3 bands</strong><small>upper · eye · lower</small></span>
                <span><Sparkles aria-hidden="true" /><strong>Local blend</strong><small>4096 × 2048 output</small></span>
              </div>
            </div>

            <div className={styles.preflight}>
              <article><strong>01 · Pick the center</strong><p>Stand near the center and keep your feet in exactly one place.</p></article>
              <article><strong>02 · Follow the sweep</strong><p>Use portrait orientation and rotate slowly clockwise while Astra3D captures automatically.</p></article>
              <article><strong>03 · Three simple passes</strong><p>Scan once at eye level, once tilted upward, and once tilted downward.</p></article>
            </div>

            <div className={styles.privacyBanner}>
              <LockKeyhole aria-hidden="true" />
              <div><strong>Your scan stays on this device</strong><p>No video upload, account, cloud processing, or analytics are used by this capture MVP.</p></div>
            </div>
          </section>
        ) : null}

        {stage === "capture" ? (
          <section className={styles.captureStage} aria-labelledby="capture-title">
            <div className={styles.captureTopbar}>
              <button type="button" onClick={() => { stopCamera(); setStage("intro"); }}>
                <ArrowLeft aria-hidden="true" /> Exit scan
              </button>
              <div>
                <span>Room progress</span>
                <strong>{frames.length} / {TOTAL_CAPTURE_SLOTS}</strong>
              </div>
              <div className={styles.progressTrack} aria-label={`${getCaptureProgress(frames.length)} percent captured`}>
                <span style={{ width: `${getCaptureProgress(frames.length)}%` }} />
              </div>
            </div>

            <div className={styles.captureWorkspace}>
              <div className={styles.cameraPanel}>
                <div className={styles.cameraViewport} data-flash={flash}>
                  {cameraMode === "live" || cameraMode === "requesting" ? (
                    <video ref={videoRef} autoPlay muted playsInline aria-label="Rear camera preview" />
                  ) : (
                    <div className={styles.fileCameraFallback}>
                      <Video aria-hidden="true" />
                      <strong>{cameraMode === "denied" ? "Live preview blocked" : "One-video scan"}</strong>
                      <p>Record three slow rotations in one video: eye level, tilted up, then tilted down. Astra3D extracts the useful views automatically.</p>
                    </div>
                  )}
                  <div className={styles.cameraGrid} aria-hidden="true"><i /><i /></div>
                  <div className={styles.levelGuide} aria-hidden="true"><span /></div>
                  {activeBand ? (
                    <div className={styles.cameraInstruction}>
                      <span>{activeBand.label} · {activeBand.tilt}</span>
                      <strong>Direction {Math.min(currentBandFrames + 1, CAPTURE_COLUMNS)} of {CAPTURE_COLUMNS}</strong>
                    </div>
                  ) : null}
                  {cameraMode === "requesting" ? <p className={styles.cameraLoading}>Starting rear camera…</p> : null}
                  {cameraMode === "live" && autoScanStatus !== "idle" ? (
                    <div className={styles.autoCaptureState} data-status={autoScanStatus}>
                      {autoScanStatus === "countdown" ? (
                        <><span>Starting sweep</span><strong>{countdown}</strong><small>Hold your starting direction.</small></>
                      ) : autoScanStatus === "scanning" ? (
                        <><span>{sensorMode === "imu" ? "IMU angle tracking" : "Timed auto capture"}</span><strong>Rotate slowly clockwise</strong><small>The shutter is automatic · {currentBandFrames} / {CAPTURE_COLUMNS}</small></>
                      ) : autoScanStatus === "between" ? (
                        <><span>Sweep complete</span><strong>{activeBand?.label} is next</strong><small>{activeBand?.instruction}</small></>
                      ) : autoScanStatus === "complete" ? (
                        <><span>Coverage complete</span><strong>Ready to build</strong><small>All three room sweeps are captured.</small></>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className={styles.directionRing} aria-label="Current rotation coverage">
                  <div><span style={{ transform: `rotate(${activeSlot?.yaw ?? 360}deg)` }} /></div>
                  {Array.from({ length: CAPTURE_COLUMNS }, (_, index) => {
                    const captured = index < currentBandFrames || captureComplete;
                    const current = index === currentBandFrames && !captureComplete;
                    return <i key={index} data-captured={captured} data-current={current} style={{ "--index": index } as React.CSSProperties}>{captured ? <Check aria-hidden="true" /> : index + 1}</i>;
                  })}
                  <strong>{activeBand?.label ?? "Complete"}</strong>
                  <small>{activeBand?.instruction ?? "All room angles captured."}</small>
                </div>

                <div className={styles.captureControls}>
                  <button
                    type="button"
                    onClick={undoLast}
                    disabled={frames.length === 0 || autoScanStatus === "countdown" || autoScanStatus === "scanning"}
                    aria-label="Retake previous captured view"
                  >
                    <RotateCcw aria-hidden="true" /> Retake
                  </button>
                  {!captureComplete ? (
                    cameraMode === "live" ? (
                      <button
                        className={styles.fileCaptureButton}
                        type="button"
                        onClick={() => void startAutomaticSweep()}
                        disabled={autoScanStatus === "countdown" || autoScanStatus === "scanning"}
                      >
                        <ScanLine aria-hidden="true" />
                        {autoScanStatus === "countdown"
                          ? `Starting in ${countdown}`
                          : autoScanStatus === "scanning"
                            ? "Capturing automatically"
                            : frames.length === 0
                              ? "Start automatic sweep"
                              : "Start next sweep"}
                      </button>
                    ) : (
                      <button className={styles.fileCaptureButton} type="button" onClick={() => videoFileInputRef.current?.click()}>
                        <Video aria-hidden="true" /> Record guided video
                      </button>
                    )
                  ) : (
                    <button className={styles.buildButton} type="button" onClick={() => void assembleRoom(frames)}>
                      <Sparkles aria-hidden="true" /> Build my 360
                    </button>
                  )}
                  <span className={styles.controlSpacer} aria-hidden="true" />
                </div>

                <input
                  ref={fileInputRef}
                  className={styles.hiddenInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => void importPhoto(event.target.files?.[0])}
                />
                <input
                  ref={videoFileInputRef}
                  className={styles.hiddenInput}
                  type="file"
                  accept="video/*"
                  capture="environment"
                  onChange={(event) => void importScanVideo(event.target.files?.[0])}
                />
              </div>

              <aside className={styles.captureRail}>
                <p className={styles.kicker}>Coverage map</p>
                <h1 id="capture-title">Rotate. We capture.</h1>
                <p>Complete three slow sweeps from the same standing point. The app selects eight overlapping directions from every layer.</p>
                <div className={styles.bandList}>
                  {bandCompletion.map((band) => (
                    <div key={band.id} data-active={band.id === activeSlot?.band} data-complete={band.count === CAPTURE_COLUMNS}>
                      <span>{band.count === CAPTURE_COLUMNS ? <Check aria-hidden="true" /> : band.tilt}</span>
                      <div><strong>{band.label}</strong><small>{band.count} / {CAPTURE_COLUMNS} views</small></div>
                      <i><b style={{ width: `${(band.count / CAPTURE_COLUMNS) * 100}%` }} /></i>
                    </div>
                  ))}
                </div>
                <div className={styles.scanTip}>
                  <strong>For cleaner seams</strong>
                  <p>Take roughly 10–12 seconds per rotation and keep the phone lens over the same invisible center point.</p>
                </div>
                {error ? <p className={styles.errorMessage} role="alert">{error}</p> : null}
                {(cameraMode === "denied" || cameraMode === "file") && !captureComplete ? (
                  <button className={styles.retryCamera} type="button" onClick={() => fileInputRef.current?.click()}>
                    <ImagePlus aria-hidden="true" /> Use individual photos instead
                  </button>
                ) : null}
                {(cameraMode === "denied" || cameraMode === "file") && liveCameraAvailable ? (
                  <button className={styles.retryCamera} type="button" onClick={() => void startCamera()}>
                    <Camera aria-hidden="true" /> Retry live camera
                  </button>
                ) : null}
              </aside>
            </div>
          </section>
        ) : null}

        {stage === "processing" ? (
          <section className={styles.processing} aria-labelledby="processing-title">
            <div
              className={styles.processingOrb}
              style={{ "--progress": `${processingProgress * 3.6}deg` } as React.CSSProperties}
            >
              <ScanLine aria-hidden="true" /><span />
            </div>
            <p className={styles.kicker}>{processingLabel}</p>
            <h1 id="processing-title">Building {roomName.trim() || "your room"}…</h1>
            <p>{processingDescription}</p>
            <div className={styles.processingTrack}><span style={{ width: `${processingProgress}%` }} /></div>
            <strong>{processingProgress}%</strong>
            <small>Keep this tab open. No images are being uploaded.</small>
          </section>
        ) : null}

        {stage === "result" && room ? <GeneratedRoomViewer room={room} onRetake={() => void resetStudio()} /> : null}
      </main>
    </div>
  );
}
