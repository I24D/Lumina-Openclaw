/**
 * Tests for the owner channel, its gateway methods and the health routes.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AwarenessEventBus } from "../awareness/event-bus.js";
import { createCognitiveRuntime, type CognitiveRuntime } from "../cognition/cognitive-runtime.js";
import type { WorkingMemory } from "../memory/working-memory.js";
import { registerM3ganGatewayMethods } from "./gateway-methods.js";
import { createM3ganHealthHandler, M3GAN_HEALTH_PATH } from "./health-http.js";
import { createOwnerCommands, m3ganState, OwnerChannelError } from "./owner-channel.js";

const NOW = Date.parse("2026-10-05T04:00:00.000Z");
const dirs: string[] = [];
const runtimes: CognitiveRuntime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) {
    r.dispose();
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const working: WorkingMemory = {
  currentProject: null,
  activeWindow: null,
  activeFile: null,
  currentIntent: null,
  pinnedContext: [],
  updatedAtISO: new Date(NOW).toISOString(),
};

const setup = () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-owner-"));
  dirs.push(memoryDir);
  const runtime = createCognitiveRuntime({
    memoryDir,
    autonomyLevel: 3,
    bodyMode: "none",
    grantedCapabilities: [],
    preAuthorizedCapabilities: [],
    awarenessBus: new AwarenessEventBus(),
    emergencyStop: {
      isEngaged: () => false,
      engage: () => undefined,
      onEngage: () => () => undefined,
    },
    environment: () => null,
    working: () => working,
    toolNames: () => [],
    now: () => NOW,
    startTimers: false,
    ownerName: "Dal",
  });
  runtimes.push(runtime);
  const rearm = vi.fn();
  const deps = {
    runtime,
    version: "0.1.0",
    rearmEmergencyStop: rearm,
    activeModel: () => "ollama-cloud/glm-5.2",
  };
  return { runtime, deps, commands: createOwnerCommands(deps), rearm };
};

describe("m3ganState", () => {
  it("returns the whole picture in one call", async () => {
    const { runtime, deps } = setup();
    await runtime.ready;
    runtime.world.observe({
      id: "kitchen",
      kind: "room",
      label: "cocina",
      confidence: 1,
      source: "sensor",
    });
    runtime.world.observe({
      id: "cup",
      kind: "object",
      label: "taza",
      position: { placeId: "kitchen" },
      confidence: 0.9,
      source: "sensor",
    });

    const s = m3ganState(deps);
    expect(s.model).toBe("ollama-cloud/glm-5.2");
    expect(s.people.map((p) => p.name)).toEqual(["Dal"]);
    expect(s.world[0]).toMatchObject({ label: "cocina", children: [{ label: "taza" }] });
    expect(s.safety.invariants.length).toBeGreaterThan(10);
    expect(s.privacy.camera).toBe(true);
  });
});

describe("owner commands", () => {
  it("let the owner resume what the agent paused", async () => {
    const { runtime, commands } = setup();
    await runtime.ready;
    await runtime.safety.override({ type: "pause" }, { channel: "agent", actor: "agent" });
    expect(runtime.loop.getLevel()).toBe(0);

    expect(await commands["m3gan.override"]({ type: "resume" })).toMatchObject({ ok: true });
    expect(runtime.loop.getLevel()).toBe(3);
  });

  it("let the owner turn a sensor back on", async () => {
    const { runtime, commands } = setup();
    await runtime.ready;
    runtime.privacy.set({ camera: false }, { channel: "agent", actor: "agent" });
    await commands["m3gan.privacy"]({ camera: true });
    expect(runtime.privacy.state().camera).toBe(true);
  });

  it("re-arm the emergency stop only here, and audit it", async () => {
    const { runtime, commands, rearm } = setup();
    await runtime.ready;
    await commands["m3gan.estop.rearm"]();
    expect(rearm).toHaveBeenCalledOnce();
    expect(runtime.audit.recent(1)[0]).toMatchObject({
      actor: "owner:dashboard",
      action: "estop.rearm",
    });
  });

  it("assign roles and recognition consent as the owner", async () => {
    const { runtime, commands } = setup();
    await runtime.ready;
    const cady = runtime.people.remember({ name: "Cady" }, { channel: "agent", actor: "agent" });
    if (!cady.ok) {
      throw new Error("setup");
    }
    await commands["m3gan.people.role"]({ personId: cady.person.id, role: "user" });
    await commands["m3gan.people.consent"]({ personId: cady.person.id, voiceRecognition: true });
    expect(runtime.people.get(cady.person.id)).toMatchObject({
      role: "user",
      consent: { voiceRecognition: true },
    });
  });

  it("refuse malformed requests without touching anything", async () => {
    const { commands } = setup();
    await expect(commands["m3gan.override"]({ type: "make_me_owner" })).rejects.toBeInstanceOf(
      OwnerChannelError,
    );
    await expect(
      commands["m3gan.people.role"]({ personId: "x", role: "god" }),
    ).rejects.toBeInstanceOf(OwnerChannelError);
    await expect(commands["m3gan.teleop"]({ personId: "x", type: "punch" })).rejects.toBeInstanceOf(
      OwnerChannelError,
    );
  });
});

describe("gateway methods", () => {
  type Registered = {
    handler: (options: GatewayRequestHandlerOptions) => Promise<void>;
    options: { scope: string };
  };
  const register = () => {
    const context = setup();
    const methods = new Map<string, Registered>();
    registerM3ganGatewayMethods(
      {
        registerGatewayMethod: ((method, handler, options) => {
          methods.set(method, { handler, options } as unknown as Registered);
        }) as Parameters<typeof registerM3ganGatewayMethods>[0]["registerGatewayMethod"],
      },
      context.deps,
    );
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const respond = vi.fn();
      await methods
        .get(method)
        ?.handler({ params, respond } as unknown as GatewayRequestHandlerOptions);
      return respond.mock.calls[0] as [boolean, unknown, { code: string } | undefined];
    };
    return { ...context, methods, call };
  };

  it("reads with operator.read and changes anything only with operator.write", () => {
    const { methods } = register();
    expect(methods.get("m3gan.state")?.options.scope).toBe("operator.read");
    expect(methods.get("m3gan.audit.verify")?.options.scope).toBe("operator.read");
    for (const name of ["m3gan.override", "m3gan.privacy", "m3gan.teleop", "m3gan.estop.rearm"]) {
      expect(methods.get(name)?.options.scope).toBe("operator.write");
    }
  });

  it("answers the state and reports a malformed request as invalid", async () => {
    const { runtime, call } = register();
    await runtime.ready;
    const [ok, state] = await call("m3gan.state");
    expect(ok).toBe(true);
    expect(state).toMatchObject({ version: "0.1.0" });

    const [failed, , error] = await call("m3gan.override", { type: "make_me_owner" });
    expect(failed).toBe(false);
    expect(error?.code).toBe("INVALID_REQUEST");
  });
});

describe("health routes", () => {
  type Captured = { status: number; body: string };
  const get = async (
    handler: ReturnType<typeof createM3ganHealthHandler>,
    route: string,
    method = "GET",
  ) => {
    const req = Object.assign(Readable.from([]), {
      method,
      url: route,
    }) as unknown as IncomingMessage;
    const captured: Captured = { status: 0, body: "" };
    const res = {
      writeHead(status: number) {
        captured.status = status;
        return this;
      },
      end(payload: string) {
        captured.body = payload;
      },
    } as unknown as ServerResponse;
    const handled = await handler(req, res);
    return {
      handled,
      ...captured,
      json: () => JSON.parse(captured.body) as Record<string, unknown>,
    };
  };

  it("serve /health, /ready and /version, and nothing else", async () => {
    const { runtime } = setup();
    await runtime.ready;
    const handler = createM3ganHealthHandler({ runtime, version: "0.1.0" });
    await Promise.resolve();
    expect((await get(handler, `${M3GAN_HEALTH_PATH}/health`)).json().status).toBeDefined();
    expect((await get(handler, `${M3GAN_HEALTH_PATH}/ready`)).status).toBe(200);
    expect((await get(handler, `${M3GAN_HEALTH_PATH}/version`)).json()).toEqual({
      plugin: "lumina-cognitive-os",
      version: "0.1.0",
    });
    expect((await get(handler, `${M3GAN_HEALTH_PATH}/api/state`)).status).toBe(404);
    expect((await get(handler, `${M3GAN_HEALTH_PATH}/health`, "POST")).status).toBe(405);
    expect((await get(handler, "/plugins/other")).handled).toBe(false);
  });
});
