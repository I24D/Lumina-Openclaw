import { hybridStrategy } from "./hybrid.js";
/**
 * Strategy registry.
 */
import { naiveCoordsStrategy } from "./naive-coords.js";
import type { ReplayStrategy, StrategyId } from "./types.js";
import { uiaGroundedStrategy } from "./uia-grounded.js";
import { visionGroundedStrategy } from "./vision-grounded.js";
import { windowRelativeStrategy } from "./window-relative.js";

export const STRATEGIES: Record<StrategyId, ReplayStrategy> = {
  naive_coords: naiveCoordsStrategy,
  window_relative: windowRelativeStrategy,
  uia_grounded: uiaGroundedStrategy,
  vision_grounded: visionGroundedStrategy,
  hybrid: hybridStrategy,
};

export function getStrategy(id: string): ReplayStrategy | null {
  return STRATEGIES[id as StrategyId] ?? null;
}
