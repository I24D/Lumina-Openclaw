import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  configureLuminaCorePolling,
  getCoreState,
  runLuminaCoreCommand,
  stopLuminaCorePolling,
} from "./lumina-core-controller.ts";
import type { CoreStatePayload } from "./lumina-core-types.ts";
import { renderLuminaCore } from "./lumina-core-view.ts";

const hosts: object[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) {
    stopLuminaCorePolling(host);
  }
});

const sample = (overrides: Partial<CoreStatePayload> = {}): CoreStatePayload => ({
  version: "0.1.0",
  model: "ollama-cloud/glm-5.3",
  workspace: {
    currentGoal: null,
    attentionTarget: null,
    activeTask: null,
    userContext: null,
    pendingEvents: 0,
    uncertainty: { staleBeliefs: [] },
  },
  self: { autonomyLevel: 3, body: { mode: "simulated" }, sensors: [], limitations: [] },
  safety: {
    emergencyStop: false,
    overrides: {
      paused: true,
      autonomyCeiling: null,
      disabledCapabilities: [],
      updatedBy: "agent",
    },
    pendingConfirmations: [],
    invariants: [{ id: "stop-always", rule: "Stopping is always allowed.", spec: ["§45"] }],
    audit: { ok: true, entries: 3 },
  },
  privacy: { camera: false, microphone: false, privateMode: false, recording: true },
  people: [
    {
      id: "per_1",
      name: "Dal",
      role: "owner",
      preferences: {},
      consent: { faceRecognition: false, voiceRecognition: false, recording: false },
    },
  ],
  presence: { present: [] },
  world: [],
  health: { overall: "ok", beats: 1, subsystems: [] },
  energy: { detail: "Mains power." },
  robot: null,
  audit: [],
  cycles: [],
  events: [],
  body: [],
  ...overrides,
});

const fakeClient = (respond: (method: string, params: unknown) => unknown) =>
  ({
    request: vi.fn(async (method: string, params: unknown) => respond(method, params)),
  }) as unknown as GatewayBrowserClient & { request: ReturnType<typeof vi.fn> };

describe("Lumina core view", () => {
  it("shows the core's state inside the Control UI, with the owner's controls", () => {
    const host = {};
    hosts.push(host);
    const state = getCoreState(host);
    state.state = sample();
    state.tab = "safety";

    const container = document.createElement("div");
    render(renderLuminaCore({ host, client: null, connected: false }), container);

    expect(container.querySelector(".chip-warn")?.textContent).toContain("Autonomy paused");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Resume");
    expect(buttons).toContain("Turn camera on");
    expect(container.querySelector(".data-table")?.textContent).toContain("stop-always");
  });

  it("lists people with their role and a way to forget them", () => {
    const host = {};
    hosts.push(host);
    const state = getCoreState(host);
    state.state = sample();
    state.tab = "people";

    const container = document.createElement("div");
    render(renderLuminaCore({ host, client: null, connected: false }), container);

    expect(container.textContent).toContain("Dal");
    expect(
      [...container.querySelectorAll("button.danger")].map((b) => b.textContent?.trim()),
    ).toEqual(["Forget"]);
  });
});

describe("Lumina core controller", () => {
  it("runs an owner command, shows a refusal's reason and refreshes", async () => {
    const host = {};
    hosts.push(host);
    const state = getCoreState(host);
    const client = fakeClient((method) =>
      method === "lumina.core.state"
        ? sample()
        : { ok: false, reason: "Only the owner may widen." },
    );
    configureLuminaCorePolling(state, client);

    await runLuminaCoreCommand(state, client, "lumina.core.override", { type: "resume" });

    expect(client.request).toHaveBeenCalledWith("lumina.core.override", { type: "resume" });
    expect(state.notice).toBe("Only the owner may widen.");
    await vi.waitFor(() => expect(state.state?.version).toBe("0.1.0"));
  });

  it("ignores commands from a client it is no longer bound to", async () => {
    const host = {};
    hosts.push(host);
    const state = getCoreState(host);
    const stale = fakeClient(() => ({ ok: true }));
    configureLuminaCorePolling(
      state,
      fakeClient(() => sample()),
    );

    await runLuminaCoreCommand(state, stale, "lumina.core.override", { type: "pause" });

    expect(stale.request).not.toHaveBeenCalled();
  });
});
