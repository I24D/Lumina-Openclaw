/**
 * world-model.ts — A persistent, uncertain picture of the surroundings.
 *
 * Lumina spec §5 and §6: the agent keeps entities (people, objects, rooms,
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
 *                      Nothing is silently deleted (spec §4.6). Durable copies
 *                      go to the host's SQLite plugin store, one row each.
 *
 * Ids are persistent `<kind>_<ULID>` (spec §75): a name is only used to find an
 * entity again, never to identify it. Forgetting is explicit and real: on
 * request, an entity's observations are removed from the log (spec §97).
 *
 * Positions are symbolic first (`placeId` points at a room, surface or
 * container entity, which gives "cup on table in kitchen" for free) with an
 * optional metric pose for when a body with SLAM exists.
 */
import { clampConfidence } from "../contracts/uncertainty.js";
import { newEntityId } from "../shared/ids.js";
import { KeyedLog, type StateStorePort } from "../shared/state-store.js";

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

/** One sighting of an entity, kept for temporal questions (spec §54). */
export type Sighting = {
  readonly atISO: string;
  readonly placeId?: string;
  readonly confidence: number;
  readonly source: Provenance;
};

/** A relation edge as seen from either end of the knowledge graph (spec §53). */
export type GraphEdge = {
  readonly subjectId: string;
  readonly predicate: string;
  readonly targetId: string;
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

/** Sightings retained per entity for temporal questions. */
export const HISTORY_LIMIT = 64;

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
  private readonly sightings = new Map<string, Sighting[]>();
  /** Every observation this process knows, stored and new, oldest first. */
  private log: Observation[] = [];
  private readonly store: KeyedLog<Observation> | undefined;
  /** Forget requests made while stored observations were still loading. */
  private readonly loadingPurges: Array<(obs: Observation) => boolean> = [];
  private loading: boolean;
  private readonly now: () => number;
  /** Resolves once stored observations are loaded (immediately without a store). */
  readonly ready: Promise<void>;

  /** Without `store` the model is session-only (tests, simulation). */
  constructor(
    options: {
      readonly store?: StateStorePort<Observation>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.loading = Boolean(options.store);
    if (!options.store) {
      this.ready = Promise.resolve();
      return;
    }
    const onError = options.onError ?? (() => undefined);
    this.store = new KeyedLog(options.store, onError);
    this.ready = this.store.hydrate().then(
      (stored) => {
        const valid = stored.filter(
          (obs) =>
            isEntityKind(obs.kind) &&
            typeof obs.label === "string" &&
            !this.loadingPurges.some((drop) => drop(obs)),
        );
        // Stored history first, then whatever this session observed while loading.
        this.log = [...valid, ...this.log];
        this.replay(this.log);
        this.loadingPurges.length = 0;
        this.loading = false;
      },
      (error: unknown) => {
        this.loading = false;
        onError(error);
      },
    );
  }

  private replay(log: ReadonlyArray<Observation>): void {
    this.entities.clear();
    this.sightings.clear();
    for (const obs of log) {
      this.apply(obs);
    }
  }

  /** Resolves when every observation so far has been handed to the store. */
  async flush(): Promise<void> {
    await this.ready;
    await this.store?.flush();
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
      ...structuredClone(observation),
      label,
      atISO: observation.atISO ?? new Date(this.now()).toISOString(),
    };
    if (!Number.isFinite(Date.parse(stamped.atISO ?? ""))) {
      throw new Error("An observation needs a valid timestamp.");
    }
    const result = this.apply(stamped);
    const record = { ...stamped, id: result.entity.id };
    this.log.push(record);
    this.store?.append(record);
    return result;
  }

  /**
   * Remove every observation matching `drop` from the log and rebuild. This is
   * the only deletion path, and it only runs on an explicit request (forget
   * this entity, forget this session). Returns how many observations went.
   */
  private purge(drop: (obs: Observation) => boolean): number {
    if (this.loading) {
      this.loadingPurges.push(drop);
    }
    void this.ready.then(() => this.store?.remove(drop));
    const kept = this.log.filter((obs) => !drop(obs));
    const removed = this.log.length - kept.length;
    if (removed > 0) {
      this.log = kept;
      this.replay(kept);
    }
    return removed;
  }

  /** Forget an entity entirely: its observations leave the log, not just the view. */
  forget(id: string): number {
    return this.purge((obs) => obs.id === id);
  }

  /** Forget everything observed at or after `sinceISO` ("forget this session"). */
  forgetSince(sinceISO: string): number {
    return this.purge((obs) => (obs.atISO ?? "") >= sinceISO);
  }

  /** Recent sightings of an entity, oldest first. */
  history(id: string): ReadonlyArray<Sighting> {
    return this.sightings.get(id) ?? [];
  }

  /** Edges leaving `id` (what it owns, where it is...), optionally one predicate. */
  related(id: string, predicate?: string): ReadonlyArray<GraphEdge> {
    const entity = this.entities.get(id);
    return (entity?.relations ?? [])
      .filter((r) => !predicate || r.predicate === predicate)
      .map((r) => ({
        subjectId: id,
        predicate: r.predicate,
        targetId: r.targetId,
        confidence: r.confidence,
      }));
  }

  /** Edges arriving at `id` (who owns it, what is on it...), optionally one predicate. */
  relatedTo(id: string, predicate?: string): ReadonlyArray<GraphEdge> {
    const out: GraphEdge[] = [];
    for (const entity of this.entities.values()) {
      for (const r of entity.relations) {
        if (r.targetId === id && (!predicate || r.predicate === predicate)) {
          out.push({
            subjectId: entity.id,
            predicate: r.predicate,
            targetId: id,
            confidence: r.confidence,
          });
        }
      }
    }
    return out;
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
    // A name only finds an existing entity; a new one gets an id that never depends on it.
    return (
      this.find(observation.label, observation.kind)?.id ??
      newEntityId(observation.kind, Date.parse(observation.atISO ?? "") || this.now())
    );
  }

  private remember(entity: WorldEntity, atISO: string, observed: number, source: Provenance): void {
    const list = this.sightings.get(entity.id) ?? [];
    list.push({
      atISO,
      confidence: observed,
      source,
      ...(entity.position?.placeId ? { placeId: entity.position.placeId } : {}),
    });
    if (list.length > HISTORY_LIMIT) {
      list.splice(0, list.length - HISTORY_LIMIT);
    }
    this.sightings.set(entity.id, list);
  }

  /** State transition shared by `observe` and replay. */
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
      this.remember(entity, atISO, observed, observation.source);
      return { entity, created: true };
    }

    if (Date.parse(atISO) < Date.parse(previous.lastSeenISO)) {
      // Preserve history without making an old sighting the current location.
      this.remember(
        { ...previous, position: observation.position },
        atISO,
        observed,
        observation.source,
      );
      return { entity: previous, created: false };
    }

    const oldPlace = previous.position?.placeId;
    const newPlace = observation.position?.placeId;
    const moved = newPlace !== undefined && oldPlace !== undefined && newPlace !== oldPlace;
    // Consistent evidence accumulates; contradicting evidence replaces. A claim
    // can raise a belief up to the unsensed ceiling but never lower one a
    // sensor already backs.
    const prior = effectiveConfidence(previous, Date.parse(atISO));
    const combined = Math.min(MAX_CONFIDENCE, 1 - (1 - prior) * (1 - observed));
    const changedClaim =
      !sensed &&
      ((observation.position !== undefined &&
        JSON.stringify(observation.position) !== JSON.stringify(previous.position)) ||
        Object.entries(observation.state ?? {}).some(
          ([key, value]) => previous.state[key] !== value,
        ) ||
        Object.entries(observation.properties ?? {}).some(
          ([key, value]) => previous.properties[key] !== value,
        ) ||
        relations.length > 0);
    const confidence =
      moved || changedClaim
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
    this.remember(entity, atISO, observed, observation.source);
    return { entity, created: false, ...(moved ? { movedFrom: oldPlace } : {}) };
  }
}
