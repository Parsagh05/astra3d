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
import type { SharedRoomProject } from "@/types/capture";

import {
  buildCaptureLockConstraints,
  buildCaptureSlots,
  CAPTURE_BANDS,
  CAPTURE_COLUMNS,
  captureBestStill,
  captureExposureBracket,
  getCaptureProgress,
  getPitchDirection,
  getRelativeCameraPitch,
  getSignedAngleDelta,
  TOTAL_CAPTURE_SLOTS,
  type CaptureLockCapabilities,
  type CaptureLockSettings,
  type LiveStillCapture,
} from "./capture-utils";
import { GeneratedRoomViewer } from "./generated-room-viewer";
import { SharedProjectLibrary } from "./shared-project-library";
import {
  fetchSharedProjects,
  loadSharedProject,
  syncSavedRoom,
} from "./shared-projects-api";
import {
  PanoramaUploadError,
  processPanoramaOnServer,
  type PanoramaProcessingPhase,
} from "./panorama-api";
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

/**
 * Laplacian-variance floor for automatic captures. Below this a detailed view
 * is almost certainly motion-blurred; near-zero means the scene had no
 * measurable detail at all, which the laptop's relative check handles better.
 */
const AUTO_CAPTURE_BLUR_FLOOR = 6;
const MIN_MEASURABLE_SHARPNESS = 0.5;

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
  const linkedProjectHandledRef = useRef(false);
  const bandCaptureCountRef = useRef(0);
  const activeBandIndexRef = useRef(0);
  const orientationRef = useRef({
    alpha: null as number | null,
    lastAlpha: null as number | null,
    accumulated: 0,
    lastEventAt: 0,
    baselineBeta: null as number | null,
    pitchDirection: null as -1 | 1 | null,
    lastBeta: null as number | null,
    alignmentStartedAt: null as number | null,
    betaSample: null as number | null,
    gammaSample: null as number | null,
  });
  const captureLockRef = useRef<MediaStreamTrack | null>(null);
  const captureInFlightRef = useRef(false);
  const [stage, setStage] = useState<StudioStage>("intro");
  const [cameraMode, setCameraMode] = useState<CameraMode>("idle");
  const [roomName, setRoomName] = useState("My room");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [room, setRoom] = useState<GeneratedRoomRecord | null>(null);
  const [loadingSavedRoom, setLoadingSavedRoom] = useState(true);
  const [sharedProjects, setSharedProjects] = useState<SharedRoomProject[]>([]);
  const [loadingSharedProjects, setLoadingSharedProjects] = useState(true);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [sharedProjectsError, setSharedProjectsError] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingPhase, setProcessingPhase] = useState<PanoramaProcessingPhase>("preparing");
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
    captureLockRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [clearAutoTimers]);

  const lockCaptureAppearance = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track || captureLockRef.current === track) return;
    captureLockRef.current = track;
    const constraints = buildCaptureLockConstraints(
      track.getCapabilities?.() as CaptureLockCapabilities | undefined,
      track.getSettings?.() as CaptureLockSettings | undefined,
    );
    if (!constraints) return;
    try {
      // Freezing exposure, white balance, and focus keeps all 24 stills
      // consistent so the laptop blends seams without color steps.
      await track.applyConstraints({ advanced: [constraints] });
    } catch {
      // Automatic exposure simply stays on when manual mode is rejected.
    }
  }, []);

  const refreshSharedProjects = useCallback(async () => {
    setLoadingSharedProjects(true);
    setSharedProjectsError(null);
    try {
      setSharedProjects(await fetchSharedProjects());
    } catch (libraryError) {
      setSharedProjectsError(
        libraryError instanceof Error ? libraryError.message : "The shared laptop project library is unavailable.",
      );
    } finally {
      setLoadingSharedProjects(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    loadGeneratedRoom()
      .then(async (savedRoom) => {
        if (!active || !savedRoom) return;
        setRoom(savedRoom);
        if (!savedRoom.serverProjectId) {
          try {
            const project = await syncSavedRoom(savedRoom);
            if (!active || !project) return;
            const synchronizedRoom = {
              ...savedRoom,
              serverProjectId: project.id,
              hasSourceFrames: project.hasSourceFrames,
            };
            setRoom(synchronizedRoom);
            await saveGeneratedRoom(synchronizedRoom);
            await refreshSharedProjects();
          } catch {
            // The local panorama remains available even if the laptop is temporarily unreachable.
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadingSavedRoom(false);
      });
    return () => {
      active = false;
    };
  }, [refreshSharedProjects]);

  useEffect(() => {
    const request = window.setTimeout(() => void refreshSharedProjects(), 0);
    return () => window.clearTimeout(request);
  }, [refreshSharedProjects]);

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
    orientationRef.current.baselineBeta = null;
    orientationRef.current.pitchDirection = null;
    orientationRef.current.lastBeta = null;
    orientationRef.current.alignmentStartedAt = null;
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const addFrame = useCallback((capture: LiveStillCapture, bracketDataUrl?: string | null) => {
    const replacementSequence = retakeSequenceRef.current;
    retakeSequenceRef.current = null;
    setRetakeSequence(null);
    setError(null);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    const orientation = orientationRef.current;
    const motionFresh = orientation.alpha !== null &&
      orientation.betaSample !== null &&
      orientation.gammaSample !== null &&
      Date.now() - orientation.lastEventAt < 1500;
    const imu = motionFresh
      ? {
          alpha: orientation.alpha as number,
          beta: orientation.betaSample as number,
          gamma: orientation.gammaSample as number,
        }
      : undefined;
    setFrames((current) => {
      const slot = captureSlots[replacementSequence ?? current.length];
      if (!slot) return current;
      const capturedFrame = {
        ...slot,
        dataUrl: capture.dataUrl,
        capturedAt: Date.now(),
        zoom: captureZoom,
        ...(imu ? { imu } : {}),
        ...(bracketDataUrl ? { bracketDataUrl } : {}),
      };
      const next = replacementSequence === null
        ? [...current, capturedFrame]
        : current.map((frame) => frame.sequence === replacementSequence ? capturedFrame : frame);
      if (next.length === TOTAL_CAPTURE_SLOTS) stopCamera();
      return next;
    });
  }, [captureZoom, stopCamera]);

  const setAutomaticStatus = useCallback((status: AutoScanStatus) => {
    autoStatusRef.current = status;
    setAutoScanStatus(status);
  }, []);

  const captureAutomaticFrame = useCallback(async () => {
    if (!videoRef.current || autoStatusRef.current !== "scanning") return;
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;

    try {
      const isRetaking = retakeSequenceRef.current !== null;
      const video = videoRef.current;
      const track = streamRef.current?.getVideoTracks?.()[0];
      const softwareZoom = zoomRange.hardware ? 1 : captureZoom;
      const capture = await captureBestStill(video, track, softwareZoom);
      if (autoStatusRef.current !== "scanning") return;
      if (
        captureModeRef.current === "automatic" &&
        capture.sharpness > MIN_MEASURABLE_SHARPNESS &&
        capture.sharpness < AUTO_CAPTURE_BLUR_FLOOR
      ) {
        // Motion blur detected: drop the still and let the hold timer retake
        // the same target instead of discovering the problem after upload.
        orientationRef.current.alignmentStartedAt = null;
        setGuidance((current) => ({ ...current, aligned: false, holdProgress: 0 }));
        setError("That view looked motion-blurred, so it was not saved. Hold steady and it will retake automatically.");
        return;
      }
      // A short under-exposed companion still lets the laptop recover bright
      // windows during blending. Skipped silently when unsupported.
      const bracketDataUrl = track
        ? await captureExposureBracket(video, track, softwareZoom)
        : null;
      if (autoStatusRef.current !== "scanning") return;
      addFrame(capture, bracketDataUrl);
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
    } finally {
      captureInFlightRef.current = false;
    }
  }, [addFrame, captureComplete, captureZoom, clearAutoTimers, setAutomaticStatus, zoomRange.hardware]);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null) return;
      const orientation = orientationRef.current;
      orientation.alpha = event.alpha;
      orientation.betaSample = event.beta;
      orientation.gammaSample = event.gamma;
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
        ? 35
        : activeBandIndexRef.current === 2
          ? -35
          : 0;
      if (
        activeBandIndexRef.current === 1 &&
        orientation.pitchDirection === null &&
        event.beta !== null &&
        orientation.baselineBeta !== null &&
        Math.abs(event.beta - orientation.baselineBeta) >= 8
      ) {
        // The upper sweep explicitly asks the user to point at the ceiling,
        // so this first deliberate tilt safely calibrates the device's sign.
        orientation.pitchDirection = getPitchDirection(event.beta, orientation.baselineBeta);
      }
      const relativePitch =
        event.beta !== null && orientation.baselineBeta !== null
          ? getRelativeCameraPitch(
              event.beta,
              orientation.baselineBeta,
              orientation.pitchDirection ?? -1,
            )
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
        void captureAutomaticFrame();
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
      void lockCaptureAppearance();
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
      void lockCaptureAppearance();
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
        void lockCaptureAppearance();
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
      void lockCaptureAppearance();
      setAutomaticStatus("scanning");
    }
  };

  const beginRetake = async (sequence: number, keepError = false) => {
    if (!frames.some((frame) => frame.sequence === sequence)) return;
    clearAutoTimers();
    retakeSequenceRef.current = sequence;
    setRetakeSequence(sequence);
    captureModeRef.current = "manual";
    setCaptureMode("manual");
    if (!keepError) setError(null);
    const slot = captureSlots[sequence];
    activeBandIndexRef.current = CAPTURE_BANDS.findIndex((band) => band.id === slot.band);
    bandCaptureCountRef.current = slot.column;
    const cameraReady = streamRef.current ? true : await startCamera();
    if (cameraReady) {
      void lockCaptureAppearance();
      setAutomaticStatus("scanning");
    }
  };

  const retakePrevious = () => {
    const previous = frames.at(-1);
    if (previous) void beginRetake(previous.sequence);
  };

  const openSharedProject = useCallback(async (project: SharedRoomProject) => {
    setOpeningProjectId(project.id);
    setSharedProjectsError(null);
    try {
      const sharedRoom = await loadSharedProject(project);
      setRoom(sharedRoom);
      await saveGeneratedRoom(sharedRoom);
      setStage("result");
    } catch (projectError) {
      setSharedProjectsError(
        projectError instanceof Error ? projectError.message : "The shared project could not be opened.",
      );
    } finally {
      setOpeningProjectId(null);
    }
  }, []);

  useEffect(() => {
    if (linkedProjectHandledRef.current || loadingSharedProjects || stage !== "intro") return;
    const request = window.setTimeout(() => {
      if (linkedProjectHandledRef.current) return;
      const linkedProjectId = new URLSearchParams(window.location.search).get("project");
      linkedProjectHandledRef.current = true;
      if (!linkedProjectId) return;
      const linkedProject = sharedProjects.find((project) => project.id === linkedProjectId);
      if (linkedProject) {
        void openSharedProject(linkedProject);
      } else {
        setSharedProjectsError("The shared room link does not match a project on this laptop.");
      }
    }, 0);
    return () => window.clearTimeout(request);
  }, [loadingSharedProjects, openSharedProject, sharedProjects, stage]);

  const assembleRoom = async (capturedFrames: readonly CapturedFrame[]) => {
    if (capturedFrames.length !== TOTAL_CAPTURE_SLOTS) {
      setError("Complete eye level, +35°, and −35° before finalizing the room.");
      return;
    }
    setStage("processing");
    setProcessingProgress(0);
    setProcessingPhase("preparing");
    setError(null);
    stopCamera();

    try {
      const processed = await processPanoramaOnServer(capturedFrames, roomName, (update) => {
        setProcessingPhase(update.phase);
        setProcessingProgress(update.progress);
      });
      const generatedRoom: GeneratedRoomRecord = {
        id: "latest-room",
        name: roomName.trim() || "My room",
        createdAt: new Date().toISOString(),
        photoCount: capturedFrames.length,
        panorama: processed.panorama,
        processor: "laptop",
        quality: processed.quality,
        serverProjectId: processed.projectId,
        hasSourceFrames: true,
      };
      setRoom(generatedRoom);
      setFrames([]);
      try {
        await saveGeneratedRoom(generatedRoom);
      } catch {
        setError("The panorama is ready, but this browser did not allow persistent local storage.");
      }
      setStage("result");
      await refreshSharedProjects();
    } catch (processingError) {
      setStage("capture");
      if (processingError instanceof PanoramaUploadError && processingError.retakeSequences.length > 0) {
        const firstRetake = processingError.retakeSequences[0];
        const suggestedSlot = captureSlots[firstRetake];
        const suggestedBand = CAPTURE_BANDS.find((band) => band.id === suggestedSlot.band);
        await beginRetake(firstRetake, true);
        setError(
          `${processingError.message} ${suggestedBand?.label ?? "Room"} direction ${suggestedSlot.column + 1} is ready to retake.`,
        );
      } else {
        setError(processingError instanceof Error ? processingError.message : "The room could not be assembled.");
      }
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
        <div><span /> Room Capture Lab · laptop processor</div>
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
                <span><Sparkles aria-hidden="true" /><strong>Laptop blend</strong><small>3072 × 1536 output</small></span>
              </div>
            </div>

            <div className={styles.preflight}>
              <article><strong>01 · Pick the center</strong><p>Stand near the center and keep your feet in exactly one place.</p></article>
              <article><strong>02 · Follow the sweep</strong><p>Use portrait orientation and rotate slowly clockwise while Astra3D captures automatically.</p></article>
              <article><strong>03 · Three simple passes</strong><p>Scan once at eye level, once tilted upward, and once tilted downward.</p></article>
            </div>

            <div className={styles.privacyBanner}>
              <LockKeyhole aria-hidden="true" />
              <div><strong>Private shared laptop projects</strong><p>Completed scans and their 24 original photos stay on this laptop so phone and desktop can open the same project. Nothing is sent to a cloud service.</p></div>
            </div>

            {sharedProjectsError ? <p className={styles.libraryError} role="status">{sharedProjectsError}</p> : null}
            <SharedProjectLibrary
              projects={sharedProjects}
              loading={loadingSharedProjects}
              openingId={openingProjectId}
              onOpen={(project) => void openSharedProject(project)}
              onRefresh={() => void refreshSharedProjects()}
            />
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
                      <p>This scanner never records video. After capture, the 24 stills are sent through phone localhost to your laptop for private processing.</p>
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
                        disabled={frames.length > 0 || captureZoom <= zoomRange.min}
                        onClick={() => void changeCaptureZoom(-1)}
                      >
                        <Minus aria-hidden="true" />
                      </button>
                      <output aria-live="polite">{captureZoom.toFixed(1)}×</output>
                      <button
                        type="button"
                        aria-label="Zoom in"
                        disabled={frames.length > 0 || captureZoom >= zoomRange.max}
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
                            void captureAutomaticFrame();
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
            <p className={styles.kicker}>Private laptop panorama assembly</p>
            <h1 id="processing-title">Building {roomName.trim() || "your room"}…</h1>
            <p>
              {processingPhase === "preparing" ? "Packaging the completed still photographs for your laptop." : null}
              {processingPhase === "uploading" ? "Sending the capture through this private local connection." : null}
              {processingPhase === "processing" ? "Your laptop is matching visual features, correcting exposure, choosing seams, and multiband blending the panorama." : null}
              {processingPhase === "receiving" ? "Returning the optimized panorama to the phone viewer." : null}
            </p>
            <div className={styles.processingTrack}><span style={{ width: `${processingProgress}%` }} /></div>
            <strong>{processingProgress}%</strong>
            <small>Keep this tab open. Private temporary job files are erased from the laptop immediately after this result or an error.</small>
          </section>
        ) : null}

        {stage === "result" && room ? <GeneratedRoomViewer room={room} onRetake={() => void resetStudio()} /> : null}
      </main>
    </div>
  );
}
