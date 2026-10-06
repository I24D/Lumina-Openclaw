/**
 * curiosity.ts — Noticing what Lumina does not know.
 *
 * Lumina spec §92: "Veo un dispositivo que no reconozco", but ask or look into it
 * only when it helps a task or a conversation, never exploring invasively.
 * Routine sightings are too dull to earn a cognitive cycle, so this turns the
 * one that matters, a sensor seeing a new thing whose use nothing explains,
 * into a `knowledge.gap` event. Whether to ask, and when, is the situational
 * reasoner's call: only with someone there, and at most now and then.
 */
import { trustOf, type CognitiveEvent } from "../contracts/attention.js";
import { coreEvent } from "../events/catalog.js";
import { affordancesOf } from "./affordances.js";
import type { ObserveResult } from "./world-model.js";

/** Kinds of things worth wondering about; people, places and events are known otherwise. */
export const CURIOUS_KINDS: ReadonlySet<string> = new Set([
  "object",
  "device",
  "tool",
  "container",
]);

/** The gap a sighting reveals, as an event for the router; undefined when there is none. */
export function knowledgeGap(
  result: ObserveResult,
  event: CognitiveEvent,
): CognitiveEvent | undefined {
  const { entity } = result;
  if (
    !result.created ||
    entity.source !== "sensor" ||
    trustOf(event) === "untrusted" ||
    !CURIOUS_KINDS.has(entity.kind) ||
    // A detector that names its classes has recognized the thing.
    typeof entity.properties.detector === "string" ||
    affordancesOf(entity).source !== "unknown"
  ) {
    return undefined;
  }
  return coreEvent(
    event.source,
    "knowledge.gap",
    {
      entityId: entity.id,
      label: entity.label,
      kind: entity.kind,
      ...(entity.position?.placeId ? { placeId: entity.position.placeId } : {}),
    },
    { atISO: event.atISO },
  );
}
