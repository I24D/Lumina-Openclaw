import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  configureM3ganPolling,
  getM3ganState,
  runM3ganCommand,
  stopM3ganPolling,
} from "./m3gan-controller.ts";
import type { M3ganStatePayload } from "./m3gan-types.ts";
import { renderM3gan } from "./m3gan-view.ts";

const hosts: object[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) {
    stopM3ganPolling(host);
  }
});

const sample = (overrides: Partial<M3ganStatePayload> = {}): M3ganStatePayload => ({
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

describe("M3GAN view", () => {
  it("shows the core's state inside the Control UI, with the owner's controls", () => {
    const host = {};
    hosts.push(host);
    const state = getM3ganState(host);
    state.state = sample();
    state.tab = "safety";

    const container = document.createElement("div");
    render(renderM3gan({ host, client: null, connected: false }), container);

    expect(container.querySelector(".chip-warn")?.textContent).toContain("Autonomy paused");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Resume");
    expect(buttons).toContain("Turn camera on");
    expect(container.querySelector(".data-table")?.textContent).toContain("stop-always");
  });

  it("lists people with their role and a way to forget them", () => {
    const host = {};
    hosts.push(host);
    const state = getM3ganState(host);
    state.state = sample();
    state.tab = "people";

    const container = document.createElement("div");
    render(renderM3gan({ host, client: null, connected: false }), container);

    expect(container.textContent).toContain("Dal");
    expect(
      [...container.querySelectorAll("button.danger")].map((b) => b.textContent?.trim()),
    ).toEqual(["Forget"]);
  });
});

describe("M3GAN controller", () => {
  it("runs an owner command, shows a refusal's reason and refreshes", async () => {
    const host = {};
    hosts.push(host);
    const state = getM3ganState(host);
    const client = fakeClient((method) =>
      method === "m3gan.state" ? sample() : { ok: false, reason: "Only the owner may widen." },
    );
    configureM3ganPolling(state, client);

    await runM3ganCommand(state, client, "m3gan.override", { type: "resume" });

    expect(client.request).toHaveBeenCalledWith("m3gan.override", { type: "resume" });
    expect(state.notice).toBe("Only the owner may widen.");
    await vi.waitFor(() => expect(state.state?.version).toBe("0.1.0"));
  });

  it("ignores commands from a client it is no longer bound to", async () => {
    const host = {};
    hosts.push(host);
    const state = getM3ganState(host);
    const stale = fakeClient(() => ({ ok: true }));
    configureM3ganPolling(
      state,
      fakeClient(() => sample()),
    );

    await runM3ganCommand(state, stale, "m3gan.override", { type: "pause" });

    expect(stale.request).not.toHaveBeenCalled();
  });
});
