type MotionSample = { time: number; yaw: number; pitch: number };

export type CaptureGuidanceState = MotionSample & {
  targetYaw: number;
  targetPitch: number;
  aligned: boolean;
  heldMs: number;
  unsettledMs: number;
  history: MotionSample[];
};

const HOLD_MS = 450;
const SMOOTHING_MS = 120;
const MOTION_WINDOW_MS = 180;

/** Yaw is continuous (already unwrapped), and pitch is relative to eye level. */
export function updateCaptureGuidance(
  previous: CaptureGuidanceState | null,
  sample: MotionSample,
  target: { yaw: number; pitch: number },
) {
  const elapsed = previous ? sample.time - previous.time : 0;
  // Never carry a hold into another target, across a sensor interruption, or
  // through a large turn. Seeding at the new pose also avoids a lagging ring.
  const restart = !previous || elapsed <= 0 || elapsed > 300 ||
    previous.targetYaw !== target.yaw || previous.targetPitch !== target.pitch ||
    Math.hypot(sample.yaw - previous.yaw, sample.pitch - previous.pitch) > 12;
  const prior = restart ? null : previous;
  const blend = prior ? 1 - Math.exp(-elapsed / SMOOTHING_MS) : 1;
  const yaw = prior ? prior.yaw + (sample.yaw - prior.yaw) * blend : sample.yaw;
  const pitch = prior ? prior.pitch + (sample.pitch - prior.pitch) * blend : sample.pitch;
  const yawError = target.yaw - yaw;
  const pitchError = target.pitch - pitch;

  // A slightly wider release zone prevents small hand tremors from repeatedly
  // losing a target. Raw bounds prevent smoothing from hiding a real overshoot.
  const aligned = Math.abs(yawError) <= (prior?.aligned ? 8 : 6) &&
    Math.abs(pitchError) <= (prior?.aligned ? 15 : 12) &&
    Math.abs(target.yaw - sample.yaw) <= 8 &&
    Math.abs(target.pitch - sample.pitch) <= 15;

  const history = [...(prior?.history ?? []), { time: sample.time, yaw, pitch }];
  while (history.length > 1 && history[1].time <= sample.time - MOTION_WINDOW_MS) {
    history.shift();
  }
  const anchor = history[0];
  const observedMs = sample.time - anchor.time;
  // Measure degrees per second over a short window, not degrees per event:
  // phones deliver motion samples at different rates and with small noise.
  const speed = observedMs > 0
    ? Math.hypot(yaw - anchor.yaw, pitch - anchor.pitch) * 1000 / observedMs
    : Infinity;
  const steady = observedMs >= 100 && speed <= 8 &&
    Math.hypot(sample.yaw - yaw, sample.pitch - pitch) <= 3;
  const unsettledMs = steady ? 0 : (prior?.unsettledMs ?? 0) + (prior ? elapsed : 0);
  let heldMs = prior?.heldMs ?? 0;
  if (!aligned || unsettledMs > 120) heldMs = 0;
  else if (steady) heldMs = Math.min(HOLD_MS, heldMs + (prior ? elapsed : 0));

  return {
    state: {
      time: sample.time, yaw, pitch,
      targetYaw: target.yaw, targetPitch: target.pitch,
      aligned, heldMs, unsettledMs, history,
    } satisfies CaptureGuidanceState,
    guidance: { aligned, yawError, pitchError, holdProgress: heldMs / HOLD_MS },
    ready: aligned && steady && heldMs >= HOLD_MS,
  };
}
