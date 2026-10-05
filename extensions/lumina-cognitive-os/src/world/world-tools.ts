/**
 * world-tools.ts — Voice-first access to the world model.
 *
 *   lumina_world_observe  "las llaves están en la mesa"   record what was learned
 *   lumina_world_query    "¿dónde está mi taza?"          ask what is believed
 *
 * The agent can only record claims ("agent") or inferences ("inferred").
 * Machine evidence ("sensor") arrives through perception events on the
 * router, never through a tool the model fills in, and the world model keeps
 * claims below the confidence a body needs to act on them.
 */
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import {
  ENTITY_KINDS,
  type EntityKind,
  type Observation,
  type ScalarValue,
  type WorldModel,
} from "./world-model.js";

const SCALAR = Type.Union([Type.String({ maxLength: 256 }), Type.Number(), Type.Boolean()]);
const AGENT_SOURCES = ["agent", "inferred"] as const;

export function createWorldObserveTool(world: WorldModel): AnyAgentTool {
  return {
    name: "lumina_world_observe",
    label: "Lumina World Observe",
    description:
      "Records something learned about the surroundings: a person, object, room, device, door... " +
      "with its place, state, properties and relations. Use it when the user mentions where things " +
      "are or how they are ('las llaves están en la mesa', 'la puerta está cerrada'). Use source " +
      "'inferred' for deductions. Claims never count as sensor evidence.",
    parameters: Type.Object({
      kind: Type.Union(ENTITY_KINDS.map((k) => Type.Literal(k))),
      label: Type.String({ minLength: 1, maxLength: 128, description: "Name, e.g. 'taza negra'." }),
      id: Type.Optional(
        Type.String({ maxLength: 128, description: "Known entity id; omit to match by label." }),
      ),
      placeId: Type.Optional(
        Type.String({
          maxLength: 128,
          description: "Id of the room/surface/container it is in or on.",
        }),
      ),
      state: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), SCALAR)),
      properties: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), SCALAR)),
      relations: Type.Optional(
        Type.Array(
          Type.Object({
            predicate: Type.String({
              maxLength: 64,
              description: "e.g. on_top_of, inside, near, owned_by.",
            }),
            targetId: Type.String({ maxLength: 128 }),
          }),
          { maxItems: 16 },
        ),
      ),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      source: Type.Optional(Type.Union(AGENT_SOURCES.map((s) => Type.Literal(s)))),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as {
        kind: EntityKind;
        label: string;
        id?: string;
        placeId?: string;
        state?: Record<string, ScalarValue>;
        properties?: Record<string, ScalarValue>;
        relations?: Array<{ predicate: string; targetId: string }>;
        confidence: number;
        source?: (typeof AGENT_SOURCES)[number];
      };
      const observation: Observation = {
        kind: p.kind,
        label: p.label,
        confidence: p.confidence,
        source: p.source ?? "agent",
        ...(p.id ? { id: p.id } : {}),
        ...(p.placeId ? { position: { placeId: p.placeId } } : {}),
        ...(p.state ? { state: p.state } : {}),
        ...(p.properties ? { properties: p.properties } : {}),
        ...(p.relations ? { relations: p.relations } : {}),
      };
      try {
        const result = world.observe(observation);
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        throw new ToolInputError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

const QUERY_ACTIONS = ["where", "query", "contents"] as const;

export function createWorldQueryTool(world: WorldModel): AnyAgentTool {
  return {
    name: "lumina_world_query",
    label: "Lumina World Query",
    description:
      "Asks the world model. 'where' locates one thing by id or name and says whether the belief is " +
      "stale (look again before relying on it); 'contents' lists what is in or on a place; 'query' " +
      "filters by kind, place and minimum confidence. Confidences already account for time passed.",
    parameters: Type.Object({
      action: Type.Union(QUERY_ACTIONS.map((a) => Type.Literal(a))),
      target: Type.Optional(
        Type.String({ maxLength: 128, description: "Id or name, for where/contents." }),
      ),
      kind: Type.Optional(Type.Union(ENTITY_KINDS.map((k) => Type.Literal(k)))),
      placeId: Type.Optional(Type.String({ maxLength: 128 })),
      minConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
    }),
    async execute(_id, rawParams) {
      const p = rawParams as {
        action: (typeof QUERY_ACTIONS)[number];
        target?: string;
        kind?: EntityKind;
        placeId?: string;
        minConfidence?: number;
        limit?: number;
      };
      switch (p.action) {
        case "where": {
          if (!p.target) {
            throw new ToolInputError("target is required for where");
          }
          const where = world.whereIs(p.target, p.kind);
          return where
            ? jsonResult({ ok: true, ...where })
            : jsonResult({ ok: false, error: `Nothing called ${p.target} is in the world model.` });
        }
        case "contents": {
          const place = p.target ? world.find(p.target) : undefined;
          if (!place) {
            throw new ToolInputError("target must name a known place for contents");
          }
          return jsonResult({
            ok: true,
            place: place.id,
            contents: world.contents(place.id).slice(0, p.limit ?? 20),
          });
        }
        case "query":
          return jsonResult({
            ok: true,
            results: world.query({
              ...(p.kind ? { kind: p.kind } : {}),
              ...(p.placeId ? { placeId: p.placeId } : {}),
              ...(p.minConfidence !== undefined ? { minConfidence: p.minConfidence } : {}),
              limit: p.limit ?? 20,
            }),
          });
        default:
          throw new ToolInputError(`Unknown action: ${String(p.action)}`);
      }
    },
  };
}
