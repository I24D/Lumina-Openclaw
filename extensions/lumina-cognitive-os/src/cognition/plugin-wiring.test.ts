/**
 * Tests for starting the cognitive core from the plugin entry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanStore } from "../action/action-tools.js";
import { validatePlan } from "../action/planner.js";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import { MemoryStateStore } from "../shared/state-store.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import { ActivityLog } from "../transparency/activity-log.js";
import {
  createToolRecorder,
  hostDeps,
  resolveCognitiveSettings,
  startCognitiveCore,
  type CognitiveCoreDeps,
} from "./plugin-wiring.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCognitiveSettings", () => {
  it("defaults to the conservative setup: on, L3, no body, nothing granted", () => {
    expect(resolveCognitiveSettings(undefined)).toEqual({
      enabled: true,
      autonomyLevel: 3,
      bodyMode: "none",
      grantedCapabilities: [],
      preAuthorizedCapabilities: [],
      ownerName: "Dal",
      perception: expect.objectContaining({ camera: false, voice: false, cameraFps: 1 }),
      physicalConfirmation: false,
      bodySimulator: "symbolic",
      ros2: { url: "ws://127.0.0.1:9090", places: {} },
    });
  });

  it("clamps the level and ignores malformed values", () => {
    expect(resolveCognitiveSettings({ autonomyLevel: 9 }).autonomyLevel).toBe(5);
    expect(resolveCognitiveSettings({ autonomyLevel: -2 }).autonomyLevel).toBe(0);
    expect(resolveCognitiveSettings({ autonomyLevel: "5" }).autonomyLevel).toBe(3);
    expect(resolveCognitiveSettings({ bodyMode: "physical" }).bodyMode).toBe("none");
    expect(
      resolveCognitiveSettings({ grantedCapabilities: ["robot.look", 7, null] })
        .grantedCapabilities,
    ).toEqual(["robot.look"]);
  });

  it("can be turned off", () => {
    expect(resolveCognitiveSettings({ cognitiveCoreEnabled: false }).enabled).toBe(false);
  });
});

describe("createToolRecorder", () => {
  it("forwards every tool to the host and remembers the names", () => {
    const registerTool = vi.fn();
    const recorder = createToolRecorder({ registerTool });
    recorder.register({ name: "a" });
    recorder.register({ name: "b" });

    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(recorder.names()).toEqual(["a", "b"]);
  });
});

const working: WorkingMemory = {
  currentProject: null,
  activeWindow: null,
  activeFile: null,
  currentIntent: null,
  pinnedContext: [],
  updatedAtISO: "2026-10-04T00:00:00.000Z",
};
const testDeps = (
  pluginConfig: unknown,
  registerTool: (tool: AnyAgentTool) => void,
): CognitiveCoreDeps => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-wiring-"));
  dirs.push(memoryDir);
  return {
    live: false,
    pluginConfig,
    memoryDir,
    awarenessBus: new AwarenessEventBus(),
    environment: () => null,
    working: () => working,
    activity: new ActivityLog(),
    toolNames: () => [],
    registerTool,
    liveConfig: () => ({ agents: { defaults: { model: { primary: "ollama-cloud/glm-5.2" } } } }),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
};

describe("startCognitiveCore", () => {
  const deps = testDeps;

  it("registers the core's tools and reads the active model from the live config", () => {
    const registered: string[] = [];
    const core = startCognitiveCore(deps({}, (t) => registered.push(t.name)));

    expect(registered).toHaveLength(18);
    expect(core?.selfModel().activeModel).toBe("ollama-cloud/glm-5.2");
    core?.dispose();
  });

  it("walks registered plans only while nobody has paused the system", async () => {
    const tools = new Map<string, AnyAgentTool>();
    const plans = createPlanStore();
    const core = startCognitiveCore({
      ...deps({}, (t) => tools.set(t.name, t)),
      plans,
    });
    const v = validatePlan({
      goal: "check the mail",
      steps: [{ toolName: "lumina_gmail", description: "read" }],
    });
    if (!core || !v.ok) {
      throw new Error("setup");
    }
    plans.register(v.plan);
    const run = tools.get("lumina_plan_run");
    const next = async () =>
      (await run?.execute("t", { action: "next", planId: v.plan.id }))?.details as { kind: string };

    expect((await next()).kind).toBe("step");
    await core.safety.override({ type: "pause" }, { channel: "agent", actor: "agent" });
    expect((await next()).kind).toBe("blocked");
    core.dispose();
  });

  it("registers nothing when Dal turned the core off", () => {
    const registerTool = vi.fn();
    expect(startCognitiveCore(deps({ cognitiveCoreEnabled: false }, registerTool))).toBeUndefined();
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("logs every body request to the transparency panel", async () => {
    const d = deps({}, () => undefined);
    const core = startCognitiveCore(d);
    await core?.body.request({ type: "look_at", targetId: "dal" });

    expect(d.activity.recent(1)[0]).toMatchObject({
      category: "command",
      summary: "Cuerpo: look_at → deny",
    });
    core?.dispose();
  });
});

describe("hostDeps", () => {
  const api = (registrationMode: "full" | "discovery" | "tool-discovery") => {
    const openKeyedStore = vi.fn(() => new MemoryStateStore());
    const registerHttpRoute = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerControlUiDescriptor = vi.fn();
    const on = vi.fn();
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeat = vi.fn();
    const services: Array<{ id: string; start: () => void }> = [];
    return {
      api: {
        registrationMode,
        pluginConfig: {},
        config: {},
        runtime: {
          state: { openKeyedStore },
          system: { enqueueSystemEvent, requestHeartbeat },
        },
        logger: { info: vi.fn(), warn: vi.fn() },
        registerHttpRoute,
        registerGatewayMethod,
        registerService: (service: { id: string; start: () => void }) => services.push(service),
        session: { controls: { registerControlUiDescriptor } },
        on,
      } as unknown as Parameters<typeof hostDeps>[0],
      openKeyedStore,
      registerHttpRoute,
      registerGatewayMethod,
      registerControlUiDescriptor,
      on,
      enqueueSystemEvent,
      requestHeartbeat,
      services,
    };
  };

  it("gives durable state and the dashboard only to the live gateway", async () => {
    const live = api("full");
    const deps = hostDeps(live.api);
    expect(deps.live).toBe(true);
    const store = deps.openStore?.<string>("m3gan.audit");
    const read = store?.entries();
    // Opened during registration the handle would lose its admission; it opens with the service.
    await Promise.resolve();
    expect(live.openKeyedStore).not.toHaveBeenCalled();
    expect(live.services.map((s) => s.id)).toEqual(["m3gan-state"]);
    live.services[0]?.start();
    await expect(read).resolves.toEqual([]);
    expect(live.openKeyedStore).toHaveBeenCalledWith({
      namespace: "m3gan.audit",
      retention: "retained",
    });
    const core = startCognitiveCore({ ...testDeps({}, () => undefined), ...deps });
    // The owner channel is a native Control UI tab over gateway methods, plus /health.
    expect(live.registerHttpRoute).toHaveBeenCalledOnce();
    expect(live.registerGatewayMethod.mock.calls.map(([method]) => method)).toContain(
      "m3gan.state",
    );
    expect(live.registerControlUiDescriptor.mock.calls[0]?.[0]).not.toHaveProperty("path");
    // Child mode's guidance and screen ride on the conversation hooks.
    expect(live.on.mock.calls.map(([hook]) => hook)).toEqual([
      "before_prompt_build",
      "before_agent_finalize",
      "reply_payload_sending",
      "message_sending",
    ]);
    core?.dispose();
  });

  it("wakes the owner's agent by its full session key, never the ambiguous bare main", () => {
    const live = api("full");
    hostDeps(live.api).initiative?.({ key: "greet-owner", text: "Dal just arrived." });
    expect(live.enqueueSystemEvent).toHaveBeenCalledWith("[M3GAN] Dal just arrived.", {
      sessionKey: "agent:main:main",
      contextKey: "m3gan:greet-owner",
      replace: true,
    });
    expect(live.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", intent: "immediate" }),
    );
  });

  it("keeps discovery loads session-only, so two processes never share a log", () => {
    for (const mode of ["discovery", "tool-discovery"] as const) {
      const deps = hostDeps(api(mode).api);
      expect(deps.live).toBe(false);
      expect(deps.openStore).toBeUndefined();
      expect(deps.dashboard).toBeUndefined();
      expect(deps.conversationHooks).toBeUndefined();
    }
  });
});
