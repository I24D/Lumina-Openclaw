/**
 * Tests for the task recovery adapter — the TypeScript half of TEST M2.
 *
 * The fencing itself lives in Postgres and is not reimplemented here, so these
 * tests prove the adapter's own contracts: that it reads a `lumina_tasks` row
 * correctly, that it classifies every refusal `lumina_finish_task_fenced` can
 * produce, that an uncertain write is reported as uncertain rather than
 * retryable, and — the mitigation this module exists for — that it never calls
 * an unfenced closing RPC.
 *
 * No network: the global `fetch` is stubbed, so every assertion is about the
 * request this adapter would send and the reply it would read back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import type { SupabaseConfig } from "../supabase/supabase-client.js";
import {
  assessContinuity,
  classifyFenceMessage,
  parseClaimedTask,
  planRecovery,
  recoverInterrupted,
  TaskRecovery,
  type TaskClaim,
} from "./task-recovery.js";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const TASK_ID = "11111111-2222-3333-4444-555555555555";

const CONFIG: SupabaseConfig = {
  url: "https://example.supabase.co",
  // Synthetic: no real credential ever appears in a fixture.
  key: "test-key-not-a-credential",
  keySource: "SUPABASE_SERVICE_ROLE_KEY",
  schema: "public",
  maxRows: 100,
  allowWrites: true,
};

/** A full `lumina_tasks` row as the RPCs return it. */
function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    claimed_by: "openclaw-gateway",
    fence_token: 3,
    updated_at: "2026-10-31T12:00:00.000Z",
    intent: "deliver the mesh report",
    status: "claimed",
    attempt_count: 2,
    recovery_count: 1,
    validation_status: "unvalidated",
    lease_until: "2026-10-31T12:05:00.000Z",
    idempotency_key: "imk_side_effect",
    decision_ref: "authz_dal_0001",
    payload: { goal_id: "goal_mesh", deadline: "2026-11-01T00:00:00.000Z" },
    result: { checkpoint_ref: "ckpt_7", last_verified_step: "step_3" },
    error: "  a   previous  failure ",
    ...overrides,
  };
}

type Reply =
  | { readonly json: unknown; readonly status?: number }
  | { readonly text: string; readonly status: number }
  | { readonly throws: Error };

/** Stubs global fetch with a queue of replies and records every request. */
function stubFetch(replies: readonly Reply[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, method: init?.method ?? "GET", body });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) {
      throw new Error("no reply queued");
    }
    if ("throws" in reply) {
      throw reply.throws;
    }
    if ("text" in reply) {
      return new Response(reply.text, { status: reply.status });
    }
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    calls,
    /** The RPC names called, in order. */
    rpcs: () => calls.map((call) => call.url.replace(/^.*\/rest\/v1\/rpc\//u, "")),
  };
}

function adapter(claims?: MemoryStateStore<TaskClaim>) {
  return new TaskRecovery({ config: CONFIG, ...(claims === undefined ? {} : { claims }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseClaimedTask", () => {
  it("maps every contract field onto the columns that exist", () => {
    const claim = parseClaimedTask(taskRow());
    expect(claim).toBeDefined();
    if (!claim) {
      return;
    }
    expect(claim.task_id).toBe(TASK_ID);
    // No column names an attempt, so it is derived and still unique per attempt.
    expect(claim.attempt_id).toBe(`${TASK_ID}#2`);
    expect(claim.owner).toBe("openclaw-gateway");
    expect(claim.fencing_token).toBe(3);
    expect(claim.goal_id).toBe("goal_mesh");
    expect(claim.deadline).toBe("2026-11-01T00:00:00.000Z");
    expect(claim.checkpoint_ref).toBe("ckpt_7");
    expect(claim.last_verified_step).toBe("step_3");
    expect(claim.side_effect_idempotency_key).toBe("imk_side_effect");
    expect(claim.authorization_ref).toBe("authz_dal_0001");
    expect(claim.lease_expires_at).toBe("2026-10-31T12:05:00.000Z");
    expect(claim.evidence).toEqual({
      attempt_count: 2,
      recovery_count: 1,
      validation_status: "unvalidated",
      parent_task_id: undefined,
      origin_memory_id: undefined,
      last_error: "a previous failure",
    });
  });

  it("refuses a row that cannot name its holder or its fence", () => {
    expect(parseClaimedTask(taskRow({ id: undefined }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ claimed_by: null }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ claimed_by: "Not A Party" }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ fence_token: undefined }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ fence_token: 1.5 }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ updated_at: "" }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ intent: undefined }))).toBeUndefined();
    expect(parseClaimedTask(taskRow({ status: undefined }))).toBeUndefined();
  });

  it("refuses anything that is not a row", () => {
    for (const bad of [null, undefined, 7, "row", []]) {
      expect(parseClaimedTask(bad)).toBeUndefined();
    }
  });

  it("accepts a fence token of zero, which is the column default", () => {
    expect(parseClaimedTask(taskRow({ fence_token: 0 }))?.fencing_token).toBe(0);
  });

  it("leaves the four unwritten contract fields absent rather than inventing them", () => {
    const claim = parseClaimedTask(taskRow({ payload: {}, result: {} }));
    expect(claim?.goal_id).toBeUndefined();
    expect(claim?.deadline).toBeUndefined();
    expect(claim?.checkpoint_ref).toBeUndefined();
    expect(claim?.last_verified_step).toBeUndefined();
  });
});

describe("claimNextTask", () => {
  it("claims a task and sends the clamped lease the RPC expects", async () => {
    const fetchStub = stubFetch([{ json: [taskRow()] }]);
    const result = await adapter().claimNextTask("openclaw-gateway", 300);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.fencing_token).toBe(3);
    }
    expect(fetchStub.rpcs()).toEqual(["lumina_claim_task"]);
    expect(fetchStub.calls[0]?.method).toBe("POST");
    expect(fetchStub.calls[0]?.body).toEqual({
      p_agent_key: "openclaw-gateway",
      p_lease_seconds: 300,
    });
  });

  it("reports an empty queue as none-available, not as a failure", async () => {
    stubFetch([{ json: [] }]);
    const result = await adapter().claimNextTask("openclaw-gateway", 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("none-available");
    }
  });

  it("reports an inactive agent from the RPC's own exception", async () => {
    stubFetch([
      {
        status: 400,
        text: JSON.stringify({ message: "unknown or inactive agent: openclaw-gateway" }),
      },
    ]);
    const result = await adapter().claimNextTask("openclaw-gateway", 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown-agent");
      expect(result.detail).toMatch(/unknown or inactive agent/u);
    }
  });

  it("refuses a malformed agent key without touching the network", async () => {
    const fetchStub = stubFetch([{ json: [] }]);
    const result = await adapter().claimNextTask("Dal The Owner", 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown-agent");
    }
    expect(fetchStub.calls).toEqual([]);
  });

  it("registers the claim in the restart hint when one is given", async () => {
    const claims = new MemoryStateStore<TaskClaim>();
    stubFetch([{ json: [taskRow()] }]);
    const recovery = adapter(claims);
    await recovery.claimNextTask("openclaw-gateway", 300);
    const held = await recovery.heldClaims();
    expect(held).toHaveLength(1);
    expect(held[0]?.attempt_id).toBe(`${TASK_ID}#2`);
  });

  it("calls a claim it cannot read back uncertain, never retryable", async () => {
    // The claim landed — the row is ours and the attempt counter moved — but the
    // shape is wrong. Retrying would claim a second time.
    stubFetch([{ json: [{ id: TASK_ID, claimed_by: "openclaw-gateway" }] }]);
    const result = await adapter().claimNextTask("openclaw-gateway", 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outcome-unknown");
      expect(result.detail).toMatch(/did not match lumina_tasks/u);
    }
  });

  it("separates a connection that never reached the server from a timeout", async () => {
    stubFetch([{ throws: new Error("connect ECONNREFUSED 127.0.0.1:443") }]);
    const refused = await adapter().claimNextTask("openclaw-gateway", 300);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // Provably no effect, so an ordinary transport failure.
      expect(refused.reason).toBe("transport");
    }

    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    stubFetch([{ throws: abort }]);
    const timedOut = await adapter().claimNextTask("openclaw-gateway", 300);
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      // A timeout says nothing about whether the claim was granted.
      expect(timedOut.reason).toBe("outcome-unknown");
    }
  });
});

describe("checkFence", () => {
  it("reports whether this attempt still holds the task", async () => {
    const fetchStub = stubFetch([{ json: true }]);
    const held = await adapter().checkFence({ task_id: TASK_ID, fencing_token: 3 });
    expect(held).toEqual({ ok: true, held: true });
    expect(fetchStub.calls[0]?.body).toEqual({ p_task_id: TASK_ID, p_fence_token: 3 });

    stubFetch([{ json: false }]);
    expect(await adapter().checkFence({ task_id: TASK_ID, fencing_token: 1 })).toEqual({
      ok: true,
      held: false,
    });
  });

  it("refuses to read a non-boolean as a holder check", async () => {
    stubFetch([{ json: { held: "yes" } }]);
    const result = await adapter().checkFence({ task_id: TASK_ID, fencing_token: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transport");
    }
  });
});

describe("heartbeat", () => {
  const claim = { task_id: TASK_ID, owner: "openclaw-gateway", fencing_token: 3 };

  it("renews a lease the attempt still owns", async () => {
    stubFetch([{ json: [taskRow({ lease_until: "2026-10-31T12:10:00.000Z" })] }]);
    const result = await adapter().heartbeat(claim, 300);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fencing_token).toBe(3);
      expect(result.lease_expires_at).toBe("2026-10-31T12:10:00.000Z");
    }
  });

  it("detects that a newer attempt of the same agent took the task", async () => {
    // The defect this adapter mitigates: the RPC is unfenced, so the renewal
    // itself succeeds. The returned fence token is what gives it away.
    stubFetch([{ json: [taskRow({ fence_token: 5 })] }]);
    const result = await adapter().heartbeat(claim, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fence-superseded");
      expect(result.currentToken).toBe(5);
      expect(result.detail).toMatch(/holds fence 3 but the live fence is 5/u);
    }
  });

  it("reports a lease held by nobody as lost", async () => {
    stubFetch([
      {
        status: 400,
        text: JSON.stringify({ message: "task not owned by agent openclaw-gateway" }),
      },
    ]);
    const result = await adapter().heartbeat(claim, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("lease-lost");
    }
  });
});

describe("finishFenced", () => {
  const claim = {
    task_id: TASK_ID,
    owner: "openclaw-gateway",
    fencing_token: 3,
    attempt_id: `${TASK_ID}#2`,
  };

  it("writes the terminal outcome through the fenced RPC only", async () => {
    const fetchStub = stubFetch([{ json: [{ ok: true, message: "task completed" }] }]);
    const result = await adapter().finishFenced(claim, "completed", { report: "mesh" }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("completed");
      expect(result.message).toBe("task completed");
    }
    expect(fetchStub.rpcs()).toEqual(["lumina_finish_task_fenced"]);
    expect(fetchStub.calls[0]?.body).toEqual({
      p_task_id: TASK_ID,
      p_agent: "openclaw-gateway",
      p_fence_token: 3,
      p_status: "completed",
      p_result: { report: "mesh" },
      p_evidence: {},
    });
  });

  it("clears the restart hint once Postgres has settled the task", async () => {
    const claims = new MemoryStateStore<TaskClaim>();
    stubFetch([{ json: [taskRow()] }, { json: [{ ok: true, message: "done" }] }]);
    const recovery = adapter(claims);
    const claimed = await recovery.claimNextTask("openclaw-gateway", 300);
    expect(await recovery.heldClaims()).toHaveLength(1);
    if (claimed.ok) {
      await recovery.finishFenced(claimed.claim, "completed", null, null);
    }
    expect(await recovery.heldClaims()).toEqual([]);
  });

  it("parses a stale-token refusal into both tokens", async () => {
    stubFetch([
      {
        json: [
          { ok: false, message: "FENCING_REJECTED: token 2 is stale, current fence token is 4" },
        ],
      },
    ]);
    const result = await adapter().finishFenced(
      { ...claim, fencing_token: 2 },
      "completed",
      null,
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "fencing-rejected") {
      expect(result.staleToken).toBe(2);
      expect(result.currentToken).toBe(4);
    }
  });

  it("handles the at-update refusal, which names no token", async () => {
    stubFetch([
      { json: [{ ok: false, message: "FENCING_REJECTED_AT_UPDATE: task changed hands" }] },
    ]);
    const result = await adapter().finishFenced(claim, "completed", null, null);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "fencing-rejected") {
      // Falls back to the token this attempt sent, since the row moved.
      expect(result.staleToken).toBe(3);
      expect(result.currentToken).toBeUndefined();
    }
  });

  it("classifies every other refusal the RPC can raise", async () => {
    const cases = [
      ["NOT_OWNER: task belongs to muse", "not-owner"],
      ["TASK_NOT_FOUND_OR_UNCLAIMED: 1111", "unclaimed"],
      ["INVALID_STATUS: shipped", "invalid-status"],
    ] as const;
    for (const [message, reason] of cases) {
      stubFetch([{ status: 400, text: JSON.stringify({ message }) }]);
      const result = await adapter().finishFenced(claim, "completed", null, null);
      expect(result.ok, message).toBe(false);
      if (!result.ok) {
        expect(result.reason, message).toBe(reason);
      }
      vi.unstubAllGlobals();
    }
  });

  it("names the current owner when the refusal gives one", async () => {
    stubFetch([{ json: [{ ok: false, message: "NOT_OWNER: task belongs to muse" }] }]);
    const result = await adapter().finishFenced(claim, "completed", null, null);
    if (!result.ok && result.reason === "not-owner") {
      expect(result.currentOwner).toBe("muse");
    }
  });

  it("reports a timeout as uncertain, because the finish may have applied", async () => {
    const abort = new Error("aborted");
    abort.name = "TimeoutError";
    stubFetch([{ throws: abort }]);
    const result = await adapter().finishFenced(claim, "completed", null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outcome-unknown");
      expect(result.detail).toMatch(/may have been applied/u);
    }
  });

  it("reports an unreadable success row as uncertain rather than done", async () => {
    stubFetch([{ json: [{ settled: true }] }]);
    const result = await adapter().finishFenced(claim, "completed", null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outcome-unknown");
    }
  });
});

describe("the mitigation this module exists for", () => {
  it("never calls an unfenced closing RPC across a whole attempt", async () => {
    // A regression guard on the module's own claim. lumina_finish_task,
    // lumina_fail_task and lumina_start_task admit a caller on the agent key
    // alone, which every attempt of one agent shares, so a stale worker can
    // overwrite a live attempt through them. This adapter must not reach them.
    const fetchStub = stubFetch([
      { json: [taskRow()] },
      { json: true },
      { json: [taskRow()] },
      { json: [{ ok: true, message: "done" }] },
    ]);
    const recovery = adapter();
    const claimed = await recovery.claimNextTask("openclaw-gateway", 300);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) {
      return;
    }
    await recovery.checkFence(claimed.claim);
    await recovery.heartbeat(claimed.claim, 300);
    await recovery.finishFenced(claimed.claim, "completed", null, null);

    const called = fetchStub.rpcs();
    expect(called).toEqual([
      "lumina_claim_task",
      "lumina_fence_ok",
      "lumina_heartbeat_task",
      "lumina_finish_task_fenced",
    ]);
    for (const forbidden of ["lumina_finish_task", "lumina_fail_task", "lumina_start_task"]) {
      expect(called, forbidden).not.toContain(forbidden);
    }
  });
});

describe("classifyFenceMessage", () => {
  it("returns undefined for a message it does not recognise", () => {
    expect(classifyFenceMessage("connection reset", 3)).toBeUndefined();
    expect(classifyFenceMessage("", 3)).toBeUndefined();
  });

  it("reads a negative current token rather than silently dropping it", () => {
    const result = classifyFenceMessage(
      "FENCING_REJECTED: token 2 is stale, current fence token is -1",
      2,
    );
    if (result && !result.ok && result.reason === "fencing-rejected") {
      expect(result.currentToken).toBe(-1);
    }
  });
});

describe("recoverInterrupted", () => {
  const base = { nowMs: T0, externalEffect: "none" } as const;

  it("retries when nothing external happened", () => {
    const decision = recoverInterrupted({ ...base });
    expect(decision.recovery_policy).toBe("retry");
    expect(decision.requiresReconciliation).toBe(false);
  });

  it("resumes from a checkpoint only when a step was verified", () => {
    expect(
      recoverInterrupted({ ...base, checkpointRef: "ckpt_7", lastVerifiedStep: "step_3" })
        .recovery_policy,
    ).toBe("resume");
    // A checkpoint nobody verified is not a safe place to restart from.
    expect(recoverInterrupted({ ...base, checkpointRef: "ckpt_7" }).recovery_policy).toBe("retry");
    expect(recoverInterrupted({ ...base, lastVerifiedStep: "step_3" }).recovery_policy).toBe(
      "retry",
    );
  });

  it("always parks a non-idempotent external effect, whatever else is true", () => {
    // The order is unconditional about this, so it outranks a valid checkpoint
    // and an expired deadline alike.
    for (const extra of [
      {},
      { checkpointRef: "ckpt_7", lastVerifiedStep: "step_3" },
      { deadlineMs: T0 - 1 },
      { authorizationRevoked: true },
      { sideEffectIdempotencyKey: "imk_x" },
    ]) {
      const decision = recoverInterrupted({
        ...base,
        externalEffect: "non-idempotent",
        ...extra,
      });
      expect(decision.recovery_policy, JSON.stringify(extra)).toBe("manual");
      expect(decision.requiresReconciliation).toBe(true);
    }
  });

  it("parks an unknown write outcome unless a key collapses the replay", () => {
    const unkeyed = recoverInterrupted({ ...base, lastWriteOutcome: "unknown" });
    expect(unkeyed.recovery_policy).toBe("manual");
    expect(unkeyed.requiresReconciliation).toBe(true);
    const keyed = recoverInterrupted({
      ...base,
      lastWriteOutcome: "unknown",
      sideEffectIdempotencyKey: "imk_x",
    });
    expect(keyed.recovery_policy).toBe("retry");
    expect(keyed.reason).toMatch(/imk_x keeps the effect single/u);
  });

  it("aborts on a revoked or expired authorization and on a passed deadline", () => {
    expect(recoverInterrupted({ ...base, authorizationRevoked: true }).recovery_policy).toBe(
      "abort",
    );
    expect(recoverInterrupted({ ...base, authorizationExpiresAtMs: T0 }).recovery_policy).toBe(
      "abort",
    );
    expect(recoverInterrupted({ ...base, deadlineMs: T0 }).recovery_policy).toBe("abort");
    // Still in force: not an abort.
    expect(
      recoverInterrupted({ ...base, authorizationExpiresAtMs: T0 + 1, deadlineMs: T0 + 1 })
        .recovery_policy,
    ).toBe("retry");
  });

  it("parks an idempotent effect that carries no key", () => {
    const decision = recoverInterrupted({ ...base, externalEffect: "idempotent" });
    expect(decision.recovery_policy).toBe("manual");
    expect(decision.reason).toMatch(/carries no idempotency key/u);
    expect(
      recoverInterrupted({
        ...base,
        externalEffect: "idempotent",
        sideEffectIdempotencyKey: "imk_x",
      }).recovery_policy,
    ).toBe("retry");
  });
});

describe("planRecovery", () => {
  it("turns a claim and a situation into the full contract", () => {
    const claim = parseClaimedTask(taskRow()) as TaskClaim;
    const { contract, decision } = planRecovery(claim, {
      nowMs: T0,
      externalEffect: "none",
    });
    expect(contract.task_id).toBe(TASK_ID);
    expect(contract.recovery_policy).toBe("resume");
    expect(decision.reason).toMatch(/resuming from ckpt_7 after step_3/u);
  });

  it("aborts once the claim's own deadline has passed", () => {
    const claim = parseClaimedTask(taskRow({ result: {} })) as TaskClaim;
    const { contract } = planRecovery(claim, {
      nowMs: Date.parse("2026-11-02T00:00:00.000Z"),
      externalEffect: "none",
    });
    expect(contract.recovery_policy).toBe("abort");
  });

  it("ignores an unparseable deadline instead of aborting on it", () => {
    const claim = parseClaimedTask(
      taskRow({ payload: { deadline: "whenever" }, result: {} }),
    ) as TaskClaim;
    expect(
      planRecovery(claim, { nowMs: T0, externalEffect: "none" }).contract.recovery_policy,
    ).toBe("retry");
  });
});

describe("assessContinuity", () => {
  const lease = {
    nowMs: T0,
    owner: "openclaw-gateway",
    fencingToken: 3,
    leaseExpiresAtMs: T0 + 60_000,
  };

  it("keeps the task owned when the gateway is unreachable", () => {
    const verdict = assessContinuity({ gatewayReachable: false }, lease);
    expect(verdict.service).toBe("unreachable");
    expect(verdict.taskContinuity).toBe("owned");
    // A service outage never loses a task; the lease row decides ownership.
    expect(verdict.taskLostByServiceOutage).toBe(false);
    expect(verdict.reason).toMatch(/service outage/u);
  });

  it("treats a blank browser as a degraded session, not a gateway outage", () => {
    for (const browserUrl of ["about:blank", "", "about:newtab"]) {
      const verdict = assessContinuity({ gatewayReachable: true, browserUrl }, lease);
      expect(verdict.service, browserUrl).toBe("degraded");
      expect(verdict.degraded).toContain("browser-blank");
      expect(verdict.taskContinuity).toBe("owned");
      expect(verdict.reason).toMatch(/not a gateway outage/u);
    }
  });

  it("calls a real page healthy", () => {
    const verdict = assessContinuity(
      { gatewayReachable: true, browserUrl: "https://chatgpt.com/c/6ac2f0db" },
      lease,
    );
    expect(verdict.service).toBe("healthy");
    expect(verdict.degraded).toEqual([]);
  });

  it("notes an owner change and a config reload as degraded, never as task loss", () => {
    const verdict = assessContinuity(
      { gatewayReachable: true, sessionOwnerChanged: true, configReloadedAtMs: T0 },
      lease,
    );
    expect(verdict.service).toBe("degraded");
    expect(verdict.degraded).toEqual(["session-owner-changed", "config-reloaded"]);
    expect(verdict.taskContinuity).toBe("owned");
    expect(verdict.taskLostByServiceOutage).toBe(false);
    expect(verdict.reason).toMatch(/restarts workers and not tasks/u);
  });

  it("reports an expired lease as requeued, not as lost", () => {
    const verdict = assessContinuity(
      { gatewayReachable: true },
      { ...lease, leaseExpiresAtMs: T0 - 1 },
    );
    expect(verdict.taskContinuity).toBe("lease-expired");
    expect(verdict.reason).toMatch(/requeued, not lost/u);
  });

  it("says ownership is unknown when no lease deadline is known", () => {
    const verdict = assessContinuity(
      { gatewayReachable: true },
      { nowMs: T0, owner: "openclaw-gateway", fencingToken: 3 },
    );
    expect(verdict.taskContinuity).toBe("unknown");
    expect(verdict.reason).toMatch(/must be read back/u);
  });
});
