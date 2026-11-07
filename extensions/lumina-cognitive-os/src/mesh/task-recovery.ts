/**
 * task-recovery.ts — The typed adapter over Postgres-owned task fencing.
 *
 * ## Owner
 *
 * Postgres owns task ownership, leases and the fence token; this module owns
 * nothing durable. It calls the `lumina_*` RPCs that already exist in the
 * Lumina_IA project over PostgREST, validates each reply once, and reports a
 * typed outcome. It deliberately reimplements none of it: `lumina_claim_task`
 * already does the `FOR UPDATE SKIP LOCKED` claim, and the
 * `trg_lumina_tasks_fence` trigger already bumps `fence_token` whenever
 * `claimed_by` changes. A second implementation here would be a second owner of
 * the same decision.
 *
 * ## The invariant this adapter exists to hold
 *
 * `lumina_finish_task`, `lumina_start_task`, `lumina_fail_task` and
 * `lumina_heartbeat_task` accept no fence token: they filter on
 * `status in ('claimed','running') AND claimed_by = p_agent_key`. The owner is
 * the *agent key*, which every attempt of the same agent shares, so a stale
 * worker satisfies a newer attempt's filter and overwrites live work:
 *
 *   1. the agent claims T                                 -> fence 1
 *   2. the gateway hangs; the lease expires
 *   3. `lumina_requeue_expired_tasks` clears `claimed_by`  -> fence 2
 *   4. the same agent re-claims T                          -> fence 3
 *   5. the original worker wakes, calls `lumina_finish_task`, and marks the
 *      *live* attempt 'completed' carrying the dead attempt's result.
 *
 * **Therefore this adapter writes a task outcome only through
 * `lumina_finish_task_fenced`, never through `lumina_finish_task` or
 * `lumina_fail_task`.** That is the reason the module exists, so it is stated
 * here as the adapter's invariant rather than left to each caller to remember.
 * Adding `p_fence_token` to those four functions is DDL, so it stays Dal's call
 * and is reported as blocked instead of worked around.
 *
 * `heartbeat` is the mitigation available without DDL: the unfenced RPC returns
 * the task row, so this adapter compares that row's `fence_token` against the
 * caller's claim and reports a superseded attempt. The renewal has landed by
 * then, which is harmless — it extends the *live* attempt's lease and nothing
 * else.
 *
 * ## Service health is not task continuity
 *
 * `assessContinuity` exists because the two get conflated in both directions: an
 * unreachable gateway is read as a lost task, and a browser at `about:blank` is
 * read as a dead gateway. Only the lease row decides ownership, so the verdict
 * carries `taskLostByServiceOutage: false` as a literal type — no caller can
 * compile the opposite claim.
 *
 * ## Uncertain writes
 *
 * A request that times out or aborts without a reply has an *unknown* outcome,
 * and an unknown write outcome never authorizes a replay
 * (`docs/reference/database-schemas.md`). Those return
 * `reason: "outcome-unknown"`: the holder reads the row back and reconciles,
 * never retries blindly. Only a failure that provably never reached the server
 * is reported as a plain, retryable transport failure.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { StateStorePort } from "../shared/state-store.js";
import {
  readSupabaseJson,
  supabaseFetch,
  type SupabaseConfig,
} from "../supabase/supabase-client.js";
import { isMeshParty, type MeshParty } from "./envelope.js";

/** The statuses `lumina_finish_task_fenced` accepts; others yield INVALID_STATUS. */
export const TASK_FINISH_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "input_required",
  "auth_required",
] as const);

export type TaskFinishStatus = (typeof TASK_FINISH_STATUSES)[number];

/** What a recovering holder may do with an interrupted attempt. */
export type TaskRecoveryPolicy = "resume" | "retry" | "manual" | "abort";

/** Whether resuming can duplicate an effect the outside world already saw. */
export type ExternalEffectKind = "none" | "idempotent" | "non-idempotent";

/** The causal trail behind an attempt, from real `lumina_tasks` columns. */
export type TaskCausalEvidence = {
  readonly attempt_count: number;
  readonly recovery_count: number;
  readonly parent_task_id?: string;
  readonly origin_memory_id?: string;
  readonly validation_status: string;
  /** The last recorded failure text, never a payload. */
  readonly last_error?: string;
};

/**
 * The Task Recovery Contract, minus the policy, as held by whoever owns the
 * attempt right now.
 *
 * Column mapping, because several contract fields have no column and adding one
 * is DDL: `fencing_token` is `fence_token`, `owner` is `claimed_by`,
 * `side_effect_idempotency_key` is `idempotency_key`, `authorization_ref` is
 * `decision_ref`, and `attempt_id` is derived as `<task id>#<attempt_count>` so
 * an attempt is nameable without a new column. `goal_id` and `deadline` come
 * from `payload`; `checkpoint_ref` and `last_verified_step` from `result`.
 * Nothing writes those four keys yet, so they are optional by design.
 */
export type TaskClaim = {
  readonly task_id: string;
  readonly goal_id?: string;
  readonly attempt_id: string;
  readonly owner: MeshParty;
  readonly fencing_token: number;
  readonly lease_expires_at?: string;
  readonly checkpoint_ref?: string;
  readonly last_verified_step?: string;
  readonly side_effect_idempotency_key?: string;
  readonly authorization_ref?: string;
  readonly deadline?: string;
  readonly updated_at: string;
  readonly intent: string;
  readonly status: string;
  readonly evidence: TaskCausalEvidence;
};

/** A claim plus the decision about it: the full contract from the order. */
export type TaskRecoveryContract = TaskClaim & {
  readonly recovery_policy: TaskRecoveryPolicy;
};

/** The one failure shape every operation here reports: a reason and a detail. */
type Failure<R extends string> = {
  readonly ok: false;
  readonly reason: R;
  readonly detail: string;
};

/**
 * `outcome-unknown` means a claim may be held without a usable handle: the lease
 * expires on its own and `lumina_claim_task` requeues it, so the caller waits
 * instead of claiming again.
 */
export type ClaimTaskResult =
  | { readonly ok: true; readonly claim: TaskClaim }
  | Failure<"none-available" | "unknown-agent" | "transport" | "outcome-unknown">;

/**
 * `lease-lost`: the row is no longer claimed by this agent at all.
 * `fence-superseded`: the agent key still matches but the fence moved, so a
 * newer attempt of this same agent owns the task and this one must stop.
 */
export type HeartbeatResult =
  | { readonly ok: true; readonly lease_expires_at?: string; readonly fencing_token: number }
  | (Failure<"lease-lost" | "fence-superseded" | "transport" | "outcome-unknown"> & {
      readonly currentToken?: number;
    });

export type FenceCheckResult =
  | { readonly ok: true; readonly held: boolean }
  | Failure<"transport" | "outcome-unknown">;

export type FinishTaskResult =
  | { readonly ok: true; readonly status: TaskFinishStatus; readonly message: string }
  | (Failure<"fencing-rejected"> & {
      readonly staleToken: number;
      readonly currentToken?: number;
    })
  | (Failure<"not-owner"> & { readonly currentOwner?: string })
  | Failure<"unclaimed" | "invalid-status" | "transport" | "outcome-unknown">;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_SECONDS = 300;
const DETAIL_MAX_CHARS = 300;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function clamp(detail: string): string {
  return detail.replace(/\s+/gu, " ").trim().slice(0, DETAIL_MAX_CHARS);
}

function seconds(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : DEFAULT_LEASE_SECONDS;
}

/**
 * Validates one `lumina_tasks` row into a claim. This is the module's trust
 * boundary: callers receive a `TaskClaim` and never re-check it.
 */
export function parseClaimedTask(value: unknown): TaskClaim | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const taskId = text(value.id);
  const owner = value.claimed_by;
  const fencingToken = whole(value.fence_token);
  const updatedAt = text(value.updated_at);
  const intent = text(value.intent);
  const status = text(value.status);
  if (!taskId || !isMeshParty(owner) || fencingToken === undefined) {
    return undefined;
  }
  if (!updatedAt || !intent || !status) {
    return undefined;
  }
  const attemptCount = whole(value.attempt_count) ?? 0;
  const payload = isRecord(value.payload) ? value.payload : {};
  const result = isRecord(value.result) ? value.result : {};
  const lastError = text(value.error);
  return {
    task_id: taskId,
    attempt_id: `${taskId}#${attemptCount}`,
    owner,
    fencing_token: fencingToken,
    updated_at: updatedAt,
    intent,
    status,
    goal_id: text(payload.goal_id),
    lease_expires_at: text(value.lease_until),
    checkpoint_ref: text(result.checkpoint_ref) ?? text(payload.checkpoint_ref),
    last_verified_step: text(result.last_verified_step) ?? text(payload.last_verified_step),
    side_effect_idempotency_key: text(value.idempotency_key),
    authorization_ref: text(value.decision_ref),
    deadline: text(payload.deadline),
    evidence: {
      attempt_count: attemptCount,
      recovery_count: whole(value.recovery_count) ?? 0,
      validation_status: text(value.validation_status) ?? "unvalidated",
      parent_task_id: text(value.parent_task_id),
      origin_memory_id: text(value.origin_memory_id),
      last_error: lastError === undefined ? undefined : clamp(lastError),
    },
  };
}

/**
 * What one RPC call produced. `unknown` and `no-effect` are kept apart because
 * only `no-effect` — a failure that provably never reached the server — may be
 * retried without reconciling first.
 */
type RpcOutcome =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "error"; readonly status: number; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string }
  | { readonly kind: "no-effect"; readonly message: string };

/** Pulls PostgREST's `message` out of an error body, or keeps the raw text. */
function postgrestMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return clamp(parsed.message);
    }
  } catch {
    // Not JSON: PostgREST and the proxies in front of it both emit plain text.
  }
  return clamp(raw);
}

/**
 * Classifies a thrown fetch. An abort or timeout is uncertain by definition. A
 * connection that was never established is the only case treated as having had
 * no effect; everything else stays uncertain on purpose.
 */
function classifyThrow(error: unknown): RpcOutcome {
  const name = error instanceof Error ? error.name : "";
  const message = clamp(error instanceof Error ? error.message : String(error));
  if (name === "AbortError" || name === "TimeoutError") {
    return { kind: "unknown", message: message || "request aborted before a reply" };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL/u.test(message)) {
    return { kind: "no-effect", message };
  }
  return { kind: "unknown", message };
}

export type TaskRecoveryOptions = {
  readonly config: SupabaseConfig;
  /** Per-request timeout handed to `supabaseFetch`. */
  readonly timeoutMs?: number;
  /**
   * Optional restart hint, not a second source of truth. A successful claim is
   * registered and a successful finish removes it, so a process that comes back
   * after a crash can list what it was working on and reconcile. Postgres stays
   * authoritative: a stale hint is harmless because every write is fenced.
   */
  readonly claims?: StateStorePort<TaskClaim>;
};

/**
 * The adapter. One instance per Supabase configuration; it holds no task state
 * of its own, so a method's result is the only thing a caller must keep.
 *
 * No clock is injected because none is needed: Postgres stamps the lease, and
 * the pure decision functions below take `nowMs` from the caller.
 */
export class TaskRecovery {
  private readonly config: SupabaseConfig;
  private readonly timeoutMs: number;
  private readonly claims: StateStorePort<TaskClaim> | undefined;

  constructor(options: TaskRecoveryOptions) {
    this.config = options.config;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.claims = options.claims;
  }

  private async rpc(name: string, params: Record<string, unknown>): Promise<RpcOutcome> {
    let response: Response;
    try {
      response = await supabaseFetch(this.config, `/rest/v1/rpc/${name}`, {
        method: "POST",
        body: JSON.stringify(params),
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      return classifyThrow(error);
    }
    const json = await readSupabaseJson<unknown>(response);
    if (json.ok) {
      return { kind: "ok", body: json.data };
    }
    // A 2xx whose body will not parse still ran the function: the write landed
    // and only the reply is lost, so this is uncertain rather than retryable.
    if (response.ok) {
      return { kind: "unknown", message: clamp(json.error) };
    }
    return { kind: "error", status: json.status, message: postgrestMessage(json.error) };
  }

  /** Claims this process was holding when it stopped, for reconciliation. */
  async heldClaims(): Promise<readonly TaskClaim[]> {
    const rows = (await this.claims?.entries()) ?? [];
    return rows.map((row) => row.value);
  }

  /**
   * Claims the next task for `agentKey`. Priority order, the [60, 3600] s lease
   * clamp, attempt counting, requeue of expired leases and rescue of transient
   * failures all happen inside `lumina_claim_task`; this does not repeat them.
   */
  async claimNextTask(agentKey: MeshParty, leaseSeconds: number): Promise<ClaimTaskResult> {
    if (!isMeshParty(agentKey)) {
      return {
        ok: false,
        reason: "unknown-agent",
        detail: `"${clamp(String(agentKey))}" is not a valid agent key`,
      };
    }
    const outcome = await this.rpc("lumina_claim_task", {
      p_agent_key: agentKey,
      p_lease_seconds: seconds(leaseSeconds),
    });
    switch (outcome.kind) {
      case "no-effect":
        return { ok: false, reason: "transport", detail: outcome.message };
      case "unknown":
        return {
          ok: false,
          reason: "outcome-unknown",
          detail: `a claim may have been granted without a reply: ${outcome.message}`,
        };
      case "error":
        return /unknown or inactive agent/iu.test(outcome.message)
          ? { ok: false, reason: "unknown-agent", detail: outcome.message }
          : {
              ok: false,
              reason: "transport",
              detail: `HTTP ${outcome.status}: ${outcome.message}`,
            };
      case "ok": {
        const rows = Array.isArray(outcome.body) ? outcome.body : [outcome.body];
        const row = rows[0];
        if (row === undefined || row === null) {
          return { ok: false, reason: "none-available", detail: "no claimable task" };
        }
        const claim = parseClaimedTask(row);
        if (!claim) {
          // The claim did land: the row is ours and the attempt counter moved.
          // Calling this retryable would claim a second time.
          return {
            ok: false,
            reason: "outcome-unknown",
            detail: "a task was claimed but its row did not match lumina_tasks",
          };
        }
        await this.claims?.register(claim.attempt_id, claim);
        return { ok: true, claim };
      }
    }
  }

  /**
   * The pre-write holder check, `lumina_fence_ok`. Cheap enough to run right
   * before an attempt's first side effect; it proves nothing about the moment of
   * the write, which is why `finishFenced` re-checks inside Postgres.
   */
  async checkFence(claim: Pick<TaskClaim, "task_id" | "fencing_token">): Promise<FenceCheckResult> {
    const outcome = await this.rpc("lumina_fence_ok", {
      p_task_id: claim.task_id,
      p_fence_token: claim.fencing_token,
    });
    switch (outcome.kind) {
      case "ok":
        return typeof outcome.body === "boolean"
          ? { ok: true, held: outcome.body }
          : { ok: false, reason: "transport", detail: "lumina_fence_ok returned no boolean" };
      case "no-effect":
        return { ok: false, reason: "transport", detail: outcome.message };
      case "unknown":
        return { ok: false, reason: "outcome-unknown", detail: outcome.message };
      case "error":
        return {
          ok: false,
          reason: "transport",
          detail: `HTTP ${outcome.status}: ${outcome.message}`,
        };
    }
  }

  /**
   * Renews the lease and reports whether the claim still owns it.
   *
   * `lumina_heartbeat_task` takes no fence token, so it cannot refuse a stale
   * worker. It does return the row, so the live `fence_token` is compared here
   * and a superseded attempt is told to stop.
   */
  async heartbeat(
    claim: Pick<TaskClaim, "task_id" | "owner" | "fencing_token">,
    leaseSeconds: number,
  ): Promise<HeartbeatResult> {
    const outcome = await this.rpc("lumina_heartbeat_task", {
      p_task_id: claim.task_id,
      p_agent_key: claim.owner,
      p_lease_seconds: seconds(leaseSeconds),
    });
    switch (outcome.kind) {
      case "no-effect":
        return { ok: false, reason: "transport", detail: outcome.message };
      case "unknown":
        return { ok: false, reason: "outcome-unknown", detail: outcome.message };
      case "error":
        return /not owned by agent/iu.test(outcome.message)
          ? { ok: false, reason: "lease-lost", detail: outcome.message }
          : {
              ok: false,
              reason: "transport",
              detail: `HTTP ${outcome.status}: ${outcome.message}`,
            };
      case "ok": {
        const renewed = parseClaimedTask(
          Array.isArray(outcome.body) ? outcome.body[0] : outcome.body,
        );
        if (!renewed) {
          return {
            ok: false,
            reason: "outcome-unknown",
            detail: "the lease was renewed but the returned row did not match lumina_tasks",
          };
        }
        if (renewed.fencing_token !== claim.fencing_token) {
          return {
            ok: false,
            reason: "fence-superseded",
            currentToken: renewed.fencing_token,
            detail: `this attempt holds fence ${claim.fencing_token} but the live fence is ${renewed.fencing_token}`,
          };
        }
        return {
          ok: true,
          fencing_token: renewed.fencing_token,
          lease_expires_at: renewed.lease_expires_at,
        };
      }
    }
  }

  /**
   * Writes the terminal outcome through `lumina_finish_task_fenced` — the only
   * finishing RPC this adapter may call (see the module header).
   *
   * The RPC reports a refusal as a 200 carrying `ok: false` and a message rather
   * than by raising, so the message is classified for both shapes: a `false` row
   * and a PostgREST error body.
   */
  async finishFenced(
    claim: Pick<TaskClaim, "task_id" | "owner" | "fencing_token" | "attempt_id">,
    status: TaskFinishStatus,
    result: Record<string, unknown> | null,
    evidence: Record<string, unknown> | readonly unknown[] | null,
  ): Promise<FinishTaskResult> {
    const outcome = await this.rpc("lumina_finish_task_fenced", {
      p_task_id: claim.task_id,
      p_agent: claim.owner,
      p_fence_token: claim.fencing_token,
      p_status: status,
      p_result: result,
      p_evidence: evidence,
    });
    switch (outcome.kind) {
      case "no-effect":
        return { ok: false, reason: "transport", detail: outcome.message };
      case "unknown":
        return {
          ok: false,
          reason: "outcome-unknown",
          detail: `the finish may have been applied: ${outcome.message}`,
        };
      case "error":
        return (
          classifyFenceMessage(outcome.message, claim.fencing_token) ?? {
            ok: false,
            reason: "transport",
            detail: `HTTP ${outcome.status}: ${outcome.message}`,
          }
        );
      case "ok": {
        const row = Array.isArray(outcome.body) ? outcome.body[0] : outcome.body;
        if (!isRecord(row) || typeof row.ok !== "boolean") {
          return {
            ok: false,
            reason: "outcome-unknown",
            detail: "lumina_finish_task_fenced returned an unreadable row",
          };
        }
        const message = clamp(typeof row.message === "string" ? row.message : "");
        if (row.ok) {
          // Settled in Postgres: the restart hint has nothing left to recover.
          await this.claims?.delete(claim.attempt_id);
          return { ok: true, status, message };
        }
        return (
          classifyFenceMessage(message, claim.fencing_token) ?? {
            ok: false,
            reason: "transport",
            detail: message || "lumina_finish_task_fenced refused without a message",
          }
        );
      }
    }
  }
}

const STALE_FENCE_RE = /FENCING_REJECTED: token (\d+) is stale, current fence token is (-?\d+)/u;

/**
 * Maps one `lumina_finish_task_fenced` refusal message to a typed result.
 *
 * One classifier serves both the `ok: false` row and a PostgREST error body, so
 * a refusal's wire shape is decided in a single place. `sentToken` is the
 * fallback for `FENCING_REJECTED_AT_UPDATE`, which names no token because the
 * row moved between the `SELECT ... FOR UPDATE` and the guarded `UPDATE`.
 */
export function classifyFenceMessage(
  message: string,
  sentToken: number,
): FinishTaskResult | undefined {
  const stale = STALE_FENCE_RE.exec(message);
  if (stale?.[1] !== undefined && stale[2] !== undefined) {
    return {
      ok: false,
      reason: "fencing-rejected",
      staleToken: Number(stale[1]),
      currentToken: Number(stale[2]),
      detail: clamp(message),
    };
  }
  if (message.includes("FENCING_REJECTED")) {
    return { ok: false, reason: "fencing-rejected", staleToken: sentToken, detail: clamp(message) };
  }
  if (message.includes("NOT_OWNER")) {
    const owner = /task belongs to (.+)$/u.exec(message)?.[1];
    return {
      ok: false,
      reason: "not-owner",
      currentOwner: owner === undefined ? undefined : clamp(owner),
      detail: clamp(message),
    };
  }
  if (message.includes("TASK_NOT_FOUND_OR_UNCLAIMED")) {
    return { ok: false, reason: "unclaimed", detail: clamp(message) };
  }
  if (message.includes("INVALID_STATUS")) {
    return { ok: false, reason: "invalid-status", detail: clamp(message) };
  }
  return undefined;
}

export type RecoverInterruptedInput = {
  readonly nowMs: number;
  readonly externalEffect: ExternalEffectKind;
  readonly checkpointRef?: string;
  readonly lastVerifiedStep?: string;
  readonly sideEffectIdempotencyKey?: string;
  readonly deadlineMs?: number;
  readonly authorizationExpiresAtMs?: number;
  readonly authorizationRevoked?: boolean;
  /** `unknown` when the attempt's last write timed out without a reply. */
  readonly lastWriteOutcome?: "known" | "unknown";
};

export type RecoveryDecision = {
  readonly recovery_policy: TaskRecoveryPolicy;
  readonly reason: string;
  /** True when a holder must reconcile an effect before anything runs again. */
  readonly requiresReconciliation: boolean;
};

/**
 * Decides what may happen to an interrupted attempt. Pure: no clock, no I/O.
 *
 * Precedence, highest first, and why it is this order:
 *
 *  1. A non-idempotent external effect is always `manual`. The order is
 *     unconditional about it ("Tareas con efecto externo no idempotente quedan
 *     en manual"), so it outranks a valid checkpoint and an expired deadline
 *     alike: aborting would strand a half-applied effect with nobody told.
 *  2. An unknown last write outcome is `manual` unless an idempotency key
 *     exists, because the key — not the retry — is what collapses a replay into
 *     one effect. This is the repository's rule that an unknown write outcome
 *     never authorizes replay.
 *  3. An expired deadline, or an expired or revoked authorization, is `abort`.
 *  4. A checkpoint *and* a last verified step make `resume` possible. One
 *     without the other does not: a checkpoint nobody verified is not a safe
 *     place to restart from.
 *  5. Otherwise `retry`, which is safe with no external effect or with a keyed
 *     idempotent one. An idempotent effect with no key is `manual`, since
 *     nothing would collapse the second one.
 */
export function recoverInterrupted(input: RecoverInterruptedInput): RecoveryDecision {
  const decide = (
    recovery_policy: TaskRecoveryPolicy,
    reason: string,
    requiresReconciliation = false,
  ): RecoveryDecision => ({ recovery_policy, reason, requiresReconciliation });
  const key = input.sideEffectIdempotencyKey;

  if (input.externalEffect === "non-idempotent") {
    return decide(
      "manual",
      "the external effect is not idempotent, so only a human may decide",
      true,
    );
  }
  if (input.lastWriteOutcome === "unknown") {
    return key === undefined
      ? decide(
          "manual",
          "the last write outcome is unknown and no idempotency key collapses a replay",
          true,
        )
      : decide("retry", `the last write outcome is unknown but ${key} keeps the effect single`);
  }
  if (input.authorizationRevoked === true) {
    return decide("abort", "the authorization was revoked");
  }
  if (
    input.authorizationExpiresAtMs !== undefined &&
    input.authorizationExpiresAtMs <= input.nowMs
  ) {
    return decide("abort", "the authorization expired");
  }
  if (input.deadlineMs !== undefined && input.deadlineMs <= input.nowMs) {
    return decide("abort", "the deadline passed");
  }
  if (input.checkpointRef !== undefined && input.lastVerifiedStep !== undefined) {
    return decide("resume", `resuming from ${input.checkpointRef} after ${input.lastVerifiedStep}`);
  }
  if (input.externalEffect === "none") {
    return decide("retry", "no external effect, so a fresh attempt cannot duplicate anything");
  }
  return key === undefined
    ? decide("manual", "the effect is idempotent in principle but carries no idempotency key", true)
    : decide("retry", `the effect is keyed by ${key}`);
}

/** The situation a claim is recovered in; everything else comes from the claim. */
export type RecoverySituation = {
  readonly nowMs: number;
  readonly externalEffect: ExternalEffectKind;
  readonly authorizationExpiresAtMs?: number;
  readonly authorizationRevoked?: boolean;
  readonly lastWriteOutcome?: "known" | "unknown";
};

/** What a claim plus a situation allows, as the full Task Recovery Contract. */
export function planRecovery(
  claim: TaskClaim,
  situation: RecoverySituation,
): { readonly contract: TaskRecoveryContract; readonly decision: RecoveryDecision } {
  const parsedDeadline = claim.deadline === undefined ? Number.NaN : Date.parse(claim.deadline);
  const decision = recoverInterrupted({
    nowMs: situation.nowMs,
    externalEffect: situation.externalEffect,
    checkpointRef: claim.checkpoint_ref,
    lastVerifiedStep: claim.last_verified_step,
    sideEffectIdempotencyKey: claim.side_effect_idempotency_key,
    deadlineMs: Number.isNaN(parsedDeadline) ? undefined : parsedDeadline,
    authorizationExpiresAtMs: situation.authorizationExpiresAtMs,
    authorizationRevoked: situation.authorizationRevoked,
    lastWriteOutcome: situation.lastWriteOutcome,
  });
  return { contract: { ...claim, recovery_policy: decision.recovery_policy }, decision };
}

/** What the host observed about the *services*, never about the task. */
export type ServiceSignal = {
  readonly gatewayReachable: boolean;
  /** The automation browser's current URL, when there is one. */
  readonly browserUrl?: string;
  readonly configReloadedAtMs?: number;
  readonly sessionOwnerChanged?: boolean;
};

/** What `lumina_tasks` says about ownership, which is the only thing that does. */
export type LeaseSignal = {
  readonly nowMs: number;
  readonly owner: MeshParty;
  readonly fencingToken: number;
  readonly leaseExpiresAtMs?: number;
};

export type ContinuityVerdict = {
  readonly service: "healthy" | "unreachable" | "degraded";
  readonly taskContinuity: "owned" | "lease-expired" | "unknown";
  /**
   * A literal `false`: no caller can compile a claim that a service outage lost
   * a task. Ownership is decided by the lease row, never by process health.
   */
  readonly taskLostByServiceOutage: false;
  readonly degraded: readonly string[];
  readonly reason: string;
};

/** URLs that mean "this browser shows nothing", not "the host is down". */
const BLANK_BROWSER_URLS: ReadonlySet<string> = new Set(["", "about:blank", "about:newtab"]);

/**
 * Separates service health from task continuity, which the order insists on
 * because the two get conflated in both directions.
 */
export function assessContinuity(service: ServiceSignal, lease: LeaseSignal): ContinuityVerdict {
  const degraded: string[] = [];
  const held = `${lease.owner}#${lease.fencingToken}`;
  const reasons: string[] = [];
  if (!service.gatewayReachable) {
    reasons.push(
      `the gateway is unreachable, which is a service outage: ${held} keeps the task while its lease holds`,
    );
  }
  if (service.browserUrl !== undefined && BLANK_BROWSER_URLS.has(service.browserUrl)) {
    degraded.push("browser-blank");
    reasons.push("the browser is blank, which is a degraded session and not a gateway outage");
  }
  if (service.sessionOwnerChanged === true) {
    degraded.push("session-owner-changed");
    reasons.push("the session owner changed, so the fence decides who may write");
  }
  if (service.configReloadedAtMs !== undefined) {
    degraded.push("config-reloaded");
    reasons.push("config was reloaded, which restarts workers and not tasks");
  }
  const taskContinuity =
    lease.leaseExpiresAtMs === undefined
      ? "unknown"
      : lease.leaseExpiresAtMs <= lease.nowMs
        ? "lease-expired"
        : "owned";
  if (taskContinuity === "lease-expired") {
    reasons.push(`the lease of ${held} expired, so the task is requeued, not lost`);
  }
  if (taskContinuity === "unknown") {
    reasons.push(`no lease deadline is known for ${held}, so ownership must be read back`);
  }
  return {
    service: !service.gatewayReachable
      ? "unreachable"
      : degraded.length > 0
        ? "degraded"
        : "healthy",
    taskContinuity,
    taskLostByServiceOutage: false,
    degraded,
    reason: reasons.length > 0 ? reasons.join("; ") : `${held} holds a live lease`,
  };
}
