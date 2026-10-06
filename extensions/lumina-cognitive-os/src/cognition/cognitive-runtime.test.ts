/**
 * End-to-end tests for the assembled cognitive core, driven through its tools.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import type { AuditRecord } from "../safety/audit-log.js";
import type { OverrideState } from "../safety/overrides.js";
import { MemoryStateStore } from "../shared/state-store.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import type { Observation } from "../world/world-model.js";
import { createCognitiveRuntime, type CognitiveRuntimeOptions } from "./cognitive-runtime.js";

const NOW = Date.parse("2026-10-04T20:41:00.000Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const working: WorkingMemory = {
  currentProject: null,
  activeWindow: { processName: "Code", title: "LUMINA" },
  activeFile: null,
  currentIntent: "desarrollar LUMINA",
  pinnedContext: [],
  updatedAtISO: new Date(NOW).toISOString(),
};

const runtimeWith = (extra: Partial<CognitiveRuntimeOptions> = {}) => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-runtime-"));
  dirs.push(memoryDir);
  let engaged = false;
  const bus = new AwarenessEventBus();
  const runtime = createCognitiveRuntime({
    memoryDir,
    autonomyLevel: 4,
    bodyMode: "none",
    grantedCapabilities: [],
    preAuthorizedCapabilities: [],
    awarenessBus: bus,
    emergencyStop: {
      isEngaged: () => engaged,
      engage: () => {
        engaged = true;
      },
      onEngage: () => () => undefined,
    },
    environment: () => null,
    working: () => working,
    toolNames: () => ["lumina_risk_evaluate"],
    activeModel: () => "ollama-cloud/glm-5.2",
    now: () => NOW,
    ...extra,
  });
  return { runtime, bus, engage: () => void (engaged = true) };
};

/** Run a tool and return its JSON payload. */
const call = async (
  tools: ReadonlyArray<AnyAgentTool>,
  name: string,
  params: Record<string, unknown>,
) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`no tool ${name}`);
  }
  const result = (await tool.execute(
    "call",
    params as never,
    undefined as never,
    undefined as never,
  )) as {
    details?: unknown;
    content?: Array<{ text?: string }>;
  };
  return (result.details ?? JSON.parse(result.content?.[0]?.text ?? "{}")) as Record<string, any>;
};

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("createCognitiveRuntime", () => {
  it("exposes safety status honestly through the registered body tool", async () => {
    const { runtime } = runtimeWith();
    const status = await call(runtime.tools, "lumina_body", { action: "status" });
    expect(status.safety.integration).toEqual({
      persistence: "session-only",
      ownerApproval: "not-connected",
      scope: "cognitive-core-and-body",
    });
    expect(status.mode).toBe("none");
    expect(status.safety.audit.ok).toBe(true);
    runtime.dispose();
  });

  it("reports a modified motion as successful and stops for a person within reach", async () => {
    const { runtime } = runtimeWith({
      bodyMode: "simulated",
      grantedCapabilities: ["robot.navigate"],
      preAuthorizedCapabilities: ["robot.navigate"],
    });
    runtime.world.observe({
      id: "room",
      kind: "room",
      label: "Room",
      source: "sensor",
      confidence: 1,
    });
    runtime.world.observe({
      id: "person",
      kind: "person",
      label: "Person",
      source: "sensor",
      confidence: 1,
      position: { distanceM: 1 },
    });
    const result = await call(runtime.tools, "lumina_body", {
      action: "request",
      type: "navigate_to",
      targetId: "room",
    });
    expect(result.ok).toBe(true);
    expect(result.review).toMatchObject({
      verdict: "modify",
      limits: { maxSpeedMps: 0.15, maxForceN: 3 },
    });
    runtime.world.observe({
      id: "person",
      kind: "person",
      label: "Person",
      source: "sensor",
      confidence: 1,
      position: { distanceM: 0.2 },
    });
    const stopped = await call(runtime.tools, "lumina_body", {
      action: "request",
      type: "navigate_to",
      targetId: "room",
    });
    expect(stopped.review.verdict).toBe("stop");
    expect(stopped.ok).toBe(false);
    runtime.dispose();
  });

  it("applies a human pause to the loop and body, and refuses agent resumption", async () => {
    const { runtime } = runtimeWith({
      bodyMode: "simulated",
      grantedCapabilities: ["robot.gesture"],
    });
    await runtime.safety.override({ type: "pause" }, { channel: "owner", actor: "test-owner" });
    expect(runtime.loop.getLevel()).toBe(0);
    expect(
      (
        await call(runtime.tools, "lumina_body", {
          action: "request",
          type: "gesture",
          name: "wave",
        })
      ).review.verdict,
    ).toBe("deny");
    const resumed = await runtime.safety.override(
      { type: "resume" },
      { channel: "agent", actor: "model" },
    );
    expect(resumed).toMatchObject({ ok: false, tamper: true });
    expect(runtime.safety.status().emergencyStop).toBe(true);
    expect(runtime.safety.status().audit.ok).toBe(true);
    runtime.dispose();
  });

  it("does not turn an invalid body action into an execution request", async () => {
    const { runtime } = runtimeWith();
    await expect(
      call(runtime.tools, "lumina_body", { action: "approve", type: "stop" }),
    ).rejects.toThrow("action must be one of");
    expect(runtime.body.recent()).toHaveLength(0);
    runtime.dispose();
  });
  it("exposes the cognitive-core tools", () => {
    const { runtime } = runtimeWith();
    expect(runtime.tools.map((t) => t.name)).toEqual([
      "lumina_workspace",
      "lumina_self_model",
      "lumina_goal",
      "lumina_world_observe",
      "lumina_world_query",
      "lumina_body",
      "lumina_behavior",
      "lumina_safety",
      "lumina_explain",
      "lumina_privacy",
      "lumina_people",
      "lumina_mind",
      "lumina_health",
      "lumina_reflect",
      "lumina_mode",
      "lumina_practice",
      "lumina_artifacts",
    ]);
    runtime.dispose();
  });

  it("carries an awareness event through the router into a cycle the workspace shows", async () => {
    const { runtime, bus } = runtimeWith();
    bus.emit({ kind: "battery.critical", percent: 4 });
    await settle();

    const { workspace } = await call(runtime.tools, "lumina_workspace", {});
    expect(workspace.recentEvents[0]).toMatchObject({
      source: "awareness",
      kind: "battery.critical",
      admitted: true,
    });
    // Observe-only: the cycle ran, nothing was executed.
    expect(workspace.activeTask).toMatchObject({ event: "battery.critical", executed: false });
    expect(workspace.userContext).toEqual({
      intent: "desarrollar LUMINA",
      activeWindow: "LUMINA",
      pinned: [],
    });
    runtime.dispose();
  });

  it("remembers what the user says about the world and answers where things are", async () => {
    const { runtime } = runtimeWith();
    await call(runtime.tools, "lumina_world_observe", {
      kind: "room",
      label: "cocina",
      id: "kitchen",
      confidence: 1,
    });
    const keys = await call(runtime.tools, "lumina_world_observe", {
      kind: "object",
      label: "llaves",
      placeId: "kitchen",
      confidence: 1,
    });
    // An agent claim is capped below sensor evidence.
    expect(keys.entity.confidence).toBe(0.9);
    expect(keys.entity.source).toBe("agent");

    const where = await call(runtime.tools, "lumina_world_query", {
      action: "where",
      target: "llaves",
    });
    expect(where.chain).toEqual(["llaves", "cocina"]);
    runtime.dispose();
  });

  it("keeps goals and puts the top one in the workspace and self model", async () => {
    const { runtime } = runtimeWith();
    const created = await call(runtime.tools, "lumina_goal", {
      action: "create",
      title: "Construir LUMINA",
      priority: 5,
    });
    expect(created.goal.title).toBe("Construir LUMINA");

    const { workspace } = await call(runtime.tools, "lumina_workspace", {});
    expect(workspace.currentGoal.title).toBe("Construir LUMINA");
    const { self } = await call(runtime.tools, "lumina_self_model", {});
    expect(self.currentTasks[0].title).toBe("Construir LUMINA");

    const done = await call(runtime.tools, "lumina_goal", {
      action: "complete",
      id: created.goal.id,
    });
    expect(done.goal.status).toBe("done");
    runtime.dispose();
  });

  it("knows it has no body on a desktop and refuses to pretend otherwise", async () => {
    const { runtime } = runtimeWith();
    const { self } = await call(runtime.tools, "lumina_self_model", {});
    expect(self.body.mode).toBe("none");
    expect(self.activeModel).toBe("ollama-cloud/glm-5.2");
    expect(self.capabilities).toContain("lumina_risk_evaluate");

    const moved = await call(runtime.tools, "lumina_body", {
      action: "request",
      type: "navigate_to",
      targetId: "kitchen",
    });
    expect(moved.ok).toBe(false);
    expect(moved.review.verdict).toBe("deny");
    runtime.dispose();
  });

  it("moves a simulated body only with Dal's grant and pre-authorization", async () => {
    const { runtime } = runtimeWith({
      bodyMode: "simulated",
      grantedCapabilities: ["robot.navigate", "robot.fly"],
      preAuthorizedCapabilities: ["robot.navigate", "robot.grasp"],
    });
    runtime.world.observe({
      id: "kitchen",
      kind: "room",
      label: "cocina",
      confidence: 1,
      source: "sensor",
    });

    const moved = await call(runtime.tools, "lumina_body", {
      action: "request",
      type: "navigate_to",
      targetId: "kitchen",
    });
    expect(moved.ok).toBe(true);
    expect(runtime.selfModel().body.placeId).toBe("kitchen");

    // Unknown capabilities are dropped, and pre-authorizing something not granted grants nothing.
    expect(runtime.selfModel().capabilities).not.toContain("robot.fly");
    const grasp = await call(runtime.tools, "lumina_body", {
      action: "review",
      type: "grasp",
      objectId: "kitchen",
    });
    expect(grasp.review.verdict).toBe("deny");
    runtime.dispose();
  });

  it("refuses all motion while the emergency stop is engaged", async () => {
    const { runtime, engage } = runtimeWith({
      bodyMode: "simulated",
      grantedCapabilities: ["robot.look"],
    });
    runtime.world.observe({
      id: "dal",
      kind: "person",
      label: "Dal",
      confidence: 0.99,
      source: "sensor",
    });
    engage();

    const look = await call(runtime.tools, "lumina_body", {
      action: "request",
      type: "look_at",
      targetId: "dal",
    });
    expect(look.review.verdict).toBe("deny");
    expect(runtime.selfModel().limitations[0]).toContain("Emergency stop");
    runtime.dispose();
  });

  it("persists the world, goals, a person's overrides and the audit chain across a restart", async () => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-runtime-"));
    dirs.push(memoryDir);
    const stores = {
      world: new MemoryStateStore<Observation>(),
      overrides: new MemoryStateStore<OverrideState>(),
      audit: new MemoryStateStore<AuditRecord>(),
    };
    const first = runtimeWith({ memoryDir, stores }).runtime;
    await first.ready;
    await call(first.tools, "lumina_world_observe", {
      kind: "object",
      label: "cargador",
      confidence: 0.8,
    });
    await call(first.tools, "lumina_goal", { action: "create", title: "Cargar batería" });
    await first.safety.override(
      { type: "disable_capability", capability: "robot.navigate" },
      { channel: "owner", actor: "Dal" },
    );
    await first.flush();
    first.dispose();

    const second = runtimeWith({ memoryDir, stores }).runtime;
    // Until stored orders are known, the system counts as paused.
    expect(second.safety.status().overrides.paused).toBe(true);
    await second.ready;
    expect(second.world.find("cargador")).toBeDefined();
    expect(second.goals.open().map((g) => g.title)).toEqual(["Cargar batería"]);
    expect(second.safety.status().overrides).toMatchObject({
      paused: false,
      disabledCapabilities: ["robot.navigate"],
    });
    // The chain continues where the first process left it, and the stored copy verifies.
    await second.safety.override({ type: "stop_motion" }, { channel: "agent", actor: "agent" });
    await second.flush();
    const stored = await second.safety.verifyStoredAudit();
    expect(stored.ok).toBe(true);
    expect(stored.entries).toBeGreaterThan(1);
    second.dispose();
  });

  it("stops feeding the loop once disposed", async () => {
    const { runtime, bus } = runtimeWith();
    runtime.dispose();
    bus.emit({ kind: "network.offline" });
    await settle();
    expect(runtime.router.recent()).toHaveLength(0);
  });
});
