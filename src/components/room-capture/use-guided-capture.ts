"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Quaternion } from "three";

import { orientationToView } from "@/components/tour/tour-math";
import { CAPTURE_COLUMNS } from "@/lib/capture-plan";
import {
  advanceHeading,
  createHeadingTracker,
  guidanceHint,
  nearestTargetYaw,
  resetHeadingTracker,
  type GuidanceHint,
} from "@/lib/guided-capture";
import type { CaptureOrientation } from "@/types/capture";

import { updateCaptureGuidance, type CaptureGuidanceState } from "./capture-guidance";
import { cameraRoll, currentScreenAngle, deviceQuaternion, type ViewQuaternion } from "./device-pose";

export type AutoScanStatus = "idle" | "countdown" | "scanning" | "between" | "complete";
export type CaptureMode = "automatic" | "manual";

/**
 * Live aiming data shared with the capture view.  It changes on every motion
 * sample, so it lives in a ref and the view paints it on animation frames;
 * the page itself never rerenders for sensor noise.
 */
export type CaptureEngineState = {
  /** Camera orientation relative to the sweep's starting heading. */
  pose: Quaternion | null;
  /** Current target in the same frame (continuous yaw, pitch up). */
  target: { yaw: number; pitch: number } | null;
  aligned: boolean;
  holdProgress: number;
  yawError: number;
  pitchError: number;
  hint: GuidanceHint | null;
};

export type CapturePose = {
  imu?: CaptureOrientation;
  view?: ViewQuaternion;
};

type SensorSample = {
  alpha: number;
  beta: number;
  gamma: number | null;
  yaw: number;
  pitch: number;
  at: number;
};

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const MOTION_FRESH_MS = 1500;
const COUNTDOWN_SECONDS = 3;

export const MOTION_UNAVAILABLE_NOTICE =
  "Motion guidance is unavailable, so capture switched to Manual. Align each target and tap the shutter.";
export const AUTOMATIC_NEEDS_MOTION_NOTICE =
  "Automatic capture needs phone motion data. Manual capture is still ready.";

export function createCaptureEngineState(): CaptureEngineState {
  return {
    pose: null,
    target: null,
    aligned: false,
    holdProgress: 0,
    yawError: 0,
    pitchError: 0,
    hint: null,
  };
}

type GuidedCaptureOptions = {
  bands: readonly { pitch: number }[];
  /** Called when the phone has held a target long enough to take a photo. */
  onAutoCapture: () => void;
  /** Called each time a sweep starts scanning, e.g. to lock exposure. */
  onScanningStart?: () => void;
  /** Explains an automatic fall back to manual capture. */
  onNotice?: (message: string) => void;
};

/**
 * The guided capture state machine shared by the studio and the test maker:
 * motion sensors, the continuous heading, the current target, the hold timer
 * and the countdown → scanning → between → complete flow.  Callers own the
 * photographs and report each one through `afterCapture`.
 */
export function useGuidedCapture({ bands, onAutoCapture, onScanningStart, onNotice }: GuidedCaptureOptions) {
  const [status, setStatusState] = useState<AutoScanStatus>("idle");
  const [mode, setModeState] = useState<CaptureMode>("automatic");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [motionLive, setMotionLive] = useState(false);

  const statusRef = useRef<AutoScanStatus>("idle");
  const modeRef = useRef<CaptureMode>("automatic");
  const motionLiveRef = useRef(false);
  const bandsRef = useRef(bands);
  const callbacksRef = useRef({ onAutoCapture, onScanningStart, onNotice });
  const trackerRef = useRef(createHeadingTracker());
  const sensorRef = useRef<SensorSample | null>(null);
  const aimRef = useRef({ band: 0, column: 0 });
  const guidanceRef = useRef<CaptureGuidanceState | null>(null);
  const engineRef = useRef<CaptureEngineState>(createCaptureEngineState());
  const countdownRef = useRef<number | null>(null);

  useEffect(() => {
    bandsRef.current = bands;
    callbacksRef.current = { onAutoCapture, onScanningStart, onNotice };
  }, [bands, onAutoCapture, onScanningStart, onNotice]);

  const setStatus = useCallback((next: AutoScanStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const setMode = useCallback((next: CaptureMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const clearGuidance = useCallback(() => {
    guidanceRef.current = null;
    const engine = engineRef.current;
    engine.target = null;
    engine.aligned = false;
    engine.holdProgress = 0;
    engine.yawError = 0;
    engine.pitchError = 0;
    engine.hint = null;
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const aimAt = useCallback((sequence: number) => {
    aimRef.current = {
      band: Math.floor(sequence / CAPTURE_COLUMNS),
      column: sequence % CAPTURE_COLUMNS,
    };
    clearGuidance();
  }, [clearGuidance]);

  const motionFresh = useCallback(() => {
    const sample = sensorRef.current;
    return sample !== null && Date.now() - sample.at < MOTION_FRESH_MS;
  }, []);

  /** Anchors the heading so the phone's current direction reads `heading`. */
  const anchorHeading = useCallback((heading: number) => {
    const sample = sensorRef.current;
    const tracker = trackerRef.current;
    if (!sample || tracker.origin !== null) return;
    tracker.origin = sample.yaw - heading;
    tracker.previous = sample.yaw;
    tracker.heading = heading;
  }, []);

  useEffect(() => {
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (
        event.alpha === null || event.beta === null ||
        !Number.isFinite(event.alpha) || !Number.isFinite(event.beta)
      ) return;
      const gamma = typeof event.gamma === "number" && Number.isFinite(event.gamma) ? event.gamma : 0;
      // Alpha alone can jump when a nearly upright phone tilts sideways; the
      // rear-camera vector combines all three angles and stays continuous.
      const view = orientationToView(event.alpha, event.beta, gamma);
      sensorRef.current = {
        alpha: event.alpha,
        beta: event.beta,
        gamma: typeof event.gamma === "number" && Number.isFinite(event.gamma) ? event.gamma : null,
        yaw: view.yaw,
        pitch: view.pitch,
        at: Date.now(),
      };
      if (!motionLiveRef.current) {
        motionLiveRef.current = true;
        setMotionLive(true);
      }

      const tracker = trackerRef.current;
      if (tracker.origin !== null) advanceHeading(tracker, view.yaw);
      const engine = engineRef.current;
      engine.pose = deviceQuaternion(
        event.alpha, event.beta, gamma, currentScreenAngle(), tracker.origin ?? view.yaw,
        engine.pose ?? undefined,
      );

      if (
        statusRef.current !== "scanning" ||
        modeRef.current !== "automatic" ||
        tracker.origin === null
      ) return;
      const band = bandsRef.current[aimRef.current.band];
      if (!band) return;

      // Yaw is signed: targets advance clockwise (turning right), the order
      // the stitcher assembles.  Pitch is absolute, straight from gravity.
      const target = { yaw: nearestTargetYaw(aimRef.current.column, tracker.heading), pitch: band.pitch };
      const roll = cameraRoll(engine.pose);
      const result = updateCaptureGuidance(guidanceRef.current, {
        time: performance.now(),
        yaw: tracker.heading,
        pitch: view.pitch,
        roll,
      }, target);
      guidanceRef.current = result.state;
      engine.target = target;
      engine.aligned = result.guidance.aligned;
      engine.holdProgress = result.guidance.holdProgress;
      engine.yawError = result.guidance.yawError;
      engine.pitchError = result.guidance.pitchError;
      engine.hint = guidanceHint(result.guidance.yawError, result.guidance.pitchError, result.guidance.aligned, roll);

      if (result.ready) callbacksRef.current.onAutoCapture();
    };

    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => window.removeEventListener("deviceorientation", handleOrientation, true);
  }, []);

  useEffect(() => clearCountdown, [clearCountdown]);

  const beginScanning = useCallback(() => {
    setStatus("scanning");
    callbacksRef.current.onScanningStart?.();
  }, [setStatus]);

  /** Starts (or continues) guided capture at the given plan sequence. */
  const startSweep = useCallback(async (nextSequence: number) => {
    clearCountdown();
    aimAt(nextSequence);
    if (modeRef.current === "manual") {
      beginScanning();
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

    setCountdown(COUNTDOWN_SECONDS);
    setStatus("countdown");
    let remaining = COUNTDOWN_SECONDS;
    countdownRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setCountdown(remaining);
        return;
      }
      clearCountdown();
      const automatic = motionFresh();
      setMode(automatic ? "automatic" : "manual");
      if (automatic) {
        anchorHeading(aimRef.current.column * (360 / CAPTURE_COLUMNS));
      } else {
        callbacksRef.current.onNotice?.(MOTION_UNAVAILABLE_NOTICE);
      }
      beginScanning();
    }, 1000);
  }, [aimAt, anchorHeading, beginScanning, clearCountdown, motionFresh, setMode, setStatus]);

  /** Switches between automatic and manual capture, mid-sweep if needed. */
  const selectMode = useCallback((next: CaptureMode, nextSequence: number) => {
    clearCountdown();
    setMode(next);
    clearGuidance();
    const current = statusRef.current;
    if (current !== "countdown" && current !== "scanning") return;
    if (next === "manual") {
      beginScanning();
      return;
    }
    if (!motionFresh()) {
      setMode("manual");
      beginScanning();
      callbacksRef.current.onNotice?.(AUTOMATIC_NEEDS_MOTION_NOTICE);
      return;
    }
    aimAt(nextSequence);
    anchorHeading(aimRef.current.column * (360 / CAPTURE_COLUMNS));
    beginScanning();
  }, [aimAt, anchorHeading, beginScanning, clearCountdown, clearGuidance, motionFresh, setMode]);

  /** Manual capture of one specific slot, used for retakes. */
  const aimManually = useCallback((sequence: number) => {
    clearCountdown();
    setMode("manual");
    aimAt(sequence);
    beginScanning();
  }, [aimAt, beginScanning, clearCountdown, setMode]);

  /** Advances the flow after a photo; `frameCount` is the number now held. */
  const afterCapture = useCallback((frameCount: number, total: number) => {
    aimAt(Math.min(frameCount, total - 1));
    if (frameCount >= total) {
      clearCountdown();
      setStatus("complete");
    } else if (frameCount % CAPTURE_COLUMNS === 0) {
      clearCountdown();
      setStatus("between");
    } else {
      setStatus("scanning");
    }
  }, [aimAt, clearCountdown, setStatus]);

  /** Stops guidance without forgetting the heading (e.g. camera error). */
  const stop = useCallback(() => {
    clearCountdown();
    clearGuidance();
    setStatus("idle");
  }, [clearCountdown, clearGuidance, setStatus]);

  /** Forgets everything for a brand-new capture. */
  const reset = useCallback(() => {
    stop();
    setMode("automatic");
    resetHeadingTracker(trackerRef.current);
    aimRef.current = { band: 0, column: 0 };
  }, [setMode, stop]);

  /** Sensor pose to store with a photo taken right now. */
  const capturePose = useCallback((): CapturePose => {
    const sample = sensorRef.current;
    if (!sample || !motionFresh()) return {};
    const pose = engineRef.current.pose;
    return {
      ...(sample.gamma !== null ? { imu: { alpha: sample.alpha, beta: sample.beta, gamma: sample.gamma } } : {}),
      ...(pose && trackerRef.current.origin !== null ? { view: [pose.x, pose.y, pose.z, pose.w] as ViewQuaternion } : {}),
    };
  }, [motionFresh]);

  return {
    status,
    mode,
    countdown,
    motionLive,
    engineRef,
    statusRef,
    modeRef,
    startSweep,
    selectMode,
    aimManually,
    afterCapture,
    stop,
    reset,
    capturePose,
  };
}
