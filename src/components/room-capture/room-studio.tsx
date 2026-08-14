"use client";

import {
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  CircleGauge,
  LockKeyhole,
  RotateCcw,
  ScanLine,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import type { CapturedFrame, GeneratedRoomRecord } from "@/types/capture";

import {
  buildCaptureSlots,
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  captureLiveStill,
  getCaptureProgress,
  getSignedAngleDelta,
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
type CameraMode = "idle" | "requesting" | "live" | "denied";
type AutoScanStatus = "idle" | "countdown" | "scanning" | "between" | "complete";
type SensorMode = "imu" | "manual";

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const captureSlots = buildCaptureSlots();

export function RoomStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const autoStatusRef = useRef<AutoScanStatus>("idle");
  const sensorModeRef = useRef<SensorMode>("manual");
  const bandCaptureCountRef = useRef(0);
  const activeBandIndexRef = useRef(0);
  const orientationRef = useRef({
    alpha: null as number | null,
    lastAlpha: null as number | null,
    accumulated: 0,
    lastEventAt: 0,
    baselineBeta: null as number | null,
    lastBeta: null as number | null,
    alignmentStartedAt: null as number | null,
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
  const [sensorMode, setSensorMode] = useState<SensorMode>("manual");
  const [countdown, setCountdown] = useState(3);
  const [guidance, setGuidance] = useState({
    aligned: false,
    holdProgress: 0,
    pitchError: 0,
    yawError: 0,
  });

  const activeSlot = captureSlots[frames.length];
  const activeBand = CAPTURE_BANDS.find((band) => band.id === activeSlot?.band);
  const currentBandFrames = activeSlot
    ? frames.filter((frame) => frame.band === activeSlot.band).length
    : CAPTURE_COLUMNS;
  const captureComplete = frames.length === TOTAL_CAPTURE_SLOTS;

  const clearAutoTimers = useCallback(() => {
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
      setCameraMode("denied");
      setError("Live scanning needs HTTPS or localhost. Open this page through a secure phone connection to use the in-app camera.");
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
      setError("Camera access was blocked. Allow camera and motion access in the browser, then retry.");
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
      addFrame(captureLiveStill(videoRef.current));
      const nextBandCount = bandCaptureCountRef.current + 1;
      bandCaptureCountRef.current = nextBandCount;
      orientationRef.current.alignmentStartedAt = null;
      setGuidance((current) => ({
        ...current,
        aligned: false,
        holdProgress: 0,
      }));

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
        orientation.lastBeta = event.beta;
        return;
      }

      const yawDelta = getSignedAngleDelta(
        event.alpha,
        orientation.lastAlpha,
      );
      const betaDelta =
        event.beta !== null && orientation.lastBeta !== null
          ? event.beta - orientation.lastBeta
          : 0;
      orientation.accumulated += yawDelta;
      orientation.lastAlpha = event.alpha;
      orientation.lastBeta = event.beta;

      if (orientation.baselineBeta === null && event.beta !== null) {
        orientation.baselineBeta = event.beta;
      }

      const yawTarget = bandCaptureCountRef.current * (360 / CAPTURE_COLUMNS);
      const yawError = yawTarget - Math.abs(orientation.accumulated);
      const pitchTarget = activeBandIndexRef.current === 1
        ? -35
        : activeBandIndexRef.current === 2
          ? 35
          : 0;
      const relativePitch =
        event.beta !== null && orientation.baselineBeta !== null
          ? event.beta - orientation.baselineBeta
          : pitchTarget;
      const pitchError = pitchTarget - relativePitch;
      const aligned = Math.abs(yawError) <= 5.5 && Math.abs(pitchError) <= 12;
      const moving = Math.abs(yawDelta) > 1.1 || Math.abs(betaDelta) > 1.1;

      if (!aligned || moving) {
        orientation.alignmentStartedAt = null;
      } else if (orientation.alignmentStartedAt === null) {
        orientation.alignmentStartedAt = performance.now();
      }

      const holdProgress = orientation.alignmentStartedAt === null
        ? 0
        : Math.min(1, (performance.now() - orientation.alignmentStartedAt) / 650);

      setGuidance({ aligned, holdProgress, pitchError, yawError });

      if (holdProgress >= 1) {
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
      // Manual target-by-target capture remains available without motion access.
    }

    activeBandIndexRef.current = Math.floor(frames.length / CAPTURE_COLUMNS);
    bandCaptureCountRef.current = frames.length % CAPTURE_COLUMNS;
    orientationRef.current.lastAlpha = null;
    orientationRef.current.lastBeta = null;
    orientationRef.current.accumulated = 0;
    orientationRef.current.alignmentStartedAt = null;
    setGuidance({ aligned: false, holdProgress: 0, pitchError: 0, yawError: 0 });
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
          : "manual";
      sensorModeRef.current = mode;
      setSensorMode(mode);
      setAutomaticStatus("scanning");
      orientationRef.current.lastAlpha = orientationRef.current.alpha;
      orientationRef.current.lastBeta = orientationRef.current.baselineBeta;
      orientationRef.current.accumulated = 0;
    }, 1000);
  };

  const undoLast = () => {
    clearAutoTimers();
    setFrames((current) => current.slice(0, -1));
    setAutomaticStatus("idle");
    setError(null);
    if (!streamRef.current && cameraMode === "live") void startCamera();
  };

  const assembleRoom = async (capturedFrames: readonly CapturedFrame[]) => {
    if (capturedFrames.length !== TOTAL_CAPTURE_SLOTS) {
      setError("Complete eye level, +35°, and −35° before finalizing the room.");
      return;
    }
    setStage("processing");
    setProcessingProgress(0);
    setError(null);
    stopCamera();

    try {
      const panorama = await stitchRoomPanorama(capturedFrames, (progress) => {
        setProcessingProgress(progress);
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
  const targetStyle = {
    "--hold-progress": `${guidance.holdProgress * 360}deg`,
    "--target-x": `${Math.max(-1, Math.min(1, guidance.yawError / 45)) * 34}vw`,
    "--target-y": `${Math.max(-1, Math.min(1, guidance.pitchError / 35)) * 24}vh`,
  } as React.CSSProperties;

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
                <div><ScanLine aria-hidden="true" /><strong>Live</strong><small>guided still capture</small></div>
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
                      <LockKeyhole aria-hidden="true" />
                      <strong>Secure live camera required</strong>
                      <p>This scanner does not record or upload video. Open Astra3D through HTTPS or phone localhost so the guided camera can remain inside the app.</p>
                    </div>
                  )}
                  <div className={styles.cameraGrid} aria-hidden="true"><i /><i /></div>
                  {cameraMode === "live" ? <div className={styles.levelGuide} aria-hidden="true"><span /></div> : null}
                  {activeBand ? (
                    <div className={styles.cameraInstruction}>
                      <span>{activeBand.label} · {activeBand.tilt}</span>
                      <strong>Direction {Math.min(currentBandFrames + 1, CAPTURE_COLUMNS)} of {CAPTURE_COLUMNS}</strong>
                    </div>
                  ) : null}
                  {cameraMode === "requesting" ? <p className={styles.cameraLoading}>Starting rear camera…</p> : null}
                  {cameraMode === "live" && autoScanStatus === "scanning" ? (
                    <div className={styles.liveTargetGuide} aria-hidden="true">
                      <div className={styles.centerLock}><i /><i /><i /><i /></div>
                      {sensorMode === "imu" ? (
                        <div
                          className={styles.targetMarker}
                          data-aligned={guidance.aligned}
                          style={targetStyle}
                        >
                          <span />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {cameraMode === "live" && autoScanStatus !== "idle" ? (
                    <div className={styles.autoCaptureState} data-status={autoScanStatus}>
                      {autoScanStatus === "countdown" ? (
                        <><span>Starting sweep</span><strong>{countdown}</strong><small>Hold your starting direction.</small></>
                      ) : autoScanStatus === "scanning" ? (
                        sensorMode === "imu" ? (
                          <><span>Target {currentBandFrames + 1} of {CAPTURE_COLUMNS}</span><strong>{guidance.aligned ? "Hold steady" : "Move the ring into the center"}</strong><small>{guidance.aligned ? "Capturing automatically…" : `${activeBand?.label} · ${activeBand?.tilt}`}</small></>
                        ) : (
                          <><span>Live target capture</span><strong>Align the center frame</strong><small>Motion data is unavailable; use the capture button for this target.</small></>
                        )
                      ) : autoScanStatus === "between" ? (
                        <><span>Sweep complete</span><strong>{activeBand?.label} is next</strong><small>{activeBand?.instruction}</small></>
                      ) : autoScanStatus === "complete" ? (
                        <><span>Coverage complete</span><strong>Ready to build</strong><small>All three room sweeps are captured.</small></>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className={styles.directionRing} aria-label="Current rotation coverage">
                  <div className={styles.directionDial}>
                    <div>
                      <span
                        style={{
                          "--direction-angle": `${activeSlot?.yaw ?? 360}deg`,
                        } as React.CSSProperties}
                      />
                    </div>
                    {Array.from({ length: CAPTURE_COLUMNS }, (_, index) => {
                      const captured = index < currentBandFrames || captureComplete;
                      const current = index === currentBandFrames && !captureComplete;
                      return <i key={index} data-captured={captured} data-current={current} style={{ "--index": index } as React.CSSProperties}>{captured ? <Check aria-hidden="true" /> : index + 1}</i>;
                    })}
                  </div>
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
                        onClick={() => {
                          if (autoScanStatus === "scanning" && sensorMode === "manual") {
                            captureAutomaticFrame();
                          } else {
                            void startAutomaticSweep();
                          }
                        }}
                        disabled={autoScanStatus === "countdown" || (autoScanStatus === "scanning" && sensorMode === "imu")}
                      >
                        {autoScanStatus === "scanning" && sensorMode === "manual" ? <Camera aria-hidden="true" /> : <ScanLine aria-hidden="true" />}
                        {autoScanStatus === "countdown"
                          ? `Starting in ${countdown}`
                          : autoScanStatus === "scanning"
                            ? sensorMode === "imu"
                              ? "Live guidance active"
                              : `Capture target ${currentBandFrames + 1}`
                            : frames.length === 0
                              ? "Begin eye-level capture"
                              : `Begin ${activeBand?.tilt} capture`}
                      </button>
                    ) : (
                      <button className={styles.fileCaptureButton} type="button" disabled>
                        <LockKeyhole aria-hidden="true" /> Secure connection required
                      </button>
                    )
                  ) : (
                    <button className={styles.buildButton} type="button" onClick={() => void assembleRoom(frames)}>
                      <Sparkles aria-hidden="true" /> Build my 360
                    </button>
                  )}
                  <span className={styles.controlSpacer} aria-hidden="true" />
                </div>

              </div>

              <aside className={styles.captureRail}>
                <p className={styles.kicker}>Coverage map</p>
                <h1 id="capture-title">Rotate. We capture.</h1>
                <p>Follow one live target at a time. Center the ring, hold still, and Astra3D saves a photo automatically without recording video.</p>
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
                  <p>Move only when the next target appears. Keep the phone lens over the same invisible center point.</p>
                </div>
                {error ? <p className={styles.errorMessage} role="alert">{error}</p> : null}
                {cameraMode === "denied" && liveCameraAvailable ? (
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
            <p className={styles.kicker}>On-device panorama assembly</p>
            <h1 id="processing-title">Building {roomName.trim() || "your room"}…</h1>
            <p>Normalizing the three completed bands, feathering overlap, and exporting a 2:1 panorama.</p>
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
