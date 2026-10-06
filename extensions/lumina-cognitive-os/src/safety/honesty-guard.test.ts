import { describe, expect, it } from "vitest";
import type { EmbodiedResult } from "../embodiment/embodied-controller.js";
import { AuditLog } from "./audit-log.js";
import { claimsPhysicalAction, createHonestyGuard } from "./honesty-guard.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const result = (ok: boolean, minutesAgo: number): EmbodiedResult =>
  ({
    atISO: new Date(NOW - minutesAgo * 60_000).toISOString(),
    intent: { type: "navigate_to", targetId: "kitchen" },
    review: { verdict: "allow", capability: "robot.navigate", reasons: [], limits: {} },
    outcome: { ok, detail: ok ? "Arrived." : "Blocked." },
    requestedBy: "agent",
  }) as unknown as EmbodiedResult;

describe("honesty guard", () => {
  it("recognizes first-person physical claims in Spanish and English, not talk about them", () => {
    expect(claimsPhysicalAction("Listo, fui a la cocina y agarré la taza.")).toBe(true);
    expect(claimsPhysicalAction("Done: I picked up the cup.")).toBe(true);
    expect(claimsPhysicalAction("Puedo ir a la cocina si me lo pides.")).toBe(false);
    expect(claimsPhysicalAction("The robot would need to move first.")).toBe(false);
  });

  it("sends a claim back when no body action ran, and lets a true one through", () => {
    const audit = new AuditLog();
    let body: EmbodiedResult[] = [];
    const guard = createHonestyGuard({ recentBody: () => body, audit, now: () => NOW });
    expect(guard.revise("Ya fui a la cocina.")).toContain("no body action ran");
    expect(audit.recent(1)[0]?.action).toBe("honesty.revise");
    body = [result(false, 1)];
    expect(guard.revise("Ya fui a la cocina.")).toBeDefined();
    body = [result(true, 30)];
    expect(guard.revise("Ya fui a la cocina.")).toBeDefined();
    body = [result(true, 1)];
    expect(guard.revise("Ya fui a la cocina.")).toBeUndefined();
    expect(guard.revise("Hola Dal, ¿cómo estás?")).toBeUndefined();
  });
});
