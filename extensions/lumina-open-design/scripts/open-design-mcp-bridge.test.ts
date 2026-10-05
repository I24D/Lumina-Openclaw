import { describe, expect, it } from "vitest";
import {
  chooseLaunchPlan,
  headlessDaemonPlan,
  type OpenDesignSpawnPlan,
  studioLaunchAllowed,
  studioPlan,
  waitForDaemon,
} from "./open-design-mcp-bridge.cjs";

const HEADLESS_URL = "http://127.0.0.1:7456";
const STUDIO_URL = "http://127.0.0.1:51234";

const studioClosed = () => Promise.reject(new Error("connect ENOENT pipe"));

describe("open-design MCP bridge launch plans", () => {
  it("describes the daemon as windowless", () => {
    const plan = headlessDaemonPlan();
    expect(plan.args).toContain("--no-open");
    expect(plan.options.windowsHide).toBe(true);
    // ELECTRON_RUN_AS_NODE is what stops Electron from creating a window at all.
    expect(plan.options.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("describes the Studio as a real window", () => {
    const plan = studioPlan();
    expect(plan.args).toHaveLength(0);
    expect(plan.options.windowsHide).toBe(false);
    expect(plan.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("prefers the windowless daemon unless the Studio is explicitly requested", () => {
    expect(studioLaunchAllowed({})).toBe(false);
    expect(studioLaunchAllowed({ OD_LAUNCH_STUDIO: "0" })).toBe(false);
    expect(studioLaunchAllowed({ OD_LAUNCH_STUDIO: "1" })).toBe(true);

    expect(chooseLaunchPlan({}).options.windowsHide).toBe(true);
    expect(chooseLaunchPlan({ OD_LAUNCH_STUDIO: "1" }).options.windowsHide).toBe(false);
  });
});

describe("open-design MCP bridge daemon discovery", () => {
  it("reuses the Studio the user already has open", async () => {
    const launched: OpenDesignSpawnPlan[] = [];
    await expect(
      waitForDaemon({
        launch: (plan) => launched.push(plan),
        discoverDaemonUrl: async () => STUDIO_URL,
        probeHeadlessDaemon: async () => HEADLESS_URL,
        env: {},
      }),
    ).resolves.toBe(STUDIO_URL);
    expect(launched).toHaveLength(0);
  });

  it("reuses the headless daemon instead of opening the Studio window", async () => {
    const launched: OpenDesignSpawnPlan[] = [];
    await expect(
      waitForDaemon({
        launch: (plan) => launched.push(plan),
        discoverDaemonUrl: studioClosed,
        probeHeadlessDaemon: async () => HEADLESS_URL,
        env: {},
      }),
    ).resolves.toBe(HEADLESS_URL);
    // The regression: a closed Studio used to fall straight through to launching it.
    expect(launched).toHaveLength(0);
  });

  it("starts a windowless daemon when nothing is serving", async () => {
    const launched: OpenDesignSpawnPlan[] = [];
    let probes = 0;
    await expect(
      waitForDaemon({
        launch: (plan) => launched.push(plan),
        discoverDaemonUrl: studioClosed,
        probeHeadlessDaemon: async () => (++probes > 1 ? HEADLESS_URL : null),
        env: {},
      }),
    ).resolves.toBe(HEADLESS_URL);

    expect(launched).toHaveLength(1);
    expect(launched[0]!.options.windowsHide).toBe(true);
    expect(launched[0]!.args).toContain("--no-open");
  });

  it("opens the Studio window only when explicitly asked to", async () => {
    const launched: OpenDesignSpawnPlan[] = [];
    let probes = 0;
    await expect(
      waitForDaemon({
        launch: (plan) => launched.push(plan),
        discoverDaemonUrl: studioClosed,
        probeHeadlessDaemon: async () => (++probes > 1 ? HEADLESS_URL : null),
        env: { OD_LAUNCH_STUDIO: "1" },
      }),
    ).resolves.toBe(HEADLESS_URL);

    expect(launched).toHaveLength(1);
    expect(launched[0]!.options.windowsHide).toBe(false);
    expect(launched[0]!.args).toHaveLength(0);
  });
});
