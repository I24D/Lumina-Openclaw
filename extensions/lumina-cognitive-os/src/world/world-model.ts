/**
 * world-model.ts — A persistent, uncertain picture of the surroundings.
 *
 * M3GAN spec §5 and §6: the agent keeps entities (people, objects, rooms,
 * doors, devices...) with identity, position, state, properties, last sighting,
 * confidence and relationships, so it can answer "where is my cup?" or "is the
 * door closed?" without looking again, and knows when it should look again.
 *
 * Three ideas carry the design:
 *
 *   Beliefs go stale.  Confidence is stored as observed and decays with a
 *                      half-life that depends on the kind of thing: a person
 *                      moves in minutes, a cup in hours, a sofa in months, a
 *                      room never. `effectiveConfidence` is what callers use.
 *
 *   Evidence merges.   Seeing the same thing in the same place again raises
 *                      confidence (noisy-OR); seeing it somewhere else replaces
 *                      the belief and reports the move.
 *
 *   History is kept.   Storage is event-sourced: every observation is appended
 *                      with its provenance and the current state is a replay.
 *                      Nothing is silently deleted (spec §4.6).
 *
 * Positions are symbolic first (`placeId` points at a room, surface or
 * container entity, which gives "cup on table in kitchen" for free) with an
 * optional metric pose for when a body with SLAM exists.
 */
import path from "node:path";
import { clampConfidence } from "../cognition/uncertainty.js";
import { appendJsonl, ensureDir, readJsonlSync } from "../memory/store.js";

export const ENTITY_KINDS = [
  "person",
  "object",
  "room",
  "location",
  "device",
  "vehicle",
  "animal",
  "event",
  "task",
  "risk",
  "container",
  "surface",
  "door",
  "furniture",
  "tool",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Suggested predicates for spatial and social relations; any string is accepted. */
export const RELATION_PREDICATES = [
  "on_top_of",
  "inside",
  "in_room",
  "near",
  "in_front_of",
  "behind",
  "left_of",
  "right_of",
  "owned_by",
  "part_of",
  "connected_to",
] as const;

/** Where a belief came from. Only "sensor" is direct machine evidence. */
export const PROVENANCES = ["sensor", "user", "agent", "inferred"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export type ScalarValue = string | number | boolean;

export type MetricPosition = {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  /** Coordinate frame, e.g. "map" or "base_link". */
  readonly frame: string;
};

export type EntityPosition = {
  /** The room, surface or container entity this one is in or on. */
  readonly placeId?: string;
  readonly metric?: MetricPosition;
  /** Distance from the observer in metres, when that is all that is known. */
  readonly distanceM?: number;
};

export type Relation = {
  readonly predicate: string;
  readonly targetId: string;
  readonly confidence: number;
  readonly observedAtISO: string;
};

export type WorldEntity = {
  readonly id: string;
  readonly kind: EntityKind;
  readonly label: string;
  readonly position?: EntityPosition;
  readonly state: Readonly<Record<string, ScalarValue>>;
  readonly properties: Readonly<Record<string, ScalarValue>>;
  readonly relations: ReadonlyArray<Relation>;
  /** Confidence at the last sighting; see `effectiveConfidence` for now. */
  readonly confidence: number;
  readonly firstSeenISO: string;
  readonly lastSeenISO: string;
  readonly source: Provenance;
  readonly observations: number;
};

export type Observation = {
  /** Stable id from the producer (tracker id, person id). Omit to match by label. */
  readonly id?: string;
  readonly kind: EntityKind;
  readonly label: string;
  readonly position?: EntityPosition;
  readonly state?: Readonly<Record<string, ScalarValue>>;
  readonly properties?: Readonly<Record<string, ScalarValue>>;
  readonly relations?: ReadonlyArray<{
    readonly predicate: string;
    readonly targetId: string;
    readonly confidence?: number;
  }>;
  readonly confidence: number;
  readonly source: Provenance;
  readonly atISO?: string;
};

export type ObserveResult = {
  readonly entity: WorldEntity;
  readonly created: boolean;
  /** The previous place, when this observation moved the entity. */
  readonly movedFrom?: string;
};

export type WorldQuery = {
  readonly kind?: EntityKind;
  readonly placeId?: string;
  readonly property?: { readonly key: string; readonly value: ScalarValue };
  readonly minConfidence?: number;
  readonly limit?: number;
};

export type ScoredEntity = {
  readonly entity: WorldEntity;
  readonly confidence: number;
};

export type Whereabouts = {
  readonly entity: WorldEntity;
  readonly confidence: number;
  /** Below `STALE_BELOW`: worth observing again before acting on it. */
  readonly stale: boolean;
  /** Labels from the entity outwards, e.g. ["taza", "mesa", "cocina"]. */
  readonly chain: ReadonlyArray<string>;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long until a belief about each kind is only half as trustworthy. */
export const HALF_LIFE_MS: Readonly<Record<EntityKind, number>> = {
  person: 5 * MINUTE,
  animal: 5 * MINUTE,
  risk: 30 * MINUTE,
  vehicle: 30 * MINUTE,
  door: HOUR,
  event: HOUR,
  object: 12 * HOUR,
  tool: 12 * HOUR,
  task: DAY,
  container: 2 * DAY,
  device: 7 * DAY,
  furniture: 30 * DAY,
  surface: Number.POSITIVE_INFINITY,
  room: Number.POSITIVE_INFINITY,
  location: Number.POSITIVE_INFINITY,
};

/** Effective confidence under which a belief should be refreshed before use. */
export const STALE_BELOW = 0.5;

/** Ceiling for merged evidence: repeated sightings never become certainty. */
const MAX_CONFIDENCE = 0.999;

/**
 * Ceiling for anything that is not direct machine evidence (what the agent was
 * told, what it inferred). It sits below the physical "act" threshold, so a
 * claim alone can never drive a body: perception has to confirm it first.
 */
export const UNSENSED_CEILING = 0.9;

function normalizeLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

function slug(label: string): string {
  return (
    normalizeLabel(label)
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_|_$/gu, "") || "entity"
  );
}

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && (ENTITY_KINDS as ReadonlyArray<string>).includes(value);
}

/** Confidence in `entity` at `nowMs`, after decay since its last sighting. */
export function effectiveConfidence(entity: WorldEntity, nowMs: number): number {
  const halfLife = HALF_LIFE_MS[entity.kind];
  if (!Number.isFinite(halfLife)) {
    return entity.confidence;
  }
  const elapsed = Math.max(0, nowMs - Date.parse(entity.lastSeenISO));
  return clampConfidence(entity.confidence * 0.5 ** (elapsed / halfLife));
}

export class WorldModel {
  private readonly entities = new Map<string, WorldEntity>();
  private readonly filePath: string | undefined;
  private readonly now: () => number;

  /** `dir` enables persistence; omit it for an in-memory model (tests, simulation). */
  constructor(options: { readonly dir?: string; readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    if (options.dir) {
      ensureDir(options.dir);
      this.filePath = path.join(options.dir, "world.jsonl");
      for (const obs of readJsonlSync<Observation>(this.filePath)) {
        if (isEntityKind(obs.kind) && typeof obs.label === "string") {
          this.apply(obs);
        }
      }
    }
  }

  get size(): number {
    return this.entities.size;
  }

  /** Record a sighting or a statement about the world. */
  observe(observation: Observation): ObserveResult {
    const label = observation.label.trim();
    if (!label) {
      throw new Error("An observation needs a label.");
    }
    if (!isEntityKind(observation.kind)) {
      throw new Error(`Unknown entity kind: ${String(observation.kind)}`);
    }
    const stamped: Observation = {
      ...observation,
      label,
      atISO: observation.atISO ?? new Date(this.now()).toISOString(),
    };
    const result = this.apply(stamped);
    if (this.filePath) {
      appendJsonl(this.filePath, { ...stamped, id: result.entity.id });
    }
    return result;
  }

  get(id: string): WorldEntity | undefined {
    return this.entities.get(id);
  }

  /** Look an entity up by id, or by label (accent and case insensitive). */
  find(idOrLabel: string, kind?: EntityKind): WorldEntity | undefined {
    const byId = this.entities.get(idOrLabel);
    if (byId && (!kind || byId.kind === kind)) {
      return byId;
    }
    const wanted = normalizeLabel(idOrLabel);
    let best: WorldEntity | undefined;
    for (const entity of this.entities.values()) {
      if ((kind && entity.kind !== kind) || normalizeLabel(entity.label) !== wanted) {
        continue;
      }
      if (!best || entity.lastSeenISO > best.lastSeenISO) {
        best = entity;
      }
    }
    return best;
  }

  /** Entities matching every given filter, most trustworthy first. */
  query(query: WorldQuery = {}): ReadonlyArray<ScoredEntity> {
    const nowMs = this.now();
    const floor = clampConfidence(query.minConfidence ?? 0);
    const out: ScoredEntity[] = [];
    for (const entity of this.entities.values()) {
      if (query.kind && entity.kind !== query.kind) {
        continue;
      }
      if (query.placeId && entity.position?.placeId !== query.placeId) {
        continue;
      }
      if (query.property && entity.properties[query.property.key] !== query.property.value) {
        continue;
      }
      const confidence = effectiveConfidence(entity, nowMs);
      if (confidence < floor) {
        continue;
      }
      out.push({ entity, confidence });
    }
    out.sort((a, b) => b.confidence - a.confidence || a.entity.id.localeCompare(b.entity.id));
    return out.slice(0, Math.max(0, query.limit ?? out.length));
  }

  /** Where something is believed to be, how sure that is, and whether to look again. */
  whereIs(idOrLabel: string, kind?: EntityKind): Whereabouts | undefined {
    const entity = this.find(idOrLabel, kind);
    if (!entity) {
      return undefined;
    }
    const confidence = effectiveConfidence(entity, this.now());
    const chain = [entity.label];
    const visited = new Set([entity.id]);
    for (
      let placeId = entity.position?.placeId;
      placeId && !visited.has(placeId);
      placeId = this.entities.get(placeId)?.position?.placeId
    ) {
      visited.add(placeId);
      chain.push(this.entities.get(placeId)?.label ?? placeId);
    }
    return { entity, confidence, stale: confidence < STALE_BELOW, chain };
  }

  /** Everything believed to be in or on `placeId`. */
  contents(placeId: string): ReadonlyArray<ScoredEntity> {
    return this.query({ placeId });
  }

  private resolveId(observation: Observation): string {
    if (observation.id) {
      return observation.id;
    }
    return (
      this.find(observation.label, observation.kind)?.id ??
      `${observation.kind}_${slug(observation.label)}`
    );
  }

  /** Pure state transition shared by `observe` and replay. */
  private apply(observation: Observation): ObserveResult {
    const id = this.resolveId(observation);
    const atISO = observation.atISO ?? new Date(this.now()).toISOString();
    const sensed = observation.source === "sensor";
    const observed = sensed
      ? clampConfidence(observation.confidence)
      : Math.min(UNSENSED_CEILING, clampConfidence(observation.confidence));
    const relations = (observation.relations ?? []).map((r): Relation => ({
      predicate: r.predicate,
      targetId: r.targetId,
      confidence: clampConfidence(r.confidence ?? observed),
      observedAtISO: atISO,
    }));
    const previous = this.entities.get(id);

    if (!previous) {
      const entity: WorldEntity = {
        id,
        kind: observation.kind,
        label: observation.label,
        ...(observation.position ? { position: observation.position } : {}),
        state: { ...observation.state },
        properties: { ...observation.properties },
        relations,
        confidence: observed,
        firstSeenISO: atISO,
        lastSeenISO: atISO,
        source: observation.source,
        observations: 1,
      };
      this.entities.set(id, entity);
      return { entity, created: true };
    }

    const oldPlace = previous.position?.placeId;
    const newPlace = observation.position?.placeId;
    const moved = newPlace !== undefined && oldPlace !== undefined && newPlace !== oldPlace;
    // Consistent evidence accumulates; contradicting evidence replaces. A claim
    // can raise a belief up to the unsensed ceiling but never lower one a
    // sensor already backs.
    const prior = effectiveConfidence(previous, Date.parse(atISO));
    const combined = Math.min(MAX_CONFIDENCE, 1 - (1 - prior) * (1 - observed));
    const confidence = moved
      ? observed
      : sensed
        ? combined
        : Math.max(prior, Math.min(UNSENSED_CEILING, combined));

    const mergedRelations = new Map(
      previous.relations.map((r) => [`${r.predicate}\u0000${r.targetId}`, r]),
    );
    for (const r of relations) {
      mergedRelations.set(`${r.predicate}\u0000${r.targetId}`, r);
    }
    const position = observation.position ?? previous.position;
    const entity: WorldEntity = {
      ...previous,
      label: observation.label,
      ...(position ? { position } : {}),
      state: { ...previous.state, ...observation.state },
      properties: { ...previous.properties, ...observation.properties },
      relations: [...mergedRelations.values()],
      confidence,
      lastSeenISO: atISO,
      source: observation.source,
      observations: previous.observations + 1,
    };
    this.entities.set(id, entity);
    return { entity, created: false, ...(moved ? { movedFrom: oldPlace } : {}) };
  }
}
