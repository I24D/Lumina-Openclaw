/**
 * Tests for durable safety state: the audit chain and human overrides.
 */
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { AuditLog, type AuditRecord } from "./audit-log.js";
import { HumanOverrides, type OverrideState } from "./overrides.js";

const entry = (reason: string) =>
  ({ actor: "test", action: "observe", reason, execution: "recorded" }) as const;

describe("durable audit chain", () => {
  it("chains across a restart instead of forking", async () => {
    const store = new MemoryStateStore<AuditRecord>();
    const first = new AuditLog({ store, now: () => 0 });
    await first.ready;
    first.append(entry("one"));
    first.append(entry("two"));
    await first.flush();

    const second = new AuditLog({ store, now: () => 0 });
    // Written before loading finished: it waits and is chained after the stored tail.
    const provisional = second.append(entry("three"));
    expect(provisional.seq).toBe(0);
    await second.flush();

    expect(second.size).toBe(3);
    expect(second.verify()).toEqual({ ok: true, entries: 3 });
    expect(await second.verifyStored()).toEqual({ ok: true, entries: 3 });
  });

  it("detects an entry altered in the database after it was written", async () => {
    const store = new MemoryStateStore<AuditRecord>();
    const audit = new AuditLog({ store, now: () => 0 });
    await audit.ready;
    audit.append(entry("granted nothing"));
    audit.append(entry("second"));
    await audit.flush();

    const [first] = [...(await store.entries())].toSorted((a, b) => (a.key < b.key ? -1 : 1));
    await store.register(first!.key, { ...first!.value, reason: "granted everything" });

    // The chain in memory is intact; the stored one is not, and verifyStored says where.
    expect(audit.verify().ok).toBe(true);
    expect(await audit.verifyStored()).toMatchObject({ ok: false, brokenAt: 1 });
  });
});

describe("durable human overrides", () => {
  it("counts as paused until a person's stored orders are known", async () => {
    const store = new MemoryStateStore<OverrideState>();
    const overrides = new HumanOverrides({ store });
    expect(overrides.state().paused).toBe(true);
    expect(overrides.effectiveLevel(5)).toBe(0);
    await overrides.ready;
    expect(overrides.state().paused).toBe(false);
  });

  it("keeps a person's order across a restart", async () => {
    const store = new MemoryStateStore<OverrideState>();
    const first = new HumanOverrides({ store });
    await first.ready;
    first.apply({ type: "disable_autonomy" }, { channel: "owner", actor: "Dal" });
    await first.flush();

    const second = new HumanOverrides({ store });
    await second.ready;
    expect(second.effectiveLevel(5)).toBe(2);
  });

  it("applies orders given while loading on top of the stored state", async () => {
    const store = new MemoryStateStore<OverrideState>();
    const seed = new HumanOverrides({ store });
    await seed.ready;
    seed.apply(
      { type: "disable_capability", capability: "robot.grasp" },
      { channel: "owner", actor: "Dal" },
    );
    await seed.flush();

    const restarted = new HumanOverrides({ store });
    restarted.apply(
      { type: "disable_capability", capability: "robot.navigate" },
      { channel: "agent", actor: "agent" },
    );
    await restarted.ready;
    expect(restarted.state().disabledCapabilities).toEqual(["robot.grasp", "robot.navigate"]);
  });

  it("stays paused when the stored state cannot be read", async () => {
    const store = new MemoryStateStore<OverrideState>();
    store.lookup = async () => {
      throw new Error("sqlite unavailable");
    };
    const overrides = new HumanOverrides({ store });
    await overrides.ready;
    expect(overrides.state()).toMatchObject({
      paused: true,
      updatedBy: "unreadable-override-store",
    });
  });

  it("refuses the agent widening, even while loading", () => {
    const overrides = new HumanOverrides({ store: new MemoryStateStore<OverrideState>() });
    const result = overrides.apply({ type: "resume" }, { channel: "agent", actor: "agent" });
    expect(result).toMatchObject({ ok: false, tamper: true });
  });
});
