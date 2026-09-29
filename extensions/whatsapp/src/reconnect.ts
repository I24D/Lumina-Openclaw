import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";
import { clamp } from "openclaw/plugin-sdk/text-utility-runtime";

export type ReconnectPolicy = BackoffPolicy & {
  maxAttempts: number;
  /**
   * Lumina fork: once `maxAttempts` fast retries are spent, keep retrying every `slowRetryMs`
   * (± jitter) instead of stopping. Unset or 0 keeps upstream's give-up behavior. Logged-out
   * and session-conflict closes still stop, because only the operator can fix those.
   */
  slowRetryMs?: number;
};

const DEFAULT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

export function resolveHeartbeatSeconds(cfg: OpenClawConfig, overrideSeconds?: number): number {
  void cfg;
  const candidate = overrideSeconds;
  if (typeof candidate === "number" && candidate > 0) {
    return candidate;
  }
  return DEFAULT_HEARTBEAT_SECONDS;
}

export function resolveReconnectPolicy(
  cfg: OpenClawConfig,
  overrides?: Partial<ReconnectPolicy>,
): ReconnectPolicy {
  void cfg;
  const overrideConfig = overrides ?? {};
  const merged = {
    ...DEFAULT_RECONNECT_POLICY,
    ...overrideConfig,
  } as ReconnectPolicy;

  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  if (merged.slowRetryMs !== undefined) {
    merged.slowRetryMs =
      Number.isFinite(merged.slowRetryMs) && merged.slowRetryMs > 0
        ? Math.max(merged.maxMs, Math.floor(merged.slowRetryMs))
        : 0;
  }
  return merged;
}

/** Delay before a slow retry: `slowRetryMs` spread by the policy jitter so accounts do not retry in lockstep. */
export function computeSlowRetryDelay(
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): number {
  const base = policy.slowRetryMs ?? 0;
  const spread = base * policy.jitter;
  return Math.max(0, Math.round(base - spread + random() * spread * 2));
}

export { computeBackoff, sleepWithAbort };

export function newConnectionId() {
  return randomUUID();
}
