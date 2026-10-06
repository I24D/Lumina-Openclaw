/**
 * body-adapter.ts — Which body the supervised intents reach.
 *
 * None on a desktop; in simulation, a simulator the host supplies (MuJoCo, a
 * ROS 2 robot in simulation) or else the symbolic body. A simulator reports
 * what its sensors see as ordinary sightings, through the same router as any
 * other sensor.
 */
import type { CognitiveEvent } from "../contracts/attention.js";
import type { WorldModel } from "../world/world-model.js";
import { observedEvent } from "../world/world-perception.js";
import { NullBody, SimulatedBody, type BodyAdapter } from "./body.js";
import type { SimulatedSighting } from "./physics-body.js";

/** What a simulator adapter gets from the core: names for ids, and a way to report sightings. */
export type SimulatorContext = {
  readonly nameOf: (id: string) => string | undefined;
  readonly observe: (sighting: SimulatedSighting) => void;
};

export function createBodyAdapter(params: {
  readonly bodyMode: "none" | "simulated";
  readonly simulator?: (context: SimulatorContext) => BodyAdapter;
  readonly world: WorldModel;
  readonly nameOf: (id: string) => string | undefined;
  readonly ingest: (event: CognitiveEvent) => void;
}): BodyAdapter {
  if (params.bodyMode !== "simulated") {
    return new NullBody();
  }
  const { world } = params;
  const resolvePlace = (id: string): string | undefined => {
    const entity = world.get(id);
    if (!entity) {
      return undefined;
    }
    return entity.kind === "room" || entity.kind === "location"
      ? entity.id
      : entity.position?.placeId;
  };
  return (
    params.simulator?.({
      nameOf: params.nameOf,
      observe: (sighting) =>
        params.ingest(
          observedEvent("simulator", {
            id: sighting.id,
            kind: sighting.kind,
            label: sighting.label,
            confidence: 0.99,
            source: "sensor",
            ...(sighting.placeId || sighting.metric
              ? {
                  position: {
                    ...(sighting.placeId ? { placeId: sighting.placeId } : {}),
                    ...(sighting.metric
                      ? { metric: { x: sighting.metric.x, y: sighting.metric.y, frame: "map" } }
                      : {}),
                  },
                }
              : {}),
          }),
        ),
    }) ?? new SimulatedBody(resolvePlace)
  );
}
