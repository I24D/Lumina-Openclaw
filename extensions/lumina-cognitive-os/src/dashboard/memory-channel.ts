/**
 * memory-channel.ts — What Lumina remembers, as a person sees and corrects it.
 *
 * Lumina spec §68 (memory UI: search, inspect, correct, archive, forget, merge;
 * every memory shows its origin and confidence). The Lumina tab's Memory view
 * reads `memoryState` and acts through these owner commands; searching happens
 * in the view over what this returns. Shared Supabase memory has its own
 * editor and is not touched here.
 */
import type { CognitiveRuntime } from "../cognition/cognitive-runtime.js";
import { effectiveConfidence } from "../world/world-model.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const LIMIT = 200;

type Params = Readonly<Record<string, unknown>>;
type Audited = (action: string, reason: string, ok: boolean) => unknown;

/** A request the channel will not run as given; nothing was changed. */
export class MemoryChannelError extends Error {}

function id(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new MemoryChannelError(`${name} must be an id`);
  }
  return value;
}

/** Lessons, episodes, world entities and beliefs, each with where it came from and how sure. */
export function memoryState(runtime: CognitiveRuntime, nowMs: number = Date.now()) {
  return {
    lessons: runtime.lessons.list().map((l) => ({
      id: l.id,
      trigger: l.trigger,
      claim: l.claim,
      confidence: l.confidence,
      origin: `${l.confirmations} confirmations, ${l.contradictions} contradictions`,
      archived: l.archived === true,
      updatedAtISO: l.updatedAtISO,
    })),
    episodes: (runtime.episodic?.tail(50) ?? []).map((e) => ({
      id: e.id,
      atISO: e.atISO,
      kind: e.kind,
      summary: e.summary,
      tags: e.tags,
    })),
    entities: runtime.world.query({ limit: LIMIT }).map(({ entity }) => ({
      id: entity.id,
      label: entity.label,
      kind: entity.kind,
      origin: entity.source,
      confidence: Math.round(effectiveConfidence(entity, nowMs) * 100) / 100,
      observations: entity.observations,
      lastSeenISO: entity.lastSeenISO,
    })),
    beliefs: runtime.mind.list(LIMIT),
  };
}

export type MemoryState = ReturnType<typeof memoryState>;

/** Owner commands of the Memory view, keyed by gateway method name. */
export function memoryCommands(runtime: CognitiveRuntime, audited: Audited) {
  return {
    "lumina.core.memory.lesson": async (params: Params) => {
      const lessonId = id(params, "id");
      const action = params.action;
      let ok: boolean;
      switch (action) {
        case "archive":
        case "restore":
          ok = runtime.lessons.archive(lessonId, action === "archive") !== undefined;
          break;
        case "confirm":
          ok = runtime.lessons.confirm(lessonId) !== undefined;
          break;
        case "contradict":
          ok = runtime.lessons.contradict(lessonId) !== undefined;
          break;
        case "forget":
          ok = runtime.lessons.forget(lessonId);
          break;
        default:
          throw new MemoryChannelError(
            "action must be archive, restore, confirm, contradict or forget",
          );
      }
      audited(`memory.lesson.${action}`, lessonId, ok);
      return { ok };
    },
    "lumina.core.memory.episode.forget": async (params: Params) => {
      const episodeId = id(params, "id");
      const ok = runtime.episodic?.forget(episodeId) ?? false;
      audited("memory.episode.forget", episodeId, ok);
      return { ok };
    },
    "lumina.core.world.merge": async (params: Params) => {
      const keepId = id(params, "keepId");
      const dropId = id(params, "dropId");
      const moved = runtime.world.merge(keepId, dropId);
      audited("world.merge", `${dropId} -> ${keepId}: ${moved} observations`, moved > 0);
      return { ok: moved > 0, moved };
    },
  } as const;
}
