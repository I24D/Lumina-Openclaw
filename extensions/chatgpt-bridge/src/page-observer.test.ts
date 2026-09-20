import { describe, expect, it } from "vitest";
import { BRIDGE_BINDING_NAME, buildObserverSource, parseObservedTurn } from "./page-observer.js";

describe("buildObserverSource", () => {
  it("calls the binding the service listens on", () => {
    expect(buildObserverSource(1200)).toContain(`${BRIDGE_BINDING_NAME}(JSON.stringify(payload))`);
  });

  it("clamps an implausibly small settle window", () => {
    expect(buildObserverSource(10)).toContain("var SETTLE_MS = 200;");
  });

  it("refuses to install itself twice in one document", () => {
    expect(buildObserverSource(1200)).toContain("__openclawBridgeInstalled");
  });
});

describe("parseObservedTurn", () => {
  const valid = JSON.stringify({
    type: "assistant",
    messageId: "abc",
    text: "@OPENCLAW: hola",
    observedAt: 1_000,
    lastUserTurnAt: 900,
  });

  it("parses a well-formed payload", () => {
    expect(parseObservedTurn(valid)).toEqual({
      type: "assistant",
      messageId: "abc",
      text: "@OPENCLAW: hola",
      observedAt: 1_000,
      lastUserTurnAt: 900,
    });
  });

  it("accepts a payload with no operator turn yet", () => {
    const payload = JSON.stringify({
      type: "assistant",
      messageId: "abc",
      text: "hola",
      observedAt: 1_000,
      lastUserTurnAt: null,
    });
    expect(parseObservedTurn(payload)?.lastUserTurnAt).toBeNull();
  });

  it.each([
    ["not json", "{"],
    ["a non-string payload", 42],
    [
      "a foreign message type",
      JSON.stringify({ type: "user", messageId: "a", text: "b", observedAt: 1 }),
    ],
    ["a missing message id", JSON.stringify({ type: "assistant", text: "b", observedAt: 1 })],
    ["empty text", JSON.stringify({ type: "assistant", messageId: "a", text: "", observedAt: 1 })],
  ])("rejects %s", (_label, payload) => {
    expect(parseObservedTurn(payload)).toBeUndefined();
  });
});
