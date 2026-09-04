/**
 * awareness-bridge.ts — Plugs the cognitive loop into the existing event bus.
 *
 * `awareness/event-bus.ts` already emits one event per significant environment
 * change. This adapter is the only thing standing between it and the loop, so
 * perception costs nothing new: no second bus, no polling, no duplicate
 * sensors.
 *
 * The bus is synchronous and must never be blocked by a listener, so cycles
 * are started and left to settle on their own. Failures are reported through
 * `onError` instead of escaping into the emitter.
 */
import type { AwarenessChange, AwarenessEventBus } from "../../awareness/event-bus.js";
import { fromAwareness } from "../attention.js";
import type { CognitiveLoop, CycleRecord } from "./cognitive-loop.js";

export type AwarenessBridgeOptions = {
  readonly onCycle?: (record: CycleRecord) => void;
  readonly onError?: (error: unknown, change: AwarenessChange) => void;
  /** Clock injection for tests. */
  readonly nowISO?: () => string;
};

/**
 * Subscribe `loop` to `bus`. Returns the unsubscribe function, which the
 * caller must invoke on shutdown so a restarted loop does not double-consume.
 */
export function attachAwareness(
  bus: AwarenessEventBus,
  loop: CognitiveLoop,
  options: AwarenessBridgeOptions = {},
): () => void {
  return bus.on((change) => {
    const event = fromAwareness(change, options.nowISO?.());
    void Promise.resolve()
      .then(() => loop.handle(event))
      .then((record) => {
        options.onCycle?.(record);
      })
      .catch((error: unknown) => {
        options.onError?.(error, change);
      });
  });
}
