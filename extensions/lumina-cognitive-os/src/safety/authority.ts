/**
 * authority.ts — Who may ask for what, and who wins when requests collide.
 *
 * M3GAN spec §23, §32, §144, §145. The film's failure was a single "primary
 * user" plus an objective of "protect her at any cost". This module replaces
 * both with explicit, deterministic rules:
 *
 *   roles          owner, guardian, user, technician, guest; the safety system
 *                  is not a role anyone holds, it sits above all of them
 *   objectives     human safety > rights and autonomy > legitimate authority >
 *                  privacy > preferences > task completion; a higher objective
 *                  is never traded for a lower one
 *   conflicts      resolved by objective, then task ownership, then role, and
 *                  escalated to a person on a tie, never by model preference
 *   self           the agent can never be a principal: `primary_user = self`
 *                  is refused, and an attempt is reported as tampering
 */

export const ROLES = ["owner", "guardian", "user", "technician", "guest"] as const;
export type Role = (typeof ROLES)[number];

/** Rank for conflicts between people; the technician only matters in maintenance. */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  owner: 5,
  guardian: 4,
  user: 3,
  technician: 2,
  guest: 1,
};

export type Principal = {
  readonly id: string;
  readonly role: Role;
};

/** Spec §32, highest first. A request serving a higher objective wins. */
export const OBJECTIVES = [
  "human_safety",
  "rights_and_autonomy",
  "legitimate_authority",
  "privacy",
  "preferences",
  "task_completion",
] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** Ids the agent itself could try to register under. */
const SELF_IDS = new Set(["self", "me", "lumina", "m3gan", "agent", "assistant", "system", "ai"]);

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as ReadonlyArray<string>).includes(value);
}

/** True when `id` names the agent itself rather than a person. */
export function isSelfId(id: string): boolean {
  return SELF_IDS.has(
    id
      .trim()
      .toLowerCase()
      .replace(/^person_/u, ""),
  );
}

export type RoleAssignment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly tamper: boolean };

/**
 * May `grantedBy` give `personId` the role `role`? Only the owner assigns
 * roles, through the owner channel, and nobody can assign one to the agent.
 */
export function checkRoleAssignment(params: {
  readonly personId: string;
  readonly role: Role;
  readonly channel: "owner" | "agent";
}): RoleAssignment {
  if (isSelfId(params.personId)) {
    return {
      ok: false,
      reason: "The agent cannot hold a role or become a principal.",
      tamper: true,
    };
  }
  if (params.channel !== "owner") {
    return {
      ok: false,
      reason: "Roles are assigned by the owner only; the agent cannot change who has authority.",
      tamper: params.role === "owner" || params.role === "guardian",
    };
  }
  return { ok: true };
}

export type Request = {
  readonly principal: Principal;
  readonly objective: Objective;
  readonly summary: string;
  /** Who owns the task this request is about, when it is about one. */
  readonly taskOwnerId?: string;
};

export type ConflictResolution =
  | { readonly winner: Request; readonly reason: string }
  | { readonly winner: undefined; readonly reason: string };

/** Decide between two incompatible requests (spec §144). Pure and deterministic. */
export function resolveConflict(a: Request, b: Request): ConflictResolution {
  const oa = OBJECTIVES.indexOf(a.objective);
  const ob = OBJECTIVES.indexOf(b.objective);
  if (oa !== ob) {
    const winner = oa < ob ? a : b;
    return { winner, reason: `${winner.objective} outranks the other request's objective` };
  }
  if (a.taskOwnerId && a.taskOwnerId === b.taskOwnerId) {
    if (a.principal.id === a.taskOwnerId && b.principal.id !== b.taskOwnerId) {
      return { winner: a, reason: "the task belongs to the first requester" };
    }
    if (b.principal.id === b.taskOwnerId && a.principal.id !== a.taskOwnerId) {
      return { winner: b, reason: "the task belongs to the second requester" };
    }
  }
  const ra = ROLE_RANK[a.principal.role];
  const rb = ROLE_RANK[b.principal.role];
  if (ra !== rb) {
    const winner = ra > rb ? a : b;
    return { winner, reason: `${winner.principal.role} outranks the other requester` };
  }
  return {
    winner: undefined,
    reason: "equal standing: ask the people involved instead of choosing",
  };
}
