/**
 * Tests for the typed event catalog.
 */
import { describe, expect, it } from "vitest";
import { trustOf } from "../cognition/attention.js";
import {
  EVENT_PRIORS,
  isM3ganEventKind,
  m3ganEvent,
  M3GAN_EVENT_KINDS,
  M3GAN_EVENT_SCHEMA_VERSION,
  payloadOf,
} from "./catalog.js";

describe("m3ganEvent", () => {
  it("stamps the schema version and the kind's priors", () => {
    const e = m3ganEvent("vision", "person.detected", { label: "Dal", confidence: 0.97 });
    expect(e.kind).toBe("person.detected");
    expect(e.importance).toBe(EVENT_PRIORS["person.detected"].importance);
    expect(payloadOf(e, "person.detected")).toMatchObject({
      schemaVersion: M3GAN_EVENT_SCHEMA_VERSION,
      label: "Dal",
    });
  });

  it("returns no payload for a different kind", () => {
    const e = m3ganEvent("vision", "person.detected", { label: "Dal", confidence: 0.97 });
    expect(payloadOf(e, "object.moved")).toBeUndefined();
  });

  it.each([
    { label: "Dal", confidence: 0.9 },
    { schemaVersion: 2, label: "Dal", confidence: 0.9 },
    { schemaVersion: 1, label: "Dal", confidence: 1.1 },
    { schemaVersion: 1, label: "Dal", confidence: Number.NaN },
    { schemaVersion: 1, label: "Dal", confidence: 0.9, distanceM: -1 },
    { schemaVersion: 1, label: 42, confidence: 0.9 },
  ])("rejects malformed or unsupported payloads: %j", (payload) => {
    const event = m3ganEvent("vision", "person.detected", { label: "Dal", confidence: 0.9 });
    expect(payloadOf({ ...event, payload }, "person.detected")).toBeUndefined();
  });

  it("does not let a producer override the catalog version through its payload", () => {
    const payload = { label: "Dal", confidence: 0.9, schemaVersion: 999 };
    expect(m3ganEvent("vision", "person.detected", payload).payload).toMatchObject({
      schemaVersion: 1,
    });
  });

  it("treats a danger as the most salient thing there is", () => {
    expect(EVENT_PRIORS["danger.detected"]).toEqual({ importance: 1, urgency: 1 });
  });

  it("knows every kind it declares", () => {
    expect(M3GAN_EVENT_KINDS.every(isM3ganEventKind)).toBe(true);
    expect(isM3ganEventKind("teleport.started")).toBe(false);
  });
});

describe("trustOf", () => {
  it("treats other people's content as untrusted by default", () => {
    expect(trustOf({ source: "web" })).toBe("untrusted");
    expect(trustOf({ source: "email" })).toBe("untrusted");
    expect(trustOf({ source: "whatsapp" })).toBe("untrusted");
  });

  it("trusts the system's own sensors and an explicit marking", () => {
    expect(trustOf({ source: "awareness" })).toBe("trusted");
    expect(trustOf({ source: "web", trust: "trusted" })).toBe("trusted");
    expect(trustOf({ source: "vision", trust: "untrusted" })).toBe("untrusted");
  });
});
