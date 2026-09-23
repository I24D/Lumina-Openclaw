/**
 * Bounded pointer trajectories for visible, coordinate-based browser actions.
 *
 * The trajectory uses the Flash-Hogan minimum-jerk profile. It is deliberately
 * deterministic: browser automation should remain reproducible, and the final
 * point must always be the exact requested coordinate.
 */
export type PointerPosition = {
  x: number;
  y: number;
};

type TimedPointerPoint = PointerPosition & {
  /** Elapsed trajectory time in milliseconds. */
  t: number;
  /** Horizontal velocity in CSS pixels per second. */
  velocityX: number;
  /** Vertical velocity in CSS pixels per second. */
  velocityY: number;
};

type PointerTrajectoryOptions = {
  start: PointerPosition;
  end: PointerPosition;
  /** Effective target width in CSS pixels for Fitts-law timing. */
  targetWidth?: number;
  /** Override the derived duration. Primarily useful for deterministic callers. */
  durationMs?: number;
  /** Desired interval between emitted points. */
  sampleIntervalMs?: number;
};

const DEFAULT_TARGET_WIDTH_PX = 24;
const DEFAULT_SAMPLE_INTERVAL_MS = 16;
const MIN_DURATION_MS = 80;
const MAX_DURATION_MS = 450;
const MIN_POINTS = 2;
const MAX_POINTS = 32;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Flash-Hogan position polynomial: zero velocity and acceleration at both ends. */
function minimumJerkProgress(normalizedTime: number): number {
  const t = clamp(normalizedTime, 0, 1);
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

/** Derivative of the minimum-jerk position polynomial. */
function minimumJerkVelocity(normalizedTime: number): number {
  const t = clamp(normalizedTime, 0, 1);
  return 30 * t ** 2 - 60 * t ** 3 + 30 * t ** 4;
}

/**
 * Resolve a short movement duration with the Shannon form of Fitts's law.
 * Constants are tuned for automation latency, not presented as biometric data.
 */
function resolvePointerTravelDurationMs(params: {
  start: PointerPosition;
  end: PointerPosition;
  targetWidth?: number;
}): number {
  const distance = Math.hypot(params.end.x - params.start.x, params.end.y - params.start.y);
  if (distance === 0) {
    return 0;
  }
  const targetWidth = Math.max(1, finiteOr(params.targetWidth, DEFAULT_TARGET_WIDTH_PX));
  const indexOfDifficulty = Math.log2(distance / targetWidth + 1);
  return Math.round(clamp(50 + 65 * indexOfDifficulty, MIN_DURATION_MS, MAX_DURATION_MS));
}

/** Build timestamped points with a bell-shaped velocity profile and exact endpoint. */
export function buildMinimumJerkTrajectory(options: PointerTrajectoryOptions): TimedPointerPoint[] {
  const start = {
    x: finiteOr(options.start.x, 0),
    y: finiteOr(options.start.y, 0),
  };
  const end = {
    x: finiteOr(options.end.x, start.x),
    y: finiteOr(options.end.y, start.y),
  };
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance === 0) {
    return [{ t: 0, x: end.x, y: end.y, velocityX: 0, velocityY: 0 }];
  }

  const derivedDuration = resolvePointerTravelDurationMs({
    start,
    end,
    targetWidth: options.targetWidth,
  });
  const durationMs = clamp(
    finiteOr(options.durationMs, derivedDuration),
    MIN_DURATION_MS,
    MAX_DURATION_MS,
  );
  const sampleIntervalMs = clamp(
    finiteOr(options.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS),
    4,
    50,
  );
  const pointCount = clamp(Math.ceil(durationMs / sampleIntervalMs), MIN_POINTS, MAX_POINTS);

  const points: TimedPointerPoint[] = [];
  for (let index = 1; index <= pointCount; index += 1) {
    const normalizedTime = index / pointCount;
    const progress = minimumJerkProgress(normalizedTime);
    const velocityScale = minimumJerkVelocity(normalizedTime) / (durationMs / 1000);
    points.push({
      t: Math.round(durationMs * normalizedTime),
      x: start.x + deltaX * progress,
      y: start.y + deltaY * progress,
      velocityX: deltaX * velocityScale,
      velocityY: deltaY * velocityScale,
    });
  }

  // Avoid accumulated floating-point drift at the only point that can click.
  points[points.length - 1] = {
    t: durationMs,
    x: end.x,
    y: end.y,
    velocityX: 0,
    velocityY: 0,
  };
  return points;
}
