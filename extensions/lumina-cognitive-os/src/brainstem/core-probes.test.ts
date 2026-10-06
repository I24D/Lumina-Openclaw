import { describe, expect, it } from "vitest";
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import { PrivacyControls } from "../privacy/privacy-state.js";
import { AuditLog } from "../safety/audit-log.js";
import { Brainstem } from "./brainstem.js";
import { coreProbes } from "./core-probes.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const environment = (atISO = new Date(NOW).toISOString()): EnvironmentSnapshot => ({
  atISO,
  cpu: { usagePct: 1, cores: 2, loadAvg: [] },
  memory: { totalMB: 1000, freeMB: 500, usedPct: 50 },
  platform: { name: "test", release: "test", hostname: "synthetic", uptimeS: 1 },
  gpus: [],
  battery: null,
  disks: { physical: [], volumes: [] },
  devices: [],
  monitors: [],
  network: { online: true, latencyMs: null, profiles: [], adapters: [] },
});

async function health(env: EnvironmentSnapshot | null, hasBody = false) {
  const audit = new AuditLog({ now: () => NOW });
  await audit.ready;
  const privacy = new PrivacyControls({ now: () => NOW });
  await privacy.ready;
  return new Brainstem({
    now: () => NOW,
    probes: coreProbes({
      environment: () => env,
      energy: () => ({ level: "unknown", action: "none", detail: "unknown" }),
      hasBody,
      persistent: false,
      audit,
      robot: undefined,
      privacy: () => privacy.state(),
      now: () => NOW,
    }),
  }).tick();
}

describe("core health reports only observed health", () => {
  it.each(["invalid", new Date(NOW + 60_000).toISOString(), new Date(NOW - 360_000).toISOString()])(
    "does not mark an invalid, future or old snapshot as current (%s)",
    async (atISO) => {
      const result = await health(environment(atISO));
      expect(result.subsystems.find((entry) => entry.name === "awareness")?.status).toBe(
        "degraded",
      );
      expect(result.subsystems.find((entry) => entry.name === "network")?.status).toBe("degraded");
    },
  );

  it("does not call an unobserved network online", async () => {
    const result = await health(null);
    expect(result.subsystems.find((entry) => entry.name === "network")?.status).toBe("degraded");
  });

  it("distinguishes no body by design from a configured adapter without health telemetry", async () => {
    const desktop = await health(environment());
    const adapter = await health(environment(), true);
    expect(desktop.subsystems.find((entry) => entry.name === "body")?.status).toBe("absent");
    expect(adapter.subsystems.find((entry) => entry.name === "body")?.status).toBe("degraded");
  });

  it("reports a fresh observed connection but not durable state without a store", async () => {
    const result = await health(environment());
    expect(result.subsystems.find((entry) => entry.name === "network")?.status).toBe("ok");
    expect(result.subsystems.find((entry) => entry.name === "stores")?.status).toBe("degraded");
    expect(result.subsystems.find((entry) => entry.name === "audit")?.status).toBe("ok");
  });
});
