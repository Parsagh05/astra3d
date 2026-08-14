"use client";

import {
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  CircleGauge,
  LockKeyhole,
  Minus,
  Plus,
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
type CaptureMode = "automatic" | "manual";
type CameraLens = { deviceId: string; label: string };
type ZoomRange = { min: number; max: number; step: number; hardware: boolean };

type ExtendedTrackCapabilities = MediaTrackCapabilities & {
  zoom?: { min?: number; max?: number; step?: number };
};

type ExtendedTrackSettings = MediaTrackSettings & { zoom?: number };
type ZoomConstraint = MediaTrackConstraintSet & { zoom: number };

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const captureSlots = buildCaptureSlots();
const defaultZoomRange: ZoomRange = { min: 1, max: 1.4, step: 0.1, hardware: false };

function getCameraLabel(device: MediaDeviceInfo, index: number) {
  const label = device.label.trim();
  const normalized = label.toLowerCase();
  if (/ultra|0[.,]5|0[.,]6/.test(normalized)) return "0.6× Ultra";
  if (/tele|zoom/.test(normalized)) return "Telephoto";
  if (/front|user|selfie/.test(normalized)) return "Front camera";
  return label || `Camera ${index + 1}`;
}

export function RoomStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const autoStatusRef = useRef<AutoScanStatus>("idle");
  const captureModeRef = useRef<CaptureMode>("automatic");
  const retakeSequenceRef = useRef<number | null>(null);
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
  const [captureMode, setCaptureMode] = useState<CaptureMode>("automatic");
  const [retakeSequence, setRetakeSequence] = useState<number | null>(null);
  const [captureZoom, setCaptureZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState<ZoomRange>(defaultZoomRange);
  const [cameraLenses, setCameraLenses] = useState<CameraLens[]>([]);
  const [activeCameraId, setActiveCameraId] = useState("");
  const [countdown, setCountdown] = useState(3);
  const [guidance, setGuidance] = useState({
    aligned: false,
    holdProgress: 0,
    pitchError: 0,
    yawError: 0,
  });

  const nextSlot = captureSlots[frames.length];
  const activeSlot = retakeSequence === null
    ? nextSlot
    : captureSlots[retakeSequence];
  const activeBand = CAPTURE_BANDS.find((band) => band.id === activeSlot?.band);
  const currentBandFrames = activeSlot
    ? frames.filter((frame) => frame.band === activeSlot.band).length
    : CAPTURE_COLUMNS;
  const activeDirection = retakeSequence === null
    ? currentBandFrames
    : activeSlot?.column ?? 0;
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

  const startCamera = useCallback(async (requestedDeviceId?: string) => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCameraMode("denied");
      setError("Live scanning needs HTTPS or localhost. Open this page through a secure phone connection to use the in-app camera.");
      return false;
    }

    setLiveCameraAvailable(true);
    setCameraMode("requesting");
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(requestedDeviceId
            ? { deviceId: { exact: requestedDeviceId } }
            : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
      });
      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack?.getCapabilities?.() as ExtendedTrackCapabilities | undefined;
      const settings = videoTrack?.getSettings?.() as ExtendedTrackSettings | undefined;
      const hardwareZoom = capabilities?.zoom;
      const hardwareMin = Number(hardwareZoom?.min);
      const hardwareMax = Number(hardwareZoom?.max);
      const supportsHardwareZoom = Number.isFinite(hardwareMin) &&
        Number.isFinite(hardwareMax) &&
        hardwareMax >= hardwareMin &&
        hardwareMin <= 1.4 &&
        hardwareMax >= 0.6;
      const nextZoomRange: ZoomRange = supportsHardwareZoom
        ? {
            min: Math.max(0.6, hardwareMin),
            max: Math.min(1.4, hardwareMax),
            step: Math.max(0.1, Number(hardwareZoom?.step) || 0.1),
            hardware: true,
          }
        : defaultZoomRange;
      const requestedZoom = Number(settings?.zoom);
      const initialZoom = Number.isFinite(requestedZoom)
        ? Math.max(nextZoomRange.min, Math.min(nextZoomRange.max, requestedZoom))
        : Math.max(nextZoomRange.min, Math.min(nextZoomRange.max, 1));
      setZoomRange(nextZoomRange);
      setCaptureZoom(Number(initialZoom.toFixed(1)));

      const currentDeviceId = settings?.deviceId || requestedDeviceId || "";
      setActiveCameraId(currentDeviceId);
      if (navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === "videoinput");
        const nonFrontCameras = cameras.filter((device) =>
          !/front|user|selfie/i.test(device.label),
        );
        const selectableCameras = nonFrontCameras.length > 0 ? nonFrontCameras : cameras;
        setCameraLenses(selectableCameras.map((device, index) => ({
          deviceId: device.deviceId,
          label: getCameraLabel(device, index),
        })));
      } else {
        setCameraLenses([]);
      }
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
      return true;
    } catch {
      setCameraMode("denied");
      setError("Camera access was blocked. Allow camera and motion access in the browser, then retry.");
      return false;
    }
  }, []);

  const changeCaptureZoom = async (direction: -1 | 1) => {
    const nextZoom = Math.max(
      zoomRange.min,
      Math.min(
        zoomRange.max,
        Number((captureZoom + direction * zoomRange.step).toFixed(1)),
      ),
    );
    if (nextZoom === captureZoom) return;

    if (zoomRange.hardware) {
      const track = streamRef.current?.getVideoTracks()[0];
      try {
        await track?.applyConstraints({
          advanced: [{ zoom: nextZoom } as ZoomConstraint],
        });
      } catch {
        setError("This browser reported camera zoom but could not apply that level.");
        return;
      }
    }
    setCaptureZoom(nextZoom);
  };

  const switchCameraLens = async (deviceId: string) => {
    if (!deviceId || deviceId === activeCameraId || frames.length > 0) return;
    clearAutoTimers();
    setAutomaticStatus("idle");
    await startCamera(deviceId);
  };

  const beginCapture = () => {
    clearAutoTimers();
    setFrames([]);
    setError(null);
    setAutoScanStatus("idle");
    autoStatusRef.current = "idle";
    retakeSequenceRef.current = null;
    setRetakeSequence(null);
    captureModeRef.current = "automatic";
    setCaptureMode("automatic");
    setCaptureZoom(1);
    setZoomRange(defaultZoomRange);
    setCameraLenses([]);
    setActiveCameraId("");
    bandCaptureCountRef.current = 0;
    activeBandIndexRef.current = 0;
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const addFrame = useCallback((dataUrl: string) => {
    const replacementSequence = retakeSequenceRef.current;
    retakeSequenceRef.current = null;
    setRetakeSequence(null);
    setError(null);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    setFrames((current) => {
      const slot = captureSlots[replacementSequence ?? current.length];
      if (!slot) return current;
      const capturedFrame = { ...slot, dataUrl, capturedAt: Date.now() };
      const next = replacementSequence === null
        ? [...current, capturedFrame]
        : current.map((frame) => frame.sequence === replacementSequence ? capturedFrame : frame);
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
      const isRetaking = retakeSequenceRef.current !== null;
      addFrame(captureLiveStill(
        videoRef.current,
        zoomRange.hardware ? 1 : captureZoom,
      ));
      if (isRetaking) {
        setAutomaticStatus(captureComplete ? "complete" : "scanning");
        return;
      }
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
  }, [addFrame, captureComplete, captureZoom, clearAutoTimers, setAutomaticStatus, zoomRange.hardware]);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null) return;
      const orientation = orientationRef.current;
      orientation.alpha = event.alpha;
      orientation.lastEventAt = Date.now();

      if (
        autoStatusRef.current !== "scanning" ||
        captureModeRef.current !== "automatic"
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

    activeBandIndexRef.current = Math.floor(frames.length / CAPTURE_COLUMNS);
    bandCaptureCountRef.current = frames.length % CAPTURE_COLUMNS;
    orientationRef.current.lastAlpha = null;
    orientationRef.current.lastBeta = null;
    orientationRef.current.accumulated = 0;
    orientationRef.current.alignmentStartedAt = null;
    setGuidance({ aligned: false, holdProgress: 0, pitchError: 0, yawError: 0 });

    if (captureMode === "manual") {
      captureModeRef.current = "manual";
      setAutomaticStatus("scanning");
      return;
    }

    try {
      const orientationConstructor = DeviceOrientationEvent as OrientationEventConstructor;
      if (typeof orientationConstructor.requestPermission === "function") {
        await orientationConstructor.requestPermission();
      }
    } catch {
      // Manual target-by-target capture remains available without motion access.
    }

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

      const motionAvailable = orientationRef.current.alpha !== null &&
        Date.now() - orientationRef.current.lastEventAt < 1500;
      const mode: CaptureMode = motionAvailable ? "automatic" : "manual";
      captureModeRef.current = mode;
      setCaptureMode(mode);
      if (!motionAvailable) {
        setError("Motion guidance is unavailable, so capture switched to Manual. Align each target and tap the shutter.");
      }
      setAutomaticStatus("scanning");
      orientationRef.current.lastAlpha = orientationRef.current.alpha;
      orientationRef.current.lastBeta = orientationRef.current.baselineBeta;
      orientationRef.current.accumulated = 0;
    }, 1000);
  };

  const selectCaptureMode = (mode: CaptureMode) => {
    clearAutoTimers();
    setCaptureMode(mode);
    captureModeRef.current = mode;
    setError(null);
    orientationRef.current.alignmentStartedAt = null;
    setGuidance({ aligned: false, holdProgress: 0, pitchError: 0, yawError: 0 });

    if (autoScanStatus === "countdown" || autoScanStatus === "scanning") {
      if (mode === "manual") {
        setAutomaticStatus("scanning");
        return;
      }

      const motionAvailable = orientationRef.current.alpha !== null &&
        Date.now() - orientationRef.current.lastEventAt < 1500;
      if (!motionAvailable) {
        captureModeRef.current = "manual";
        setCaptureMode("manual");
        setAutomaticStatus("scanning");
        setError("Automatic capture needs phone motion data. Manual capture is still ready.");
        return;
      }

      activeBandIndexRef.current = Math.floor(frames.length / CAPTURE_COLUMNS);
      bandCaptureCountRef.current = frames.length % CAPTURE_COLUMNS;
      orientationRef.current.lastAlpha = orientationRef.current.alpha;
      orientationRef.current.lastBeta = orientationRef.current.baselineBeta;
      orientationRef.current.accumulated = bandCaptureCountRef.current * (360 / CAPTURE_COLUMNS);
      setAutomaticStatus("scanning");
    }
  };

  const beginRetake = async (sequence: number) => {
    if (!frames.some((frame) => frame.sequence === sequence)) return;
    clearAutoTimers();
    retakeSequenceRef.current = sequence;
    setRetakeSequence(sequence);
    captureModeRef.current = "manual";
    setCaptureMode("manual");
    setError(null);
    const slot = captureSlots[sequence];
    activeBandIndexRef.current = CAPTURE_BANDS.findIndex((band) => band.id === slot.band);
    bandCaptureCountRef.current = slot.column;
    const cameraReady = streamRef.current ? true : await startCamera();
    if (cameraReady) setAutomaticStatus("scanning");
  };

  const retakePrevious = () => {
    const previous = frames.at(-1);
    if (previous) void beginRetake(previous.sequence);
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
    retakeSequenceRef.current = null;
    setRetakeSequence(null);
    captureModeRef.current = "automatic";
    setCaptureMode("automatic");
    setCaptureZoom(1);
    setZoomRange(defaultZoomRange);
    setCameraLenses([]);
    setActiveCameraId("");
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
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Room capture progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={getCaptureProgress(frames.length)}
              >
                <span style={{ width: `${getCaptureProgress(frames.length)}%` }} />
              </div>
            </div>

            <div className={styles.captureWorkspace}>
              <div className={styles.cameraPanel}>
                <div className={styles.cameraViewport} data-flash={flash}>
                  {cameraMode === "live" || cameraMode === "requesting" ? (
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                      aria-label="Rear camera preview"
                      style={{
                        "--capture-zoom": zoomRange.hardware ? 1 : captureZoom,
                      } as React.CSSProperties}
                    />
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
                      <strong>{retakeSequence === null ? "Direction" : "Retaking direction"} {Math.min(activeDirection + 1, CAPTURE_COLUMNS)} of {CAPTURE_COLUMNS}</strong>
                    </div>
                  ) : null}
                  {cameraMode === "live" ? (
                    <div className={styles.captureZoom} role="group" aria-label="Capture zoom">
                      <button
                        type="button"
                        aria-label="Zoom out"
                        disabled={captureZoom <= zoomRange.min}
                        onClick={() => void changeCaptureZoom(-1)}
                      >
                        <Minus aria-hidden="true" />
                      </button>
                      <output aria-live="polite">{captureZoom.toFixed(1)}×</output>
                      <button
                        type="button"
                        aria-label="Zoom in"
                        disabled={captureZoom >= zoomRange.max}
                        onClick={() => void changeCaptureZoom(1)}
                      >
                        <Plus aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                  {cameraMode === "live" && cameraLenses.length > 1 ? (
                    <label className={styles.lensPicker}>
                      <span>Camera lens</span>
                      <select
                        aria-label="Camera lens"
                        value={activeCameraId || cameraLenses[0]?.deviceId}
                        disabled={frames.length > 0}
                        onChange={(event) => void switchCameraLens(event.target.value)}
                      >
                        {cameraLenses.map((lens) => (
                          <option key={lens.deviceId} value={lens.deviceId}>{lens.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {cameraMode === "requesting" ? <p className={styles.cameraLoading}>Starting rear camera…</p> : null}
                  {cameraMode === "live" && autoScanStatus === "scanning" ? (
                    <div className={styles.liveTargetGuide} aria-hidden="true">
                      <div className={styles.centerLock}><i /><i /><i /><i /></div>
                      {captureMode === "automatic" ? (
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
                        captureMode === "automatic" ? (
                          <><span>Target {activeDirection + 1} of {CAPTURE_COLUMNS}</span><strong>{guidance.aligned ? "Hold steady" : "Move the ring into the center"}</strong><small>{guidance.aligned ? "Capturing automatically…" : `${activeBand?.label} · ${activeBand?.tilt}`}</small></>
                        ) : (
                          <><span>{retakeSequence === null ? "Manual target capture" : "Retake selected angle"}</span><strong>Align the center frame</strong><small>Tap the shutter only when this view looks right.</small></>
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
                      const captured = frames.some((frame) => frame.band === activeSlot?.band && frame.column === index);
                      const current = index === activeDirection;
                      return <i key={index} data-captured={captured} data-current={current} style={{ "--index": index } as React.CSSProperties}>{captured ? <Check aria-hidden="true" /> : index + 1}</i>;
                    })}
                  </div>
                  <strong>{activeBand?.label ?? "Complete"}</strong>
                  <small>{activeBand?.instruction ?? "All room angles captured."}</small>
                </div>

                <div className={styles.captureControls}>
                  <button
                    type="button"
                    onClick={retakePrevious}
                    disabled={frames.length === 0 || retakeSequence !== null || autoScanStatus === "countdown" || (autoScanStatus === "scanning" && captureMode === "automatic")}
                    aria-label="Retake previous captured view"
                  >
                    <RotateCcw aria-hidden="true" /> Retake
                  </button>
                  {!captureComplete || retakeSequence !== null ? (
                    cameraMode === "live" ? (
                      <button
                        className={styles.fileCaptureButton}
                        type="button"
                        onClick={() => {
                          if (autoScanStatus === "scanning" && captureMode === "manual") {
                            captureAutomaticFrame();
                          } else {
                            void startAutomaticSweep();
                          }
                        }}
                        disabled={autoScanStatus === "countdown" || (autoScanStatus === "scanning" && captureMode === "automatic")}
                      >
                        {autoScanStatus === "scanning" && captureMode === "manual" ? <Camera aria-hidden="true" /> : <ScanLine aria-hidden="true" />}
                        {autoScanStatus === "countdown"
                          ? `Starting in ${countdown}`
                          : autoScanStatus === "scanning"
                            ? captureMode === "automatic"
                              ? "Live guidance active"
                              : retakeSequence === null
                                ? `Capture target ${activeDirection + 1}`
                                : `Retake direction ${activeDirection + 1}`
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
                  <button
                    className={styles.quickModeSwitch}
                    type="button"
                    disabled={retakeSequence !== null}
                    aria-label={`Switch to ${captureMode === "automatic" ? "Manual" : "Automatic"} capture`}
                    onClick={() => selectCaptureMode(captureMode === "automatic" ? "manual" : "automatic")}
                  >
                    {captureMode === "automatic" ? <ScanLine aria-hidden="true" /> : <Camera aria-hidden="true" />}
                    {captureMode === "automatic" ? "Auto" : "Manual"}
                  </button>
                </div>

              </div>

              <aside className={styles.captureRail}>
                <p className={styles.kicker}>Coverage map</p>
                <h1 id="capture-title">Rotate. We capture.</h1>
                <p>Follow one live target at a time. Center the ring, hold still, and Astra3D saves a photo automatically without recording video.</p>
                <div className={styles.captureMode} role="group" aria-label="Capture method">
                  <button
                    type="button"
                    data-active={captureMode === "automatic"}
                    disabled={retakeSequence !== null}
                    onClick={() => selectCaptureMode("automatic")}
                  >
                    <ScanLine aria-hidden="true" />
                    <span><strong>Automatic</strong><small>Center and hold</small></span>
                  </button>
                  <button
                    type="button"
                    data-active={captureMode === "manual"}
                    onClick={() => selectCaptureMode("manual")}
                  >
                    <Camera aria-hidden="true" />
                    <span><strong>Manual</strong><small>Tap every still</small></span>
                  </button>
                </div>
                <div className={styles.bandList}>
                  {bandCompletion.map((band) => (
                    <div key={band.id} data-active={band.id === activeSlot?.band} data-complete={band.count === CAPTURE_COLUMNS}>
                      <span>{band.count === CAPTURE_COLUMNS ? <Check aria-hidden="true" /> : band.tilt}</span>
                      <div><strong>{band.label}</strong><small>{band.count} / {CAPTURE_COLUMNS} views</small></div>
                      <i><b style={{ width: `${(band.count / CAPTURE_COLUMNS) * 100}%` }} /></i>
                    </div>
                  ))}
                </div>
                {frames.length > 0 ? (
                  <div className={styles.retakeMap}>
                    <div><strong>Review & retake</strong><small>Tap any captured thumbnail.</small></div>
                    {CAPTURE_BANDS.map((band) => (
                      <div className={styles.retakeRow} key={band.id}>
                        <span>{band.tilt}</span>
                        <div>
                          {captureSlots.filter((slot) => slot.band === band.id).map((slot) => {
                            const frame = frames.find((candidate) => candidate.sequence === slot.sequence);
                            return (
                              <button
                                key={slot.id}
                                type="button"
                                disabled={!frame || autoScanStatus === "countdown" || (autoScanStatus === "scanning" && captureMode === "automatic")}
                                data-selected={retakeSequence === slot.sequence}
                                aria-label={`Retake ${band.label} direction ${slot.column + 1}`}
                                onClick={() => void beginRetake(slot.sequence)}
                                style={frame ? { backgroundImage: `linear-gradient(rgba(3, 10, 19, 0.12), rgba(3, 10, 19, 0.58)), url(${frame.dataUrl})` } : undefined}
                              >
                                {slot.column + 1}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
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
