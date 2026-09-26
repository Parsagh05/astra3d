"use client";

import { Circle, Loader2, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Vector3 } from "three";

import { lockCameraAppearance } from "@/components/room-capture/capture-utils";
import { currentScreenAngle, deviceQuaternion } from "@/components/room-capture/device-pose";
import {
  addCoverageSample,
  coverageFraction,
  coveredCells,
  createScanCoverage,
  SCAN_ROWS,
  scanHint,
  type ScanCoverage,
} from "@/lib/scan-coverage";

import styles from "./scan.module.css";

/** Long enough for a large room; longer videos only add near-duplicate frames. */
export const MAX_RECORDING_MS = 3 * 60 * 1000;
const MIN_RECORDING_MS = 10_000;

const RECORDING_TYPES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

export function pickRecordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function formatClock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type Phase = "starting" | "ready" | "recording" | "stopping" | "error";

export type RecordedVideo = { blob: Blob; durationMs: number };

/**
 * Full-screen camera for filming a room: records 1080p video with the
 * MediaRecorder API while the phone's motion sensors track which parts of
 * the room have been filmed and whether the camera is turning too fast.
 */
export function ScanRecorder({ onRecorded, onCancel }: { onRecorded: (video: RecordedVideo) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const coverageRef = useRef<ScanCoverage>(createScanCoverage());
  const startedAtRef = useRef(0);
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [coverage, setCoverage] = useState<ScanCoverage>(createScanCoverage);
  const [hasMotion, setHasMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (pickRecordingType() === null) {
        setError("This browser cannot record video. Film the room with the phone's camera app and upload the video instead.");
        setPhase("error");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setPhase("ready");
      } catch {
        if (cancelled) return;
        setError("The camera could not be opened. Allow camera access, or upload a video filmed with the camera app.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.ondataavailable = null;
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Motion samples feed the coverage map (kept in a ref; rendered at 5 Hz).
  useEffect(() => {
    if (phase !== "recording") return;
    const forward = new Vector3();
    const handle = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return;
      const camera = deviceQuaternion(event.alpha, event.beta, event.gamma, currentScreenAngle());
      forward.set(0, 0, -1).applyQuaternion(camera);
      coverageRef.current = addCoverageSample(coverageRef.current, [forward.x, forward.y, forward.z], performance.now());
      setHasMotion(true);
    };
    window.addEventListener("deviceorientation", handle, true);
    const timer = window.setInterval(() => {
      setCoverage(coverageRef.current);
      setElapsed(performance.now() - startedAtRef.current);
    }, 200);
    return () => {
      window.removeEventListener("deviceorientation", handle, true);
      window.clearInterval(timer);
    };
  }, [phase]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setPhase("stopping");
    recorder.stop();
  }, []);

  useEffect(() => {
    if (phase === "recording" && elapsed >= MAX_RECORDING_MS) stop();
  }, [elapsed, phase, stop]);

  const start = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    try {
      const orientation = typeof DeviceOrientationEvent === "undefined" ? undefined : (DeviceOrientationEvent as OrientationEventConstructor);
      if (typeof orientation?.requestPermission === "function") await orientation.requestPermission();
    } catch {
      // Recording works without motion guidance.
    }
    // Constant exposure and colour across the video keep the 3D scene from
    // blotching where the camera re-metered.
    const [track] = stream.getVideoTracks();
    if (track) await lockCameraAppearance(track);

    const mimeType = pickRecordingType() ?? "";
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 16_000_000 });
    } catch {
      setError("Recording could not start. Upload a video filmed with the camera app instead.");
      setPhase("error");
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const durationMs = performance.now() - startedAtRef.current;
      const type = (recorder.mimeType || mimeType || "video/webm").split(";")[0];
      onRecorded({ blob: new Blob(chunks, { type }), durationMs });
    };
    recorderRef.current = recorder;
    coverageRef.current = createScanCoverage();
    setCoverage(coverageRef.current);
    startedAtRef.current = performance.now();
    setElapsed(0);
    recorder.start(1000);
    setPhase("recording");
  };

  const hint = scanHint(coverage, elapsed);
  const cells = coveredCells(coverage);
  const tooShort = elapsed < MIN_RECORDING_MS;

  return (
    <div className={styles.recorder} role="dialog" aria-modal="true" aria-label="Film the room">
      <video ref={videoRef} className={styles.recorderVideo} muted playsInline autoPlay aria-hidden="true" />
      <div className={styles.recorderTop}>
        <button type="button" className={styles.recorderClose} onClick={onCancel} aria-label="Close camera" disabled={phase === "stopping"}>
          <X aria-hidden="true" />
        </button>
        {phase === "recording" || phase === "stopping" ? (
          <p className={styles.recordingClock} aria-live="off">
            <span aria-hidden="true" /> {formatClock(elapsed)}
          </p>
        ) : null}
      </div>

      {phase === "recording" ? (
        <div className={styles.recorderGuide}>
          <p className={styles.recorderHint} data-tone={hint.tone} role="status">{hasMotion ? hint.text : "Walk slowly around the room: eye level, then tilted down, then tilted up"}</p>
          {hasMotion ? (
            <div className={styles.coverageMap} aria-label={`${Math.round(coverageFraction(coverage) * 100)}% of the room filmed`} role="img">
              {[...SCAN_ROWS].reverse().map((row) => (
                <div key={row} className={styles.coverageRow}>
                  <small>{row === "high" ? "Up" : row === "level" ? "Eye" : "Down"}</small>
                  {cells[SCAN_ROWS.indexOf(row)].map((covered, index) => (
                    <span key={index} data-covered={covered} />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.recorderBottom}>
        {phase === "starting" ? <p className={styles.recorderNote}><Loader2 aria-hidden="true" className={styles.spin} /> Opening the camera…</p> : null}
        {phase === "error" ? <p className={styles.recorderError} role="alert">{error}</p> : null}
        {phase === "ready" ? (
          <>
            <p className={styles.recorderNote}>Hold the phone upright, start in a corner and walk slowly along the walls.</p>
            <button type="button" className={styles.recordButton} onClick={() => void start()} aria-label="Start recording">
              <Circle aria-hidden="true" />
            </button>
          </>
        ) : null}
        {phase === "recording" || phase === "stopping" ? (
          <>
            {tooShort ? <p className={styles.recorderNote}>Keep filming: at least 10 seconds</p> : null}
            <button type="button" className={styles.recordButton} data-recording="true" onClick={stop} aria-label="Stop recording" disabled={phase === "stopping" || tooShort}>
              <Square aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
