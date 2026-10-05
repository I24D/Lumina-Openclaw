/**
 * teleoperation.ts — Human teleoperation gateway.
 *
 * Teleoperation is not an agent tool. Requests come from an authenticated
 * human-facing channel (the existing OpenClaw Control UI), are attributed as
 * teleop:<personId>, checked against that person's stored role, audited, and
 * then go through the exact same EmbodiedController safety review as autonomy.
 */
import type { AuditLog } from "../safety/audit-log.js";
import type { Role } from "../safety/authority.js";
import type { PeopleRegistry } from "../social/people.js";
import type { BodyIntent } from "./body.js";
import type { EmbodiedController, EmbodiedResult } from "./embodied-controller.js";

export type TeleoperationDecision =
  | { readonly ok: true; readonly role: Role; readonly result: EmbodiedResult }
  | { readonly ok: false; readonly reason: string; readonly role?: Role | "unknown" };

const LIMITED_TECHNICIAN_INTENTS: ReadonlySet<BodyIntent["type"]> = new Set([
  "stop",
  "look_at",
  "gesture",
  "point",
]);

export function roleCanTeleoperate(role: Role | "unknown", intent: BodyIntent): boolean {
  if (role === "owner" || role === "guardian") {
    return true;
  }
  if (role === "technician") {
    return LIMITED_TECHNICIAN_INTENTS.has(intent.type);
  }
  return false;
}

export class TeleoperationGateway {
  constructor(
    private readonly people: PeopleRegistry,
    private readonly body: EmbodiedController,
    private readonly audit: AuditLog,
  ) {}

  async request(
    personId: string,
    intent: BodyIntent,
    signal?: AbortSignal,
  ): Promise<TeleoperationDecision> {
    const person = this.people.get(personId);
    if (!person) {
      const reason = `Teleoperation refused: no registered person ${personId}.`;
      this.audit.append({
        actor: `teleop:${personId}`,
        action: `teleop.${intent.type}`,
        reason,
        execution: "refused",
        data: { intent },
      });
      return { ok: false, reason };
    }

    const role = person.role;
    if (role === "unknown" || !roleCanTeleoperate(role, intent)) {
      const reason = `Teleoperation refused for ${person.name}: role ${role} is not authorized for ${intent.type}.`;
      this.audit.append({
        actor: `teleop:${person.id}`,
        action: `teleop.${intent.type}`,
        reason,
        execution: "refused",
        data: { intent, role },
      });
      return { ok: false, reason, role };
    }

    const source = `teleop:${person.id}`;
    this.audit.append({
      actor: source,
      action: `teleop.${intent.type}`,
      reason: `Human teleoperation requested by ${person.name} (${role}).`,
      execution: "recorded",
      data: { intent, role },
    });

    const result = await this.body.request(intent, {
      requestedBy: source,
      ...(signal ? { signal } : {}),
    });
    return { ok: true, role, result };
  }
}
