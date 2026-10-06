/**
 * presence.ts — Who is here, who is speaking, who just came or left.
 *
 * Lumina spec §89: understand who is present, who speaks, who looks, who
 * enters and who leaves, and keep a PresenceState. Like the global workspace,
 * this derives everything from the modules that own it (world model for
 * sightings, people registry for identity, router for recent events), so it
 * stores nothing and cannot drift. Gaze ("who looks") needs a camera model and
 * is not derived yet.
 */
import type { CognitiveEvent } from "../contracts/attention.js";
import { payloadOf } from "../events/catalog.js";
import { STALE_BELOW, type WorldModel } from "../world/world-model.js";
import type { PeopleRegistry, Person } from "./people.js";

export type PresentPerson = {
  readonly worldId: string;
  readonly personId?: string;
  readonly name: string;
  readonly role: Person["role"];
  readonly confidence: number;
  readonly placeId?: string;
  readonly distanceM?: number;
  readonly speaking: boolean;
};

export type PresenceState = {
  readonly atISO: string;
  readonly present: ReadonlyArray<PresentPerson>;
  /** The most recent identified speaker within the window. */
  readonly speakerId?: string;
  readonly arrivals: ReadonlyArray<string>;
  readonly departures: ReadonlyArray<string>;
};

export function presenceState(params: {
  readonly world: WorldModel;
  readonly people?: PeopleRegistry;
  readonly recentEvents?: ReadonlyArray<CognitiveEvent>;
  readonly nowMs: number;
  /** How recent a speech or arrival must be to count as "now". Default 10 s. */
  readonly windowMs?: number;
}): PresenceState {
  const windowMs = params.windowMs ?? 10_000;
  const since = new Date(params.nowMs - windowMs).toISOString();
  const recent = (params.recentEvents ?? []).filter((e) => e.atISO >= since);

  const speakers = new Set<string>();
  let speakerId: string | undefined;
  const arrivals: string[] = [];
  const departures: string[] = [];
  // Events are newest first (router order): the first speaker found is the latest.
  for (const event of recent) {
    const speech = payloadOf(event, "speech.recognized") ?? payloadOf(event, "speech.detected");
    if (speech?.speakerId) {
      speakers.add(speech.speakerId);
      speakerId ??= speech.speakerId;
    }
    const arrived = payloadOf(event, "person.detected");
    if (arrived) {
      arrivals.push(arrived.personId ?? arrived.label);
    }
    const left = payloadOf(event, "person.left");
    if (left) {
      departures.push(left.personId);
    }
  }

  const present = params.world
    .query({ kind: "person", minConfidence: STALE_BELOW })
    .map(({ entity, confidence }): PresentPerson => {
      const person =
        params.people?.list().find((p) => p.worldEntityId === entity.id) ??
        params.people?.find(entity.label);
      const entry: { -readonly [K in keyof PresentPerson]: PresentPerson[K] } = {
        worldId: entity.id,
        name: person?.name ?? entity.label,
        role: person?.role ?? "unknown",
        confidence,
        speaking: speakers.has(entity.id) || (person ? speakers.has(person.id) : false),
      };
      if (person) {
        entry.personId = person.id;
      }
      if (entity.position?.placeId) {
        entry.placeId = entity.position.placeId;
      }
      if (entity.position?.distanceM !== undefined) {
        entry.distanceM = entity.position.distanceM;
      }
      return entry;
    });

  return {
    atISO: new Date(params.nowMs).toISOString(),
    present,
    arrivals,
    departures,
    ...(speakerId ? { speakerId } : {}),
  };
}
