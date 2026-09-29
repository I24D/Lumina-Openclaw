// Whatsapp tests cover reconnect plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  computeSlowRetryDelay,
  DEFAULT_RECONNECT_POLICY,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
} from "./reconnect.js";

describe("web reconnect helpers", () => {
  const cfg: OpenClawConfig = {};

  it("resolves sane reconnect defaults with clamps", () => {
    const policy = resolveReconnectPolicy(cfg, {
      initialMs: 100,
      maxMs: 5,
      factor: 20,
      jitter: 2,
      maxAttempts: -1,
    });

    expect(policy.initialMs).toBe(250); // clamped to minimum
    expect(policy.maxMs).toBeGreaterThanOrEqual(policy.initialMs);
    expect(policy.factor).toBeLessThanOrEqual(10);
    expect(policy.jitter).toBeLessThanOrEqual(1);
    expect(policy.maxAttempts).toBeGreaterThanOrEqual(0);
  });

  it("returns heartbeat default when unset", () => {
    expect(resolveHeartbeatSeconds(cfg)).toBe(60);
    expect(resolveHeartbeatSeconds(cfg, 5)).toBe(5);
  });

  it("normalizes the Lumina slow retry interval and leaves it unset by default", () => {
    expect(resolveReconnectPolicy(cfg).slowRetryMs).toBeUndefined();
    expect(resolveReconnectPolicy(cfg, { slowRetryMs: -5 }).slowRetryMs).toBe(0);
    expect(resolveReconnectPolicy(cfg, { slowRetryMs: 1_000 }).slowRetryMs).toBe(
      DEFAULT_RECONNECT_POLICY.maxMs,
    );
    expect(resolveReconnectPolicy(cfg, { slowRetryMs: 300_000.7 }).slowRetryMs).toBe(300_000);
  });

  it("spreads slow retries by the policy jitter", () => {
    const policy = { ...DEFAULT_RECONNECT_POLICY, jitter: 0.2, slowRetryMs: 100_000 };
    expect(computeSlowRetryDelay(policy, () => 0)).toBe(80_000);
    expect(computeSlowRetryDelay(policy, () => 1)).toBe(120_000);
    expect(computeSlowRetryDelay({ ...policy, jitter: 0 }, () => 0.5)).toBe(100_000);
  });
});
