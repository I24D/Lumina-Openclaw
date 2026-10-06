/**
 * Tests for external checkpoints of the audit chain.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import {
  compareWithCheckpoint,
  startAuditCheckpoints,
  type AuditCheckpoint,
  type CheckpointStore,
} from "./audit-checkpoint.js";
import { AuditLog, type AuditRecord } from "./audit-log.js";

const entry = (n: number) => ({
  actor: "test",
  action: `step.${n}`,
  reason: "test",
  execution: "recorded" as const,
});

class MemoryCheckpoints implements CheckpointStore {
  rows: AuditCheckpoint[] = [];
  async latest() {
    return this.rows.at(-1);
  }
  async write(checkpoint: AuditCheckpoint) {
    this.rows.push(checkpoint);
  }
}

const chainOf = async (count: number, store = new MemoryStateStore<AuditRecord>()) => {
  const audit = new AuditLog({ store });
  await audit.ready;
  for (let i = 1; i <= count; i++) {
    audit.append(entry(i));
  }
  await audit.flush();
  return { audit, store };
};

describe("compareWithCheckpoint", () => {
  it("accepts a chain that reaches and agrees with the checkpoint", async () => {
    const { audit } = await chainOf(3);
    const head = audit.head();
    expect(compareWithCheckpoint(audit, head)).toEqual({ ok: true, checkedSeq: 3 });
    expect(compareWithCheckpoint(audit, undefined)).toEqual({ ok: true });
  });

  it("catches deleted tail entries and rewritten ones", async () => {
    const { audit } = await chainOf(2);
    expect(compareWithCheckpoint(audit, { seq: 5, hash: "a".repeat(64) })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("deleted"),
    });
    expect(compareWithCheckpoint(audit, { seq: 2, hash: "b".repeat(64) })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("rewritten"),
    });
  });
});

describe("startAuditCheckpoints", () => {
  it("checkpoints the head outside the gateway", async () => {
    const { audit } = await chainOf(2);
    const store = new MemoryCheckpoints();
    const onTamper = vi.fn();
    const run = startAuditCheckpoints({ audit, store, onTamper });
    await vi.waitFor(() => expect(store.rows).toEqual([audit.head()]));
    expect(run.status().state).toBe("ok");
    expect(onTamper).not.toHaveBeenCalled();
    run.stop();
  });

  it("reports tampering when the stored chain lost entries since the last checkpoint", async () => {
    const first = await chainOf(4);
    const external = new MemoryCheckpoints();
    await external.write(first.audit.head() as AuditCheckpoint);

    // Someone deletes the two newest rows from the gateway's database.
    for (const { key } of (await first.store.entries()).slice(-2)) {
      await first.store.delete(key);
    }
    const reloaded = new AuditLog({ store: first.store });
    const onTamper = vi.fn();
    const run = startAuditCheckpoints({ audit: reloaded, store: external, onTamper });
    await vi.waitFor(() =>
      expect(onTamper).toHaveBeenCalledWith(expect.stringContaining("deleted")),
    );
    expect(run.status().state).toBe("tampered");
    run.stop();
  });
});
