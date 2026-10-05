/**
 * world-perception.ts — Lets any perception update the world model.
 *
 * Producers never import the world model. A vision tracker, a microphone
 * array or the agent itself emits an ordinary `CognitiveEvent` whose payload
 * carries `{ observation }`, and this subscription folds it in. The world
 * model therefore sees every sighting, including the ones too dull to earn a
 * cognitive cycle.
 */
import type { CognitiveEvent } from "../cognition/attention.js";
import type { ThalamicRouter } from "../cognition/router/thalamic-router.js";
import {
  isEntityKind,
  type Observation,
  type ObserveResult,
  type WorldModel,
} from "./world-model.js";

/** Event kind producers use for a plain sighting. */
export const WORLD_OBSERVED_KIND = "world.observed";

/** The observation an event carries, if it carries a well-formed one. */
export function observationFrom(event: CognitiveEvent): Observation | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || !("observation" in payload)) {
    return undefined;
  }
  const candidate = (payload as { observation: unknown }).observation;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  const obs = candidate as Partial<Observation>;
  if (
    !isEntityKind(obs.kind) ||
    typeof obs.label !== "string" ||
    typeof obs.confidence !== "number"
  ) {
    return undefined;
  }
  return {
    ...(obs as Observation),
    atISO: obs.atISO ?? event.atISO,
    source: obs.source ?? "sensor",
  };
}

/** Build the event a producer should ingest for a sighting. */
export function observedEvent(
  source: string,
  observation: Observation,
  atISO?: string,
): CognitiveEvent {
  return {
    source,
    kind: WORLD_OBSERVED_KIND,
    atISO: atISO ?? observation.atISO ?? new Date().toISOString(),
    // A routine sighting is low priority for thought; the world model still records it.
    importance: 0.2,
    urgency: 0.1,
    payload: { observation },
  };
}

/** Subscribe `world` to every observation passing through `router`. */
export function attachWorldModel(
  router: ThalamicRouter,
  world: WorldModel,
  onObserved?: (result: ObserveResult, event: CognitiveEvent) => void,
): () => void {
  return router.subscribe({}, ({ event }) => {
    const observation = observationFrom(event);
    if (observation) {
      // Observe first: `onObserved?.(world.observe(...))` would skip the
      // observation itself whenever no callback is given.
      const result = world.observe(observation);
      onObserved?.(result, event);
    }
  });
}
