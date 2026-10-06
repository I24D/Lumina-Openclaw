import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import { createCognitiveRuntime } from "../cognition/cognitive-runtime.js";
import { MemoryStateStore } from "../shared/state-store.js";
import type { AuditRecord } from "./audit-log.js";
import { InteractionModes, summarizeActivity, type ModeState } from "./interaction-mode.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const OWNER = { channel: "owner", actor: "dashboard" } as const;
const AGENT = { channel: "agent", actor: "agent" } as const;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const simulatedRuntime = () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-mode-"));
  dirs.push(memoryDir);
  const runtime = createCognitiveRuntime({
    memoryDir,
    autonomyLevel: 4,
    bodyMode: "simulated",
    grantedCapabilities: ["robot.look", "robot.navigate", "robot.grasp", "robot.handover"],
    preAuthorizedCapabilities: ["robot.look", "robot.navigate"],
    awarenessBus: new AwarenessEventBus(),
    emergencyStop: {
      isEngaged: () => false,
      engage: () => undefined,
      onEngage: () => () => undefined,
    },
    environment: () => null,
    working: () => ({
      currentProject: null,
      activeWindow: null,
      activeFile: null,
      currentIntent: null,
      pinnedContext: [],
      updatedAtISO: new Date(NOW).toISOString(),
    }),
    toolNames: () => [],
    now: () => NOW,
    startTimers: false,
  });
  runtime.world.observe({
    id: "kitchen",
    kind: "room",
    label: "kitchen",
    source: "sensor",
    confidence: 1,
  });
  runtime.world.observe({
    id: "cup",
    kind: "object",
    label: "taza",
    position: { placeId: "kitchen" },
    source: "sensor",
    confidence: 1,
  });
  return runtime;
};

describe("interaction modes", () => {
  it("lets the agent narrow into child or maintenance mode, never widen out of them", async () => {
    const modes = new InteractionModes({ now: () => NOW });
    expect((await modes.set("child", AGENT)).ok).toBe(true);
    expect(modes.restrictions().disabledCapabilities).toEqual(["robot.grasp", "robot.handover"]);
    const leave = await modes.set("normal", AGENT);
    expect(leave.ok).toBe(false);
    expect(modes.state().mode).toBe("child");
    expect((await modes.set("maintenance", AGENT)).ok).toBe(false);
    expect((await modes.set("normal", OWNER)).ok).toBe(true);
    expect((await modes.set("companion", AGENT)).ok).toBe(false);
    expect((await modes.set("companion", OWNER)).ok).toBe(true);
    expect((await modes.set("maintenance", AGENT)).ok).toBe(true);
    expect(modes.restrictions().paused).toBe(true);
  });

  it("applies the strictest restrictions until the stored mode is known", async () => {
    const store = new MemoryStateStore<ModeState>();
    await store.register("mode", {
      mode: "child",
      sinceISO: new Date(NOW).toISOString(),
      by: "owner:dashboard",
    });
    const modes = new InteractionModes({ store, now: () => NOW });
    expect(modes.restrictions().paused).toBe(true);
    await modes.ready;
    expect(modes.state().mode).toBe("child");
    expect(modes.restrictions().paused).toBe(false);
    expect(modes.restrictions().disabledCapabilities).toContain("robot.grasp");
  });

  it("summarizes a child session for the guardian from the audit", () => {
    const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
    const record = (atISO: string, action: string, execution: AuditRecord["execution"]) =>
      ({
        atISO,
        action,
        execution,
        actor: "agent",
        reason: "",
        seq: 0,
        prev: "",
        hash: "",
      }) as AuditRecord;
    const summary = summarizeActivity(
      [
        record(at(-5), "body.grasp", "refused"),
        record(at(1), "body.grasp", "refused"),
        record(at(2), "body.look_at", "executed"),
        record(at(3), "privacy.state", "recorded"),
      ],
      at(0),
      at(30),
    );
    expect(summary).toBe(
      "Child mode lasted 30 min with 3 recorded actions: body 2 (1 refused), privacy 1.",
    );
  });

  it("adds to a person's overrides and, on leaving, lifts only what the mode imposed", async () => {
    const runtime = simulatedRuntime();
    await runtime.ready;
    expect((await runtime.modes.set("child", AGENT)).ok).toBe(true);
    const grasp = await runtime.body.request({ type: "grasp", objectId: "cup" });
    expect(grasp.review.verdict).toBe("deny");
    expect(grasp.review.reasons.join(" ")).toContain("robot.grasp");
    // A person also switches grasping off while the child is there.
    await runtime.safety.override({ type: "disable_capability", capability: "robot.grasp" }, OWNER);
    const left = await runtime.modes.set("normal", OWNER);
    expect(left.ok && left.state.lastSummary).toMatch(/^Child mode lasted/u);
    expect(runtime.safety.status().overrides.disabledCapabilities).toEqual(["robot.grasp"]);
    expect((await runtime.body.request({ type: "grasp", objectId: "cup" })).review.verdict).toBe(
      "deny",
    );
    runtime.dispose();
  });

  it("pauses autonomy in maintenance mode without writing a person's pause", async () => {
    const runtime = simulatedRuntime();
    await runtime.ready;
    expect(runtime.loop.getLevel()).toBe(4);
    await runtime.modes.set("maintenance", AGENT);
    expect(runtime.loop.getLevel()).toBe(0);
    expect(runtime.safety.status().overrides.paused).toBe(false);
    const go = await runtime.body.request({ type: "navigate_to", targetId: "kitchen" });
    expect(go.review.verdict).toBe("deny");
    expect(go.review.reasons.join(" ")).toContain("Maintenance mode");
    expect(runtime.selfModel().interactionMode).toBe("maintenance");
    await runtime.modes.set("normal", OWNER);
    expect(runtime.loop.getLevel()).toBe(4);
    runtime.dispose();
  });
});
