"use client";

import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { CAPTURE_COLUMNS } from "@/lib/capture-plan";
import styles from "./room-capture.module.css";

export type GuidanceDisplay = { aligned: boolean; holdProgress: number; yawError: number; pitchError: number };
export type LiveCaptureGuideHandle = { update: (guidance: GuidanceDisplay) => void };
export const EMPTY_GUIDANCE: GuidanceDisplay = { aligned: false, holdProgress: 0, yawError: 0, pitchError: 0 };

/** Sensor samples never rerender the studio, camera controls or thumbnail map.
 * Only this small overlay paints, at most 30 times per second. */
export const LiveCaptureGuide = memo(function LiveCaptureGuide({ ref, direction, bandLabel, tilt }: {
  ref: Ref<LiveCaptureGuideHandle>;
  direction: number;
  bandLabel: string;
  tilt: string;
}) {
  const [guidance, setGuidance] = useState(EMPTY_GUIDANCE);
  const pending = useRef<GuidanceDisplay | null>(null);
  const frame = useRef<number | null>(null);
  const lastPaint = useRef(-Infinity);
  const update = useCallback((value: GuidanceDisplay) => {
    pending.current = value;
    if (frame.current !== null) return;
    const paint = (now: number) => {
      if (now - lastPaint.current < 1000 / 30) {
        frame.current = requestAnimationFrame(paint);
        return;
      }
      frame.current = null;
      lastPaint.current = now;
      if (pending.current) setGuidance(pending.current);
      pending.current = null;
    };
    frame.current = requestAnimationFrame(paint);
  }, []);
  useImperativeHandle(ref, () => ({ update }), [update]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const targetStyle = {
    "--hold-progress": `${guidance.holdProgress * 360}deg`,
    "--target-x": guidance.aligned ? "0px" : `${Math.max(-1, Math.min(1, guidance.yawError / 45)) * 34}vw`,
    "--target-y": guidance.aligned ? "0px" : `${Math.max(-1, Math.min(1, guidance.pitchError / 35)) * 24}vh`,
  } as CSSProperties;
  return <>
    <div className={styles.liveTargetGuide} aria-hidden="true">
      <div className={styles.centerLock}><i /><i /><i /><i /></div>
      <div className={styles.targetMarker} data-aligned={guidance.aligned} style={targetStyle}><span /></div>
    </div>
    <div className={styles.autoCaptureState} data-status="scanning">
      <span>Target {direction} of {CAPTURE_COLUMNS}</span>
      <strong>{guidance.aligned ? "Target found — pause briefly" : "Bring the ring near the center"}</strong>
      <small>{guidance.aligned ? "Small hand movements are OK. Capturing automatically…" : `${bandLabel} · ${tilt}`}</small>
    </div>
  </>;
});
