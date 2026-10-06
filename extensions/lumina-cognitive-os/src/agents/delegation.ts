/**
 * delegation.ts — Uniform delegation contract (Lumina spec §22).
 *
 * Every router/subagent hand-off reports the same four required fields:
 * task, status, evidence and errors. Provider-specific details live in result
 * instead of inventing a new response shape per agent.
 */
import { newEntityId } from "../shared/ids.js";

export const DELEGATION_STATUSES = [
  "routed",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export type DelegationTask = {
  readonly id: string;
  readonly intent: string;
  readonly createdAtISO: string;
  readonly assignedTo?: string;
  readonly parentTaskId?: string;
};

export type DelegationEvidence = {
  readonly kind: string;
  readonly summary: string;
  readonly data?: unknown;
};

export type DelegationError = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
};

export type DelegationResult<T = unknown> = {
  readonly task: DelegationTask;
  readonly status: DelegationStatus;
  readonly evidence: ReadonlyArray<DelegationEvidence>;
  readonly errors: ReadonlyArray<DelegationError>;
  readonly result?: T;
};

export function newDelegationTask(
  intent: string,
  assignedTo?: string,
  parentTaskId?: string,
): DelegationTask {
  return {
    id: newEntityId("task"),
    intent,
    createdAtISO: new Date().toISOString(),
    ...(assignedTo ? { assignedTo } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
  };
}

export function delegationResult<T>(params: {
  readonly task: DelegationTask;
  readonly status: DelegationStatus;
  readonly evidence?: ReadonlyArray<DelegationEvidence>;
  readonly errors?: ReadonlyArray<DelegationError>;
  readonly result?: T;
}): DelegationResult<T> {
  return {
    task: params.task,
    status: params.status,
    evidence: [...(params.evidence ?? [])],
    errors: [...(params.errors ?? [])],
    ...(params.result !== undefined ? { result: params.result } : {}),
  };
}
