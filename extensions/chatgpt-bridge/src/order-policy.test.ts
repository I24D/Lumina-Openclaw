import { describe, expect, it } from "vitest";
import { createOrderGate, extractOrder, type OrderGateOptions } from "./order-policy.js";

const BASE: OrderGateOptions = {
  marker: "@OPENCLAW:",
  maxOrderChars: 200,
  userTurnWindowMs: 300_000,
  minIntervalMs: 3_000,
  maxPerHour: 5,
  denyPatterns: ["bitso", "rm\\s+-rf"],
};

const NOW = 1_000_000;

function candidate(
  overrides: Partial<Parameters<ReturnType<typeof createOrderGate>["evaluate"]>[0]> = {},
) {
  return {
    messageId: "msg-1",
    text: "Claro, se lo mando.\n@OPENCLAW: revisa el estado del gateway",
    observedAt: NOW,
    lastUserTurnAt: NOW - 5_000,
    ...overrides,
  };
}

describe("extractOrder", () => {
  it("reads the order from the marked line", () => {
    expect(extractOrder("bla\n@OPENCLAW: haz algo\nmas bla", "@OPENCLAW:")).toBe("haz algo");
  });

  it("reads a marker that appears mid-line", () => {
    // ChatGPT answers voice turns in one paragraph, and HTML collapses the
    // newline, so the marker frequently lands mid-line.
    expect(extractOrder("Listo, le digo: @OPENCLAW: revisa el gateway", "@OPENCLAW:")).toBe(
      "revisa el gateway",
    );
  });

  it("takes only the first marker when a reply carries several", () => {
    expect(extractOrder("@OPENCLAW: uno\n@OPENCLAW: dos", "@OPENCLAW:")).toBe("uno");
  });

  it("ignores a marker with an empty order", () => {
    expect(extractOrder("@OPENCLAW:   ", "@OPENCLAW:")).toBeUndefined();
  });

  it("matches the marker case-insensitively", () => {
    expect(extractOrder("@openclaw: hola", "@OPENCLAW:")).toBe("hola");
  });
});

describe("createOrderGate", () => {
  it("relays a marked order that follows a recent operator turn", () => {
    const gate = createOrderGate(BASE);
    expect(gate.evaluate(candidate())).toEqual({
      relay: true,
      order: "revisa el estado del gateway",
    });
  });

  it("refuses a reply without the marker", () => {
    const gate = createOrderGate(BASE);
    const decision = gate.evaluate(candidate({ text: "Hola, que tal" }));
    expect(decision).toEqual({ relay: false, reason: "no marker" });
  });

  it("refuses an order when the operator never spoke", () => {
    const gate = createOrderGate(BASE);
    const decision = gate.evaluate(candidate({ lastUserTurnAt: null }));
    expect(decision).toEqual({ relay: false, reason: "no operator turn observed" });
  });

  it("refuses an order long after the operator's last turn", () => {
    const gate = createOrderGate(BASE);
    const decision = gate.evaluate(candidate({ lastUserTurnAt: NOW - 600_000 }));
    expect(decision).toEqual({ relay: false, reason: "stale: operator turn outside the window" });
  });

  it("blocks orders matching a deny pattern", () => {
    const gate = createOrderGate(BASE);
    const decision = gate.evaluate(candidate({ text: "@OPENCLAW: compra 500 MXN en bitso" }));
    expect(decision.relay).toBe(false);
    expect(decision.relay === false && decision.reason).toContain("blocked by policy");
  });

  it("blocks a destructive shell order", () => {
    const gate = createOrderGate(BASE);
    const decision = gate.evaluate(candidate({ text: "@OPENCLAW: rm -rf C:/I24D_WhatsApp" }));
    expect(decision.relay).toBe(false);
  });

  it("refuses an oversized order", () => {
    const gate = createOrderGate(BASE);
    const decision = gate.evaluate(candidate({ text: `@OPENCLAW: ${"a".repeat(201)}` }));
    expect(decision).toEqual({ relay: false, reason: "order exceeds 200 chars" });
  });

  it("relays each message id only once", () => {
    const gate = createOrderGate(BASE);
    const first = candidate();
    expect(gate.evaluate(first).relay).toBe(true);
    gate.commit(first, first.observedAt);
    expect(gate.evaluate(first)).toEqual({ relay: false, reason: "already relayed" });
  });

  it("throttles a second order that arrives too soon", () => {
    const gate = createOrderGate(BASE);
    const first = candidate();
    gate.commit(first, first.observedAt);
    const second = candidate({ messageId: "msg-2", observedAt: NOW + 1_000 });
    expect(gate.evaluate(second)).toEqual({ relay: false, reason: "throttled" });
  });

  it("allows a second order once the interval has passed", () => {
    const gate = createOrderGate(BASE);
    const first = candidate();
    gate.commit(first, first.observedAt);
    const second = candidate({
      messageId: "msg-2",
      observedAt: NOW + 4_000,
      lastUserTurnAt: NOW + 3_000,
    });
    expect(gate.evaluate(second).relay).toBe(true);
  });

  it("enforces the hourly cap", () => {
    const gate = createOrderGate(BASE);
    for (let index = 0; index < BASE.maxPerHour; index += 1) {
      const at = NOW + index * 10_000;
      gate.commit(candidate({ messageId: `msg-${index}`, observedAt: at }), at);
    }
    const at = NOW + BASE.maxPerHour * 10_000;
    const decision = gate.evaluate(
      candidate({ messageId: "overflow", observedAt: at, lastUserTurnAt: at - 1_000 }),
    );
    expect(decision).toEqual({ relay: false, reason: `hourly cap of ${BASE.maxPerHour} reached` });
  });

  it("treats a malformed deny pattern as a literal instead of dropping it", () => {
    const gate = createOrderGate({ ...BASE, denyPatterns: ["(unclosed"] });
    const decision = gate.evaluate(candidate({ text: "@OPENCLAW: probando (unclosed aqui" }));
    expect(decision.relay).toBe(false);
  });
});
