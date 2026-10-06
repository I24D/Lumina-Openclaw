/**
 * expression.ts — What Lumina's face shows, derived from her situation.
 *
 * Lumina spec §28 (head and face: expressions), §87 and §88 (virtual presence
 * and avatar). One expression for every face Lumina has: the avatar in the
 * Control UI today, a robot's head later. It is derived, never stored, and it
 * never claims a feeling: it shows functional state (stopped, busy, thinking,
 * listening, who is here).
 */
import type { PresenceState } from "./presence.js";

export const EXPRESSIONS = [
  "idle",
  "curious",
  "thinking",
  "working",
  "happy",
  "sleepy",
  "attentive",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export type ExpressionState = { readonly expression: Expression; readonly reason: string };

/** How long a just-executed action keeps the face "working". */
const WORKING_MS = 10_000;

export function expressionOf(input: {
  readonly emergencyStop: boolean;
  readonly paused: boolean;
  readonly pendingEvents: number;
  /** When the cognitive loop last executed an action, if ever. */
  readonly lastExecutedAtISO?: string;
  readonly presence: PresenceState;
  readonly ownerId?: string;
  readonly nowMs: number;
}): ExpressionState {
  if (input.emergencyStop) {
    return { expression: "sleepy", reason: "The emergency stop is engaged." };
  }
  if (input.paused) {
    return { expression: "sleepy", reason: "A person paused autonomy." };
  }
  if (input.lastExecutedAtISO && input.nowMs - Date.parse(input.lastExecutedAtISO) <= WORKING_MS) {
    return { expression: "working", reason: "Carrying out an action." };
  }
  const speaker = input.presence.present.find((p) => p.speaking);
  if (speaker) {
    return { expression: "attentive", reason: `Listening to ${speaker.name}.` };
  }
  if (input.pendingEvents > 0) {
    return {
      expression: "thinking",
      reason: `${input.pendingEvents} events waiting for attention.`,
    };
  }
  const known = input.presence.present.filter((p) => p.personId);
  const owner = input.ownerId ? known.find((p) => p.personId === input.ownerId) : undefined;
  if (owner) {
    return { expression: "happy", reason: `${owner.name} is here.` };
  }
  if (known.length > 0) {
    return { expression: "attentive", reason: `${known.map((p) => p.name).join(", ")} here.` };
  }
  if (input.presence.present.length > 0 || input.presence.arrivals.length > 0) {
    return { expression: "curious", reason: "Someone is here." };
  }
  return { expression: "idle", reason: "Nothing needs attention." };
}
