/**
 * Tests for the brainstem and the energy policy.
 */
import { describe, expect, it, vi } from "vitest";
import { Brainstem, type Probe, type ProbeResult } from "./brainstem.js";
import { assessEnergy } from "./energy.js";

const NOW = Date.parse("2026-10-05T02:00:00.000Z");

const probe = (name: string, critical: boolean, results: ProbeResult[]): Probe => {
  let i = 0;
  return {
    name,
    critical,
    check: () => results[Math.min(i++, results.length - 1)] as ProbeResult,
  };
};

describe("Brainstem", () => {
  it("reports ok when every subsystem is fine or absent by design", async () => {
    const stem = new Brainstem({
      now: () => NOW,
      probes: [
        probe("network", false, [{ status: "ok", detail: "online" }]),
        probe("camera", false, [{ status: "absent", detail: "no camera" }]),
      ],
    });
    const snap = await stem.tick();
    expect(snap.overall).toBe("ok");
    expect(snap.beats).toBe(1);
  });

  it("isolates once when a critical subsystem goes down, and never resumes on its own", async () => {
    const onCriticalDown = vi.fn();
    const onRecovered = vi.fn();
    const stem = new Brainstem({
      now: () => NOW,
      onCriticalDown,
      onRecovered,
      probes: [
        probe("audit", true, [
          { status: "ok", detail: "chain intact" },
          { status: "down", detail: "chain broken" },
          { status: "down", detail: "chain broken" },
          { status: "ok", detail: "chain intact" },
        ]),
      ],
    });
    await stem.tick();
    expect((await stem.tick()).overall).toBe("down");
    await stem.tick();
    expect(onCriticalDown).toHaveBeenCalledOnce();

    await stem.tick();
    // Recovery is recorded; resuming autonomy is left to a person.
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it("turns a probe that throws into a finding instead of crashing", async () => {
    const stem = new Brainstem({
      now: () => NOW,
      probes: [
        {
          name: "store",
          critical: false,
          check: () => {
            throw new Error("sqlite locked");
          },
        },
      ],
    });
    const snap = await stem.tick();
    expect(snap.subsystems[0]).toMatchObject({
      status: "down",
      detail: "Probe failed: sqlite locked",
    });
    expect(snap.overall).toBe("degraded");
  });

  it("keeps beating when a reaction fails", async () => {
    const stem = new Brainstem({
      now: () => NOW,
      onDegraded: () => {
        throw new Error("notifier down");
      },
      probes: [probe("network", false, [{ status: "degraded", detail: "offline" }])],
    });
    await expect(stem.tick()).resolves.toMatchObject({ overall: "degraded" });
  });
});

describe("assessEnergy", () => {
  it("says nothing is wrong on mains power or while charging", () => {
    expect(assessEnergy({ battery: null, hasBody: false }).action).toBe("none");
    expect(assessEnergy({ battery: { percent: 3, charging: true }, hasBody: true }).level).toBe(
      "ok",
    );
  });

  it("sends a body with a known charger to charge when low", () => {
    expect(
      assessEnergy({ battery: { percent: 15, charging: false }, hasBody: true, chargerId: "dock" }),
    ).toMatchObject({ level: "low", action: "go_charge" });
  });

  it("stops a body at critical charge when no charger is known", () => {
    expect(assessEnergy({ battery: { percent: 4, charging: false }, hasBody: true })).toMatchObject(
      {
        level: "critical",
        action: "safe_state",
      },
    );
  });
});
