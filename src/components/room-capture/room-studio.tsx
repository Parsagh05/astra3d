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
import { orientationToView } from "@/components/tour/tour-math";
import { getCaptureBands, type CaptureExtent } from "@/lib/capture-plan";
import type { CapturedFrame, GeneratedRoomRecord } from "@/types/capture";
import type { SharedRoomProject } from "@/types/capture";

import {
  buildCaptureLockConstraints,
  buildCaptureSlots,
  CAPTURE_COLUMNS,
  capturePreviewStill,
  getCaptureProgress,
  getSignedAngleDelta,
  type CaptureLockCapabilities,
  type CaptureLockSettings,
  type PreviewStillCapture,
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
import { updateCaptureGuidance, type CaptureGuidanceState } from "./capture-guidance";
import { EMPTY_GUIDANCE, LiveCaptureGuide, type LiveCaptureGuideHandle } from "./live-capture-guide";

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
  const [captureExtent, setCaptureExtent] = useState<CaptureExtent>("quick");
  const captureSlots = useMemo(() => buildCaptureSlots(captureExtent), [captureExtent]);
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
  const retakeSequenceRef = useRef<number | null>(null);
  const linkedProjectHandledRef = useRef(false);
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

  const nextSlot = captureSlots[frames.length];
  const activeSlot = retakeSequence === null
    ? nextSlot
    : captureSlots[retakeSequence];
  const activeBand = captureBands.find((band) => band.id === activeSlot?.band);
  const currentBandFrames = activeSlot
    ? frames.filter((frame) => frame.band === activeSlot.band).length
    : CAPTURE_COLUMNS;
  const activeDirection = retakeSequence === null
    ? currentBandFrames
    : activeSlot?.column ?? 0;
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

  useEffect(() => () => { stopCamera(); releaseThumbnails(); }, [stopCamera, releaseThumbnails]);

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
          width: { ideal: 1280 },
          height: { ideal: 960 },
          frameRate: { ideal: 24, max: 30 },
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
    framesRef.current = [];
    setFrames([]);
    releaseThumbnails();
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
    orientationRef.current.baselinePitch = null;
    orientationRef.current.lastYaw = null;
    guidanceRef.current = null;
    setStage("capture");
    window.requestAnimationFrame(() => void startCamera());
  };

  const addFrame = useCallback((capture: PreviewStillCapture, imu: CapturedFrame["imu"], capturedAt: number) => {
    const replacementSequence = retakeSequenceRef.current;
    retakeSequenceRef.current = null;
    setRetakeSequence(null);
    setError(null);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    const current = framesRef.current;
    const slot = captureSlots[replacementSequence ?? current.length];
    if (!slot) { URL.revokeObjectURL(capture.thumbnailUrl); return; }
    const oldThumbnail = current.find((frame) => frame.sequence === slot.sequence)?.thumbnailUrl;
    if (oldThumbnail) { URL.revokeObjectURL(oldThumbnail); thumbnailUrlsRef.current.delete(oldThumbnail); }
    thumbnailUrlsRef.current.add(capture.thumbnailUrl);
    const capturedFrame = {
      ...slot,
      image: capture.image,
      thumbnailUrl: capture.thumbnailUrl,
      capturedAt,
      zoom: captureZoom,
      ...(imu ? { imu } : {}),
    };
    const next = replacementSequence === null
      ? [...current, capturedFrame]
      : current.map((frame) => frame.sequence === replacementSequence ? capturedFrame : frame);
    framesRef.current = next;
    setFrames(next);
    if (next.length === totalCaptureSlots) stopCamera();
  }, [captureSlots, captureZoom, stopCamera, totalCaptureSlots]);

  const setAutomaticStatus = useCallback((status: AutoScanStatus) => {
    autoStatusRef.current = status;
    setAutoScanStatus(status);
  }, []);

  const captureAutomaticFrame = useCallback(async () => {
    if (!videoRef.current || autoStatusRef.current !== "scanning") return;
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    const session = captureSessionRef.current;

    try {
      const isRetaking = retakeSequenceRef.current !== null;
      const video = videoRef.current;
      const softwareZoom = zoomRange.hardware ? 1 : captureZoom;
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
      const capturedAt = Date.now();
      const capture = await capturePreviewStill(video, softwareZoom);
      if (autoStatusRef.current !== "scanning" || session !== captureSessionRef.current) {
        URL.revokeObjectURL(capture.thumbnailUrl);
        return;
      }
      // Steadiness is checked before the shutter; image quality is checked on
      // the laptop. No second exposure or silent repeated photo on the phone.
      addFrame(capture, imu, capturedAt);
      if (isRetaking) {
        const count = framesRef.current.length;
        activeBandIndexRef.current = Math.floor(count / CAPTURE_COLUMNS);
        bandCaptureCountRef.current = count % CAPTURE_COLUMNS;
        setAutomaticStatus(count === totalCaptureSlots ? "complete" : count % CAPTURE_COLUMNS === 0 ? "between" : "scanning");
        return;
      }
      const nextBandCount = bandCaptureCountRef.current + 1;
      bandCaptureCountRef.current = nextBandCount;
      guidanceRef.current = null;
      guidanceDisplayRef.current?.update(EMPTY_GUIDANCE);

      if (nextBandCount >= CAPTURE_COLUMNS) {
        clearAutoTimers();
        if (activeBandIndexRef.current >= captureBands.length - 1) {
          setAutomaticStatus("complete");
        } else {
          setAutomaticStatus("between");
        }
      }
    } catch (captureError) {
      if (session !== captureSessionRef.current) return;
      clearAutoTimers();
      setAutomaticStatus("idle");
      setError(captureError instanceof Error ? captureError.message : "Automatic capture stopped unexpectedly.");
    } finally {
      captureInFlightRef.current = false;
    }
  }, [addFrame, captureBands.length, captureZoom, clearAutoTimers, setAutomaticStatus, totalCaptureSlots, zoomRange.hardware]);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null ||
        !Number.isFinite(event.alpha) || !Number.isFinite(event.beta)) return;
      // Alpha alone can jump when a nearly upright phone tilts sideways.
      // The rear-camera vector combines all three angles and stays continuous.
      const pose = orientationToView(event.alpha, event.beta,
        typeof event.gamma === "number" && Number.isFinite(event.gamma) ? event.gamma : 0);
      const orientation = orientationRef.current;
      orientation.alpha = event.alpha;
      orientation.cameraYaw = pose.yaw;
      orientation.cameraPitch = pose.pitch;
      orientation.betaSample = event.beta;
      orientation.gammaSample = event.gamma;
      orientation.lastEventAt = Date.now();

      if (
        autoStatusRef.current !== "scanning" ||
        captureModeRef.current !== "automatic"
      ) {
        return;
      }

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
      orientationRef.current.lastYaw = orientationRef.current.cameraYaw;
      if (orientationRef.current.baselinePitch === null) {
        orientationRef.current.baselinePitch = orientationRef.current.cameraPitch;
      }
      orientationRef.current.accumulated = 0;
    }, 1000);
  };

  const selectCaptureMode = (mode: CaptureMode) => {
    clearAutoTimers();
    setCaptureMode(mode);
    captureModeRef.current = mode;
    setError(null);
    guidanceRef.current = null;
    guidanceDisplayRef.current?.update(EMPTY_GUIDANCE);

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
      orientationRef.current.lastYaw = orientationRef.current.cameraYaw;
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
    activeBandIndexRef.current = captureBands.findIndex((band) => band.id === slot.band);
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
    if (capturedFrames.length !== totalCaptureSlots) {
      setError(`Capture all ${totalCaptureSlots} views before finalizing the room.`);
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
      }, captureExtent);
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
      framesRef.current = [];
      setFrames([]);
      releaseThumbnails();
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
        const suggestedBand = captureBands.find((band) => band.id === suggestedSlot.band);
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
    framesRef.current = [];
    setFrames([]);
    releaseThumbnails();
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
    () => captureBands.map((band) => ({
      ...band,
      count: frames.filter((frame) => frame.band === band.id).length,
    })),
    [frames, captureBands],
  );

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
                Stand in one fixed spot and turn once for a quick 12-photo room scan. Choose Full scan when you also need photographed ceiling and floor views.
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

              <div className={styles.captureMode} role="group" aria-label="Scan coverage">
                <button type="button" aria-pressed={captureExtent === "quick"} data-active={captureExtent === "quick"} onClick={() => setCaptureExtent("quick")}>
                  <span><strong>Quick · 12 photos</strong><small>One eye-level sweep</small></span>
                </button>
                <button type="button" aria-pressed={captureExtent === "full"} data-active={captureExtent === "full"} onClick={() => setCaptureExtent("full")}>
                  <span><strong>Full · 36 photos</strong><small>Eye level, ceiling and floor</small></span>
                </button>
              </div>
              <p className={styles.coverageNote}>{captureExtent === "quick" ? "Quick scan shows the room around you. Unphotographed ceiling and floor areas use a soft fill." : "Full scan adds upward and downward sweeps for more ceiling and floor detail."}</p>
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
              <div
                className={styles.orbitRing}
                aria-hidden="true"
                style={{ "--slot-count": CAPTURE_COLUMNS } as React.CSSProperties}
              >
                {Array.from({ length: CAPTURE_COLUMNS }, (_, index) => <i key={index} style={{ "--index": index } as React.CSSProperties} />)}
              </div>
              <div className={styles.blueprintStats}>
                <span><CircleGauge aria-hidden="true" /><strong>{totalCaptureSlots} photos</strong><small>{captureExtent === "quick" ? "one eye-level sweep" : "upper · eye · lower"}</small></span>
                <span><Sparkles aria-hidden="true" /><strong>Laptop blend</strong><small>3072 × 1536 output</small></span>
              </div>
            </div>

            <div className={styles.preflight}>
              <article><strong>01 · Pick the center</strong><p>Stand near the center and keep your feet in exactly one place.</p></article>
              <article><strong>02 · Follow the sweep</strong><p>Use portrait orientation and rotate slowly clockwise while Astra3D captures automatically.</p></article>
              <article><strong>03 · {captureExtent === "quick" ? "Finish in one turn" : "Three simple passes"}</strong><p>{captureExtent === "quick" ? "After 12 photos, build your room. No extra ceiling or floor passes." : "Scan once at eye level, once tilted upward, and once tilted downward."}</p></article>
            </div>

            <div className={styles.privacyBanner}>
              <LockKeyhole aria-hidden="true" />
              <div><strong>Private shared laptop projects</strong><p>Completed scans and their {totalCaptureSlots} original photos stay on this laptop so phone and desktop can open the same project. Nothing is sent to a cloud service.</p></div>
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
              <button type="button" onClick={() => {
                stopCamera();
                framesRef.current = [];
                setFrames([]);
                releaseThumbnails();
                setStage("intro");
              }}>
                <ArrowLeft aria-hidden="true" /> Exit scan
              </button>
              <div>
                <span>Room progress</span>
                <strong>{frames.length} / {totalCaptureSlots}</strong>
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Room capture progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={getCaptureProgress(frames.length, totalCaptureSlots)}
              >
                <span style={{ width: `${getCaptureProgress(frames.length, totalCaptureSlots)}%` }} />
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
                      <p>This scanner never records video. After capture, the {totalCaptureSlots} stills are sent through phone localhost to your laptop for private processing.</p>
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
                  {cameraMode === "live" && autoScanStatus === "scanning" && captureMode === "automatic" ? (
                    <LiveCaptureGuide ref={guidanceDisplayRef} direction={activeDirection + 1} bandLabel={activeBand?.label ?? "Room"} tilt={activeBand?.tilt ?? ""} />
                  ) : null}
                  {cameraMode === "live" && autoScanStatus === "scanning" && captureMode === "manual" ? (
                    <div className={styles.liveTargetGuide} aria-hidden="true">
                      <div className={styles.centerLock}><i /><i /><i /><i /></div>
                    </div>
                  ) : null}
                  {cameraMode === "live" && autoScanStatus !== "idle" && !(autoScanStatus === "scanning" && captureMode === "automatic") ? (
                    <div className={styles.autoCaptureState} data-status={autoScanStatus}>
                      {autoScanStatus === "countdown" ? (
                        <><span>Starting sweep</span><strong>{countdown}</strong><small>Hold your starting direction.</small></>
                      ) : autoScanStatus === "scanning" ? (
                          <><span>{retakeSequence === null ? "Manual target capture" : "Retake selected angle"}</span><strong>Align the center frame</strong><small>Tap the shutter only when this view looks right.</small></>
                      ) : autoScanStatus === "between" ? (
                        <><span>Sweep complete</span><strong>{activeBand?.label} is next</strong><small>{activeBand?.instruction}</small></>
                      ) : autoScanStatus === "complete" ? (
                        <><span>Coverage complete</span><strong>Ready to build</strong><small>{captureExtent === "quick" ? "All 12 room photos are captured." : "All three room sweeps are captured."}</small></>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className={styles.directionRing} aria-label="Current rotation coverage">
                  <div
                  className={styles.directionDial}
                  style={{ "--slot-count": CAPTURE_COLUMNS } as React.CSSProperties}
                >
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
                    {captureBands.map((band) => (
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
                                style={frame ? { backgroundImage: `linear-gradient(rgba(3, 10, 19, 0.12), rgba(3, 10, 19, 0.58)), url(${frame.thumbnailUrl ?? frame.dataUrl})` } : undefined}
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
