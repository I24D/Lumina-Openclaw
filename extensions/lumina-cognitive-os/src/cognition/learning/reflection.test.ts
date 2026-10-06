/**
 * Tests for reflection: patterns found, lessons proposed, nothing applied.
 */
import { describe, expect, it } from "vitest";
import { coreEvent } from "../../events/catalog.js";
import { AuditLog } from "../../safety/audit-log.js";
import type { CycleRecord } from "../loop/cognitive-loop.js";
import { createReflection, reflect } from "./reflection.js";

const NOW = "2026-10-05T20:00:00.000Z";

const refused = (audit: AuditLog, times: number) => {
  for (let i = 0; i < times; i++) {
    audit.append({
      actor: "agent",
      action: "body.grasp",
      reason: "grasping needs a person's confirmation",
      execution: "refused",
    });
  }
};

const proposal = (): CycleRecord => ({
  atISO: NOW,
  event: coreEvent("camera", "person.detected", { label: "unknown person", confidence: 0.9 }),
  admitted: true,
  salience: 0.6,
  outcome: "propose",
  action: "Tell your owner about an unknown person",
  executed: false,
  reason: "propose (narrowed by autonomy L3)",
});

describe("reflect", () => {
  it("turns repeated refusals and unanswered proposals into findings and proposed lessons", () => {
    const audit = new AuditLog();
    refused(audit, 3);
    const report = reflect({
      audit: audit.recent(50),
      cycles: [proposal(), proposal(), proposal()],
      nowISO: NOW,
    });
    expect(report.findings.map((f) => f.kind)).toEqual(["refused", "unanswered"]);
    expect(report.proposedLessons[0]).toMatchObject({ trigger: "body.grasp", confidence: 0.65 });
    expect(report.proposedLessons[1]?.trigger).toBe("person.detected");
  });

  it("stays quiet about things that happened only once or twice", () => {
    const audit = new AuditLog();
    refused(audit, 2);
    expect(
      reflect({ audit: audit.recent(50), cycles: [proposal()], nowISO: NOW }).findings,
    ).toEqual([]);
  });
});

describe("createReflection", () => {
  it("keeps the latest report and records each run in the audit, learning nothing", () => {
    const audit = new AuditLog();
    refused(audit, 3);
    const reflection = createReflection({
      audit,
      loop: { recent: () => [] },
      now: () => Date.parse(NOW),
    });
    expect(reflection.latest()).toBeUndefined();
    const report = reflection.run();
    expect(reflection.latest()).toBe(report);
    expect(audit.recent(1)[0]).toMatchObject({ action: "reflection.run", execution: "recorded" });
  });
});
