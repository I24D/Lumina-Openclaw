/**
 * awareness-bridge.ts — Plugs environment awareness into the thalamic router.
 *
 * `awareness/event-bus.ts` already emits one event per significant environment
 * change. This adapter normalizes each one into a `CognitiveEvent` and hands it
 * to the router, so perception costs nothing new: no second bus, no polling,
 * no duplicate sensors. The cognitive loop then picks it up from the router's
 * attention queue like any other perception.
 *
 * The bus is synchronous and must never be blocked or broken by a listener;
 * a failing router is reported through `onError` instead of escaping into the
 * emitter.
 */
import type { AwarenessChange, AwarenessEventBus } from "../../awareness/event-bus.js";
import { fromAwareness } from "../attention.js";
import type { ThalamicRouter } from "../router/thalamic-router.js";

export type AwarenessBridgeOptions = {
  readonly onError?: (error: unknown, change: AwarenessChange) => void;
  /** Clock injection for tests. */
  readonly nowISO?: () => string;
};

/**
 * Feed `bus` into `router`. Returns the unsubscribe function, which the caller
 * must invoke on shutdown so a restarted runtime does not double-consume.
 */
export function attachAwareness(
  bus: AwarenessEventBus,
  router: Pick<ThalamicRouter, "ingest">,
  options: AwarenessBridgeOptions = {},
): () => void {
  return bus.on((change) => {
    try {
      router.ingest(fromAwareness(change, options.nowISO?.()));
    } catch (error) {
      options.onError?.(error, change);
    }
  });
}
