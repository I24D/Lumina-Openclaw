/**
 * situational-reasoner.ts — Lumina notices what matters and proposes what to do.
 *
 * M3GAN spec §14 (reasoning), §32 (energy), §89 (presence), §92 (curiosity)
 * and §96 (companion mode).
 * Deterministic rules over the events the loop admits; no language model runs
 * here. Each rule yields a proposed action whose summary is an instruction for
 * the agent. The autonomy gate then decides: at L3 the agent hears it as a
 * proposal to put to the person first, at L4 and above a reversible, low-risk
 * one runs (the agent is woken with it). Nothing here touches a body or a
 * tool; the agent acts with its own tools and their policies.
 *
 * Every rule has a cooldown, so a flickering sensor cannot flood the agent.
 */
import { payloadOf } from "../../events/catalog.js";
import type { InteractionMode } from "../../safety/interaction-mode.js";
import type { PeopleRegistry } from "../../social/people.js";
import type { PresenceState } from "../../social/presence.js";
import { affordancesOf } from "../../world/affordances.js";
import type { WorldModel } from "../../world/world-model.js";
import { trustOf, type CognitiveEvent } from "../attention.js";
import type { CycleRecord, ProposedAction, Reasoner, ReasonerResult } from "./cognitive-loop.js";

export type Initiative = {
  /** One rule's identity, used to replace a pending initiative instead of piling them. */
  readonly key: string;
  readonly text: string;
};

type Rule = {
  readonly key: (event: CognitiveEvent) => string | undefined;
  readonly propose: (event: CognitiveEvent) => Omit<ProposedAction, "run"> | undefined;
  readonly cooldownMs: number;
};

const MINUTE = 60_000;

/** At most one question about the unknown in this window, whatever it is about. */
const CURIOSITY_BUDGET_MS = 30 * MINUTE;

export function createSituationalReasoner(deps: {
  readonly people: PeopleRegistry;
  /** Wakes the agent with an initiative (the run of an executed proposal). */
  readonly deliver: (initiative: Initiative) => void;
  /** Falls through to this when no rule applies (e.g. the observe-only reasoner's notes). */
  readonly fallback?: Reasoner;
  readonly now?: () => number;
  /** For curiosity: what the unknown thing is now (it may have been explained since). */
  readonly world?: Pick<WorldModel, "get">;
  /** For curiosity: questions are asked only to someone who is there. */
  readonly presence?: () => PresenceState;
  /** The interaction mode, for companion check-ins. */
  readonly mode?: () => InteractionMode;
}): Reasoner {
  const now = deps.now ?? Date.now;
  const lastFired = new Map<string, number>();
  let lastCuriosity = Number.NEGATIVE_INFINITY;
  const ownerSensed = (event: CognitiveEvent) => {
    const owner = deps.people.owner();
    const id =
      payloadOf(event, "person.detected")?.personId ??
      payloadOf(event, "speech.detected")?.speakerId;
    return owner !== undefined && id === owner.id;
  };
  // A knowledge gap (world/curiosity.ts) that is still a gap when the cycle runs.
  const unknownThing = (event: CognitiveEvent) => {
    const gap = payloadOf(event, "knowledge.gap");
    const entity = gap ? deps.world?.get(gap.entityId) : undefined;
    return entity && affordancesOf(entity).source === "unknown" ? entity : undefined;
  };

  const rules: ReadonlyArray<Rule> = [
    {
      // The owner arriving: greet, once in a while.
      key: (event) => {
        const seen = payloadOf(event, "person.detected");
        const owner = deps.people.owner();
        return seen?.personId && owner && seen.personId === owner.id ? "greet-owner" : undefined;
      },
      propose: (event) => {
        const seen = payloadOf(event, "person.detected");
        return {
          summary: `${seen?.label ?? "Your owner"} just arrived (recognized by ${event.source}). If it is a good moment, greet briefly.`,
          riskTier: "SAFE",
          reversible: true,
        };
      },
      cooldownMs: 120 * MINUTE,
    },
    {
      // Someone the camera or microphone cannot recognize, while the owner is not around.
      key: (event) => {
        const seen = payloadOf(event, "person.detected");
        return seen && !seen.personId ? "unknown-person" : undefined;
      },
      propose: (event) => ({
        summary: `An unknown person was sensed by the ${event.source}. Tell your owner, without guessing who it is.`,
        riskTier: "WARNING",
        reversible: true,
      }),
      cooldownMs: 30 * MINUTE,
    },
    {
      // Curiosity (spec §92): a knowledge gap, raised only when someone is there to ask.
      key: (event) => {
        const thing = unknownThing(event);
        const someone = (deps.presence?.().present.length ?? 0) > 0;
        return thing && someone && now() - lastCuriosity >= CURIOSITY_BUDGET_MS
          ? `curious:${thing.id}`
          : undefined;
      },
      propose: (event) => {
        const thing = unknownThing(event);
        if (!thing) {
          return undefined;
        }
        lastCuriosity = now();
        const place = thing.position?.placeId ? deps.world?.get(thing.position.placeId) : undefined;
        return {
          summary: `You see something you do not recognize: "${thing.label}"${
            place ? ` (${place.label})` : ""
          }. Only if it helps the current task or conversation, ask what it is and record the answer with lumina_world_observe; otherwise leave it, and never handle it to find out.`,
          riskTier: "SAFE",
          reversible: true,
        };
      },
      cooldownMs: 7 * 24 * 60 * MINUTE,
    },
    {
      // Companion mode (spec §96): a check-in now and then, never pressure.
      key: (event) =>
        deps.mode?.() === "companion" && ownerSensed(event) ? "companion-check-in" : undefined,
      propose: () => ({
        summary: `Companion mode: if the moment is right, check in briefly with ${
          deps.people.owner()?.name ?? "your owner"
        } about their day or something they mentioned before. No pressure and no guilt; encourage their own plans and the people in their life.`,
        riskTier: "SAFE",
        reversible: true,
      }),
      cooldownMs: 180 * MINUTE,
    },
    {
      // Energy (spec §32): plug in before it is too late.
      key: (event) =>
        event.kind === "battery.low" || event.kind === "battery.critical" ? event.kind : undefined,
      propose: (event) => {
        // battery.critical comes from awareness with the same { percent } payload.
        const percent = (event.payload as { readonly percent?: unknown } | undefined)?.percent;
        return {
          summary: `Battery ${event.kind === "battery.critical" ? "critical" : "low"}${
            typeof percent === "number" ? ` (${percent}%)` : ""
          }: remind your owner to plug the computer in.`,
          riskTier: "SAFE",
          reversible: true,
        };
      },
      cooldownMs: 30 * MINUTE,
    },
    {
      // A subsystem down: say so plainly.
      key: (event) => {
        const health = payloadOf(event, "subsystem.health");
        return health && health.status === "down" ? `down:${health.subsystem}` : undefined;
      },
      propose: (event) => {
        const health = payloadOf(event, "subsystem.health");
        return {
          summary: `The ${health?.subsystem ?? "a"} subsystem is down: ${health?.detail ?? "no detail"}. Tell your owner what stopped working.`,
          riskTier: "SAFE",
          reversible: true,
        };
      },
      cooldownMs: 60 * MINUTE,
    },
  ];

  return (event, context): ReasonerResult | undefined => {
    for (const rule of rules) {
      const key = rule.key(event);
      if (!key) {
        continue;
      }
      const at = now();
      const last = lastFired.get(key);
      if (last !== undefined && at - last < rule.cooldownMs) {
        return {
          signals: [],
          note: `${key}: already raised ${Math.round((at - last) / MINUTE)} min ago`,
        };
      }
      const proposal = rule.propose(event);
      if (!proposal) {
        continue;
      }
      lastFired.set(key, at);
      return {
        // Rules fire on sensor-backed events with an explicit trigger: confident enough to act.
        signals: [{ source: "rule", value: 0.97 }],
        note: `rule ${key}`,
        action: {
          ...proposal,
          run: () => deps.deliver({ key, text: proposal.summary }),
        },
      };
    }
    return deps.fallback?.(event, context);
  };
}

/**
 * Below the execute threshold a proposal is a question for the person, asked by
 * the agent. Proposals prompted by untrusted content stay on record only.
 */
export function surfaceProposals(deliver: (initiative: Initiative) => void) {
  return (record: CycleRecord): void => {
    if (
      record.action &&
      (record.outcome === "propose" || record.outcome === "confirm") &&
      trustOf(record.event) !== "untrusted"
    ) {
      deliver({
        key: `proposal:${record.event.kind}`,
        text: `Proposal (ask your owner before acting): ${record.action}`,
      });
    }
  };
}
