/**
 * catalog.ts — The typed, versioned events Lumina's subsystems exchange.
 *
 * Lumina spec §58 and §74: the system runs on typed events with versioned
 * schemas. The router itself stays generic (`CognitiveEvent`), so any
 * producer can be added without touching it; this catalog is the contract
 * for the kinds the core understands, with their payloads and default weights.
 *
 * Kinds are dotted, like the existing awareness events (`battery.low`). The
 * spec's names map one to one: PersonDetected = `person.detected`,
 * SpeechRecognized = `speech.recognized`, ObjectMoved = `object.moved`,
 * TaskCreated = `task.created`, ToolCompleted = `tool.completed`,
 * BatteryLow = `battery.low`, NavigationFinished = `navigation.finished`,
 * RobotTouched = `robot.touched`, MemoryRetrieved = `memory.retrieved`.
 */
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CognitiveEvent, EventTrust } from "../contracts/attention.js";
import type { Observation } from "../world/world-model.js";
import { ENTITY_KINDS, PROVENANCES } from "../world/world-model.js";

/** Bump when a payload changes shape; consumers check it before reading. */
export const CORE_EVENT_SCHEMA_VERSION = 1;

export type CoreEventPayloads = {
  "person.detected": {
    readonly personId?: string;
    readonly label: string;
    readonly confidence: number;
    readonly placeId?: string;
    readonly distanceM?: number;
  };
  "person.left": { readonly personId: string; readonly placeId?: string };
  "speech.recognized": {
    readonly text: string;
    readonly confidence: number;
    readonly speakerId?: string;
    readonly language?: string;
  };
  /** Someone spoke; who, when a consented voice template matched. No transcript. */
  "speech.detected": {
    readonly speakerId?: string;
    readonly confidence: number;
    readonly durationMs: number;
  };
  "object.moved": {
    readonly objectId: string;
    readonly toPlaceId: string;
    readonly fromPlaceId?: string;
    readonly confidence: number;
  };
  "task.created": {
    readonly taskId: string;
    readonly title: string;
    readonly origin: "workboard" | "goal" | "agent";
  };
  "tool.completed": { readonly tool: string; readonly ok: boolean; readonly durationMs?: number };
  "battery.low": { readonly percent: number };
  "navigation.finished": {
    readonly targetId: string;
    readonly ok: boolean;
    readonly detail?: string;
  };
  "robot.touched": { readonly bodyPart: string; readonly forceN?: number };
  "memory.retrieved": { readonly query: string; readonly hits: number };
  "world.observed": { readonly observation: Observation };
  "danger.detected": {
    readonly hazard: string;
    readonly severity: "low" | "moderate" | "high" | "critical";
    readonly confidence: number;
    readonly personId?: string;
    readonly placeId?: string;
  };
  "privacy.changed": { readonly state: string; readonly enabled: boolean };
  "subsystem.health": {
    readonly subsystem: string;
    readonly status: "ok" | "degraded" | "down";
    readonly detail?: string;
  };
  /** The window in front changed (screen perception: Lumina virtual, spec §87). */
  "screen.foreground": { readonly process: string; readonly title: string };
  /** A large part of the screen changed. */
  "screen.changed": { readonly changedRatio: number };
  /** A sensor saw something new whose use nothing explains (curiosity, spec §92). */
  "knowledge.gap": {
    readonly entityId: string;
    readonly label: string;
    readonly kind: string;
    readonly placeId?: string;
  };
};

export type CoreEventKind = keyof CoreEventPayloads;

const id = Type.String({ minLength: 1, maxLength: 128 });
const confidence = Type.Number({ minimum: 0, maximum: 1 });
const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
export const OBSERVATION_SCHEMA = Type.Object({
  id: Type.Optional(id),
  kind: Type.Union(ENTITY_KINDS.map((kind) => Type.Literal(kind))),
  label: Type.String({ minLength: 1 }),
  confidence,
  source: Type.Union(PROVENANCES.map((source) => Type.Literal(source))),
  atISO: Type.Optional(Type.String()),
  position: Type.Optional(
    Type.Object({
      placeId: Type.Optional(id),
      distanceM: Type.Optional(Type.Number({ minimum: 0 })),
      metric: Type.Optional(
        Type.Object({
          x: Type.Number(),
          y: Type.Number(),
          z: Type.Optional(Type.Number()),
          frame: id,
        }),
      ),
    }),
  ),
  state: Type.Optional(Type.Record(Type.String(), scalar)),
  properties: Type.Optional(Type.Record(Type.String(), scalar)),
  relations: Type.Optional(
    Type.Array(Type.Object({ predicate: id, targetId: id, confidence: Type.Optional(confidence) })),
  ),
});

const PAYLOAD_SCHEMAS = {
  "person.detected": Type.Object({
    personId: Type.Optional(id),
    label: Type.String(),
    confidence,
    placeId: Type.Optional(id),
    distanceM: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  "person.left": Type.Object({ personId: id, placeId: Type.Optional(id) }),
  "speech.recognized": Type.Object({
    text: Type.String(),
    confidence,
    speakerId: Type.Optional(id),
    language: Type.Optional(Type.String()),
  }),
  "speech.detected": Type.Object({
    speakerId: Type.Optional(id),
    confidence,
    durationMs: Type.Number({ minimum: 0 }),
  }),
  "object.moved": Type.Object({
    objectId: id,
    toPlaceId: id,
    fromPlaceId: Type.Optional(id),
    confidence,
  }),
  "task.created": Type.Object({
    taskId: id,
    title: Type.String(),
    origin: Type.Union([Type.Literal("workboard"), Type.Literal("goal"), Type.Literal("agent")]),
  }),
  "tool.completed": Type.Object({
    tool: id,
    ok: Type.Boolean(),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  "battery.low": Type.Object({ percent: Type.Number({ minimum: 0, maximum: 100 }) }),
  "navigation.finished": Type.Object({
    targetId: id,
    ok: Type.Boolean(),
    detail: Type.Optional(Type.String()),
  }),
  "robot.touched": Type.Object({
    bodyPart: id,
    forceN: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  "memory.retrieved": Type.Object({ query: Type.String(), hits: Type.Integer({ minimum: 0 }) }),
  "world.observed": Type.Object({ observation: OBSERVATION_SCHEMA }),
  "danger.detected": Type.Object({
    hazard: Type.String(),
    severity: Type.Union([
      Type.Literal("low"),
      Type.Literal("moderate"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
    confidence,
    personId: Type.Optional(id),
    placeId: Type.Optional(id),
  }),
  "privacy.changed": Type.Object({ state: Type.String(), enabled: Type.Boolean() }),
  "subsystem.health": Type.Object({
    subsystem: id,
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded"), Type.Literal("down")]),
    detail: Type.Optional(Type.String()),
  }),
  "screen.foreground": Type.Object({ process: Type.String(), title: Type.String() }),
  "screen.changed": Type.Object({ changedRatio: confidence }),
  "knowledge.gap": Type.Object({
    entityId: id,
    label: Type.String({ minLength: 1, maxLength: 256 }),
    kind: id,
    placeId: Type.Optional(id),
  }),
} satisfies Record<CoreEventKind, object>;

/** Default salience priors per kind; a producer can override per event. */
export const EVENT_PRIORS: Readonly<
  Record<CoreEventKind, { readonly importance: number; readonly urgency: number }>
> = {
  "person.detected": { importance: 0.55, urgency: 0.4 },
  "person.left": { importance: 0.35, urgency: 0.2 },
  "speech.recognized": { importance: 0.7, urgency: 0.7 },
  "speech.detected": { importance: 0.35, urgency: 0.3 },
  "object.moved": { importance: 0.25, urgency: 0.1 },
  "task.created": { importance: 0.5, urgency: 0.3 },
  "tool.completed": { importance: 0.3, urgency: 0.2 },
  "battery.low": { importance: 0.6, urgency: 0.55 },
  "navigation.finished": { importance: 0.4, urgency: 0.3 },
  "robot.touched": { importance: 0.7, urgency: 0.8 },
  "memory.retrieved": { importance: 0.15, urgency: 0.05 },
  "world.observed": { importance: 0.2, urgency: 0.1 },
  "danger.detected": { importance: 1, urgency: 1 },
  "privacy.changed": { importance: 0.6, urgency: 0.5 },
  "subsystem.health": { importance: 0.5, urgency: 0.5 },
  "screen.foreground": { importance: 0.3, urgency: 0.2 },
  "screen.changed": { importance: 0.1, urgency: 0.05 },
  "knowledge.gap": { importance: 0.45, urgency: 0.2 },
};

export const CORE_EVENT_KINDS = Object.keys(EVENT_PRIORS) as ReadonlyArray<CoreEventKind>;

export function isCoreEventKind(kind: string): kind is CoreEventKind {
  return Object.hasOwn(EVENT_PRIORS, kind);
}

/** Build a well-formed event for the router. */
export function coreEvent<K extends CoreEventKind>(
  source: string,
  kind: K,
  payload: CoreEventPayloads[K],
  options: {
    readonly atISO?: string;
    readonly importance?: number;
    readonly urgency?: number;
    readonly trust?: EventTrust;
  } = {},
): CognitiveEvent {
  const prior = EVENT_PRIORS[kind];
  return {
    source,
    kind,
    atISO: options.atISO ?? new Date().toISOString(),
    importance: options.importance ?? prior.importance,
    urgency: options.urgency ?? prior.urgency,
    payload: { ...payload, schemaVersion: CORE_EVENT_SCHEMA_VERSION },
    ...(options.trust ? { trust: options.trust } : {}),
  };
}

/** The typed payload of `event` when it is a catalogued `kind`, else undefined. */
export function payloadOf<K extends CoreEventKind>(
  event: CognitiveEvent,
  kind: K,
): CoreEventPayloads[K] | undefined {
  if (
    event.kind !== kind ||
    !event.payload ||
    typeof event.payload !== "object" ||
    !("schemaVersion" in event.payload) ||
    event.payload.schemaVersion !== CORE_EVENT_SCHEMA_VERSION ||
    !Check(PAYLOAD_SCHEMAS[kind], event.payload)
  ) {
    return undefined;
  }
  return event.payload as CoreEventPayloads[K];
}
