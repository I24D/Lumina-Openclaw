/**
 * eval-sandbox.ts — The throwaway runtime every evaluation scenario runs in.
 *
 * A temporary folder, session-only stores, a simulated body and no timers, so
 * a scenario can break things on purpose (a store that fails, a motor that
 * throws, a sensor that dies) without touching live state. A scenario may add
 * runtime options to inject exactly the failure it tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import {
  createCognitiveRuntime,
  type CognitiveRuntime,
  type CognitiveRuntimeOptions,
} from "../cognition/cognitive-runtime.js";
import type { WorkingMemory } from "../memory/working-memory.js";

export const EVAL_SUITES = [
  "world",
  "social",
  "memory",
  "robot",
  "resilience",
  "redteam",
  "endurance",
  "performance",
] as const;
export type EvalSuite = (typeof EVAL_SUITES)[number];

export type EvalClock = { now: number };

export type Scenario = {
  readonly suite: EvalSuite;
  readonly name: string;
  /** Extra runtime options, to inject the failure the scenario tests. */
  readonly options?: (clock: EvalClock) => Partial<CognitiveRuntimeOptions>;
  /** Undefined when it passes, or what went wrong. */
  readonly run: (rt: CognitiveRuntime, clock: EvalClock) => Promise<string | undefined>;
};

export const SANDBOX_OWNER = "Evaluator";
export const HOUR = 3_600_000;
export const OWNER = { channel: "owner", actor: "evaluation" } as const;
export const AGENT = { channel: "agent", actor: "agent" } as const;

export function sandbox(
  clock: EvalClock,
  extra: Partial<CognitiveRuntimeOptions> = {},
): { runtime: CognitiveRuntime; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-eval-"));
  const working: WorkingMemory = {
    currentProject: null,
    activeWindow: null,
    activeFile: null,
    currentIntent: null,
    pinnedContext: [],
    updatedAtISO: new Date(clock.now).toISOString(),
  };
  const runtime = createCognitiveRuntime({
    memoryDir: dir,
    autonomyLevel: 4,
    bodyMode: "simulated",
    grantedCapabilities: [
      "robot.stop",
      "robot.look",
      "robot.navigate",
      "robot.grasp",
      "robot.handover",
    ],
    preAuthorizedCapabilities: ["robot.look", "robot.navigate"],
    awarenessBus: new AwarenessEventBus(),
    emergencyStop: {
      isEngaged: () => false,
      engage: () => undefined,
      onEngage: () => () => undefined,
    },
    environment: () => null,
    working: () => working,
    toolNames: () => [],
    now: () => clock.now,
    startTimers: false,
    ownerName: SANDBOX_OWNER,
    ...extra,
  });
  return { runtime, dir };
}
