import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  configureLuminaCorePolling,
  getCoreState,
  runLuminaCoreCommand,
  stopLuminaCorePolling,
} from "./lumina-core-controller.ts";
import type { CoreStatePayload, LuminaCoreTab } from "./lumina-core-types.ts";
import { LuminaCore } from "./lumina-core-view.tsx";

const hosts: object[] = [];
afterEach(() => {
  cleanupSolid();
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

/** Mounts the tab against a client that always answers with `payload`, then opens `tab`. */
async function mountCore(payload: CoreStatePayload, tab: LuminaCoreTab, memoryQuery = "") {
  const client = fakeClient((method) => (method === "lumina.core.state" ? payload : { ok: true }));
  const { container } = mountSolid(() => <LuminaCore initialClient={client} />);
  await waitForSolid(() => expect(container.querySelector(".chip-row")).not.toBeNull());
  const tabButton = container.querySelector<HTMLElement>(`#lumina-core-tab-${tab}`);
  if (tab !== "live") {
    if (memoryQuery) {
      tabButton?.click();
      await waitForSolid(() =>
        expect(container.querySelector(".lumina-core__search input")).not.toBeNull(),
      );
      const input = container.querySelector<HTMLInputElement>(".lumina-core__search input");
      if (input) {
        input.value = memoryQuery;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    } else {
      tabButton?.click();
    }
  }
  await waitForSolid(() => expect(container.querySelector(".lumina-core__panel")).not.toBeNull());
  return container;
}

describe("Lumina core view", () => {
  it("shows the core's state inside the Control UI, with the owner's controls", async () => {
    const container = await mountCore(sample(), "safety");

    await waitForSolid(() =>
      expect(container.querySelector(".data-table")?.textContent).toContain("stop-always"),
    );
    expect(container.querySelector(".chip-warn")?.textContent).toContain("Autonomy paused");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Resume");
    expect(buttons).toContain("Turn camera on");
    expect(container.querySelector(".data-table")?.textContent).toContain("stop-always");
  });

  it("lists people with their role and a way to forget them", async () => {
    const container = await mountCore(sample(), "people");

    await waitForSolid(() => expect(container.querySelector("button.danger")).not.toBeNull());
    expect(container.textContent).toContain("Dal");
    expect(
      [...container.querySelectorAll("button.danger")].map((b) => b.textContent?.trim()),
    ).toEqual(["Forget"]);
  });
});

describe("Lumina core memory view", () => {
  it("filters what Lumina remembers and offers to merge two things with one name", async () => {
    const payload = sample({
      memory: {
        lessons: [
          {
            id: "les_1",
            trigger: "coffee",
            claim: "Dal drinks coffee at 9",
            confidence: 0.7,
            origin: "2 confirmations, 0 contradictions",
            archived: false,
            updatedAtISO: "2026-10-06T12:00:00.000Z",
          },
          {
            id: "les_2",
            trigger: "music",
            claim: "Dal likes silence at night",
            confidence: 0.6,
            origin: "0 confirmations, 0 contradictions",
            archived: true,
            updatedAtISO: "2026-10-06T12:00:00.000Z",
          },
        ],
        episodes: [],
        entities: [
          {
            id: "mug-a",
            label: "taza",
            kind: "object",
            origin: "sensor",
            confidence: 0.9,
            observations: 3,
            lastSeenISO: "2026-10-06T12:00:00.000Z",
          },
          {
            id: "mug-b",
            label: "Taza",
            kind: "object",
            origin: "agent",
            confidence: 0.5,
            observations: 1,
            lastSeenISO: "2026-10-06T11:00:00.000Z",
          },
        ],
        beliefs: [],
      },
    });
    const container = await mountCore(payload, "memory", "coffee");

    await waitForSolid(() => expect(container.textContent).not.toContain("silence at night"));
    expect(container.textContent).toContain("Dal drinks coffee at 9");
    expect(container.textContent).not.toContain("silence at night");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Merge Taza into taza");
    expect(buttons).toContain("Archive");
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
