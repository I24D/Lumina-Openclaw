/**
 * consolidation.ts — Turning what was seen into what is known.
 *
 * Lumina spec §4.6 (episodes -> patterns -> semantic knowledge, never deleting
 * critical information automatically), §54 (before, after, since, last time,
 * frequency, routine) and §39 (detect routines by time, action, place and
 * context, but never automate a new routine without a policy).
 *
 * Input is the world model's sighting history; nothing is deleted, and the
 * results are claims with their support, not facts:
 *
 *   temporalFacts     first and last sighting, how often, where most often
 *   consolidate       "X is usually at Y" when one place dominates; recorded
 *                     as lessons so the workspace and the reasoner can use them
 *   detectRoutines    "X tends to be at Y around HH:00" across several days;
 *                     always returned with automate: false
 */
import type { WorldModel } from "../world/world-model.js";
import type { LessonStore } from "./learning/lessons.js";

export type TemporalFacts = {
  readonly id: string;
  readonly firstSeenISO: string | undefined;
  readonly lastSeenISO: string | undefined;
  readonly sightings: number;
  /** Sightings per day over the observed span. */
  readonly perDay: number;
  readonly byPlace: Readonly<Record<string, number>>;
  readonly usualPlaceId: string | undefined;
};

export type SemanticFact = {
  readonly subjectId: string;
  readonly claim: string;
  readonly support: number;
  readonly confidence: number;
};

export type RoutineCandidate = {
  readonly subjectId: string;
  readonly placeId: string;
  readonly hour: number;
  readonly days: number;
  readonly claim: string;
  /** Spec §39: a detected routine is never automated without a policy. */
  readonly automate: false;
};

const DAY_MS = 86_400_000;
/** Kinds whose usual place is worth learning (rooms and furniture do not move). */
const MOVABLE = new Set(["object", "tool", "container", "device", "person", "animal", "vehicle"]);

export function temporalFacts(world: WorldModel, id: string): TemporalFacts {
  const history = world.history(id);
  const byPlace: Record<string, number> = {};
  for (const s of history) {
    if (s.placeId) {
      byPlace[s.placeId] = (byPlace[s.placeId] ?? 0) + 1;
    }
  }
  const first = history[0]?.atISO;
  const last = history.at(-1)?.atISO;
  const spanDays = first && last ? Math.max(1, (Date.parse(last) - Date.parse(first)) / DAY_MS) : 1;
  const usual = Object.entries(byPlace).toSorted((a, b) => b[1] - a[1])[0];
  return {
    id,
    firstSeenISO: first,
    lastSeenISO: last,
    sightings: history.length,
    perDay: Number((history.length / spanDays).toFixed(2)),
    byPlace,
    usualPlaceId: usual?.[0],
  };
}

/**
 * Learn "usually at" facts for movable entities whose sightings concentrate on
 * one place. Recorded as lessons (trigger `entity:<id>`), so repeating the
 * consolidation confirms them instead of duplicating.
 */
export function consolidate(params: {
  readonly world: WorldModel;
  readonly lessons?: LessonStore;
  /** Fewer sightings than this teach nothing. Default 3. */
  readonly minSightings?: number;
  /** Share of sightings the usual place needs. Default 0.6. */
  readonly dominance?: number;
}): ReadonlyArray<SemanticFact> {
  const minSightings = params.minSightings ?? 3;
  const dominance = params.dominance ?? 0.6;
  const facts: SemanticFact[] = [];
  for (const { entity } of params.world.query()) {
    if (!MOVABLE.has(entity.kind)) {
      continue;
    }
    const t = temporalFacts(params.world, entity.id);
    if (t.sightings < minSightings || !t.usualPlaceId) {
      continue;
    }
    const share = (t.byPlace[t.usualPlaceId] ?? 0) / t.sightings;
    if (share < dominance) {
      continue;
    }
    const place = params.world.get(t.usualPlaceId)?.label ?? t.usualPlaceId;
    const fact: SemanticFact = {
      subjectId: entity.id,
      claim: `${entity.label} suele estar en ${place}`,
      support: t.sightings,
      // Repetition raises confidence but a pattern is never certainty.
      confidence: Number(Math.min(0.85, share * (1 - 1 / (t.sightings + 1))).toFixed(2)),
    };
    facts.push(fact);
    params.lessons?.learn({
      trigger: `entity:${entity.id}`,
      claim: fact.claim,
      confidence: fact.confidence,
    });
  }
  return facts;
}

/** Hour-of-day patterns repeated on at least `minDays` different days. */
export function detectRoutines(
  world: WorldModel,
  id: string,
  options: { readonly minDays?: number; readonly utcOffsetMinutes?: number } = {},
): ReadonlyArray<RoutineCandidate> {
  const minDays = options.minDays ?? 3;
  const offsetMs = (options.utcOffsetMinutes ?? 0) * 60_000;
  const days = new Map<string, Set<string>>();
  for (const s of world.history(id)) {
    if (!s.placeId) {
      continue;
    }
    const local = new Date(Date.parse(s.atISO) + offsetMs);
    const slot = `${s.placeId}\u0000${local.getUTCHours()}`;
    const day = local.toISOString().slice(0, 10);
    const set = days.get(slot) ?? new Set<string>();
    set.add(day);
    days.set(slot, set);
  }
  const label = world.get(id)?.label ?? id;
  const out: RoutineCandidate[] = [];
  for (const [slot, set] of days) {
    if (set.size < minDays) {
      continue;
    }
    const [placeId, hourText] = slot.split("\u0000") as [string, string];
    const hour = Number(hourText);
    const place = world.get(placeId)?.label ?? placeId;
    out.push({
      subjectId: id,
      placeId,
      hour,
      days: set.size,
      claim: `${label} suele estar en ${place} hacia las ${String(hour).padStart(2, "0")}:00`,
      automate: false,
    });
  }
  return out.toSorted((a, b) => b.days - a.days);
}
