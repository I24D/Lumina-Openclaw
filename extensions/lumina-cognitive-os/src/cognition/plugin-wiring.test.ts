/**
 * Tests for starting the cognitive core from the plugin entry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import type { AnyAgentTool } from "../shared/tool-result.js";
import { ActivityLog } from "../transparency/activity-log.js";
import {
  createToolRecorder,
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

describe("startCognitiveCore", () => {
  const working: WorkingMemory = {
    currentProject: null,
    activeWindow: null,
    activeFile: null,
    currentIntent: null,
    pinnedContext: [],
    updatedAtISO: "2026-10-04T00:00:00.000Z",
  };
  const deps = (
    pluginConfig: unknown,
    registerTool: (tool: AnyAgentTool) => void,
  ): CognitiveCoreDeps => {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-wiring-"));
    dirs.push(memoryDir);
    return {
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

  it("registers the core's tools and reads the active model from the live config", () => {
    const registered: string[] = [];
    const core = startCognitiveCore(deps({}, (t) => registered.push(t.name)));

    expect(registered).toHaveLength(6);
    expect(core?.selfModel().activeModel).toBe("ollama-cloud/glm-5.2");
    core?.dispose();
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
