import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { Page } from "playwright-core";
import { buildMinimumJerkTrajectory, type PointerPosition } from "./pointer-trajectory.js";

// Playwright initializes its synthetic pointer at the viewport origin. Keep a
// page-local estimate so later coordinate actions form one continuous path.
const pointerPositions = new WeakMap<Page, PointerPosition>();

export async function movePointerWithMinimumJerk(params: {
  page: Page;
  target: PointerPosition;
  signal?: AbortSignal;
  targetWidth?: number;
}): Promise<void> {
  const start = pointerPositions.get(params.page) ?? { x: 0, y: 0 };
  const points = buildMinimumJerkTrajectory({
    start,
    end: params.target,
    targetWidth: params.targetWidth,
  });
  let previousTime = 0;

  for (const point of points) {
    params.signal?.throwIfAborted();
    const waitMs = point.t - previousTime;
    if (waitMs > 0) {
      await sleepWithAbort(waitMs, params.signal);
    }
    params.signal?.throwIfAborted();
    await params.page.mouse.move(point.x, point.y);
    pointerPositions.set(params.page, { x: point.x, y: point.y });
    previousTime = point.t;
  }
}
