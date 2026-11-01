import type { ThalamicRouter } from "../cognition/router/thalamic-router.js";
/**
 * world-perception.ts — Lets any perception update the world model.
 *
 * Producers never import the world model. A vision tracker, a microphone
 * array or the agent itself emits an ordinary `CognitiveEvent` whose payload
 * carries `{ observation }`, and this subscription folds it in. The world
 * model therefore sees every sighting, including the ones too dull to earn a
 * cognitive cycle.
 */
import { trustOf, type CognitiveEvent } from "../contracts/attention.js";
import { coreEvent, payloadOf } from "../events/catalog.js";
import type { Observation, ObserveResult, WorldModel } from "./world-model.js";

/** The observation an event carries, if it carries a well-formed one. */
export function observationFrom(event: CognitiveEvent): Observation | undefined {
  const obs = payloadOf(event, "world.observed")?.observation;
  if (!obs || !obs.label.trim() || !Number.isFinite(Date.parse(obs.atISO ?? event.atISO))) {
    return undefined;
  }
  return {
    ...obs,
    atISO: obs.atISO ?? event.atISO,
    source: trustOf(event) === "untrusted" ? "agent" : obs.source,
  };
}

/** Build the event a producer should ingest for a sighting. */
export function observedEvent(
  source: string,
  observation: Observation,
  atISO?: string,
): CognitiveEvent {
  // A routine sighting is low priority for thought (catalog priors); the world model still records it.
  return coreEvent(
    source,
    "world.observed",
    { observation },
    {
      atISO: atISO ?? observation.atISO ?? new Date().toISOString(),
    },
  );
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
