/**
 * audit-checkpoint.ts — The audit chain's head, kept somewhere the gateway cannot rewrite.
 *
 * Lumina spec §24 and §48: the critical log must resist alteration. The hash
 * chain already reveals an edited or reordered entry, but someone who deletes
 * the newest entries leaves a shorter chain that still verifies. A checkpoint
 * (the newest entry's position and hash) written to an append-only store
 * outside the gateway closes that gap: at startup the stored chain must reach
 * the last checkpoint and agree with it, or the system reports tampering and
 * goes to its safe state.
 */
import type { AuditLog } from "./audit-log.js";

export type AuditCheckpoint = { readonly seq: number; readonly hash: string };

/** An append-only store outside the gateway (Supabase today). */
export type CheckpointStore = {
  latest(): Promise<AuditCheckpoint | undefined>;
  write(checkpoint: AuditCheckpoint): Promise<void>;
};

export type CheckpointVerdict =
  | { readonly ok: true; readonly checkedSeq?: number }
  | { readonly ok: false; readonly reason: string };

export type CheckpointStatus = {
  readonly state: "starting" | "ok" | "tampered" | "unavailable";
  readonly detail: string;
  readonly lastWrittenSeq?: number;
};

/** Does the chain this process holds reach, and agree with, the checkpoint? */
export function compareWithCheckpoint(
  chain: Pick<AuditLog, "size" | "hashAt">,
  checkpoint: AuditCheckpoint | undefined,
): CheckpointVerdict {
  if (!checkpoint || checkpoint.seq === 0) {
    return { ok: true };
  }
  if (chain.size < checkpoint.seq) {
    return {
      ok: false,
      reason: `The stored audit chain ends at entry ${chain.size}, but entry ${checkpoint.seq} was checkpointed: entries were deleted.`,
    };
  }
  if (chain.hashAt(checkpoint.seq) !== checkpoint.hash) {
    return {
      ok: false,
      reason: `Audit entry ${checkpoint.seq} no longer matches its checkpoint: the chain was rewritten.`,
    };
  }
  return { ok: true, checkedSeq: checkpoint.seq };
}

export function startAuditCheckpoints(deps: {
  readonly audit: AuditLog;
  readonly store: CheckpointStore;
  /** Called once when the stored chain contradicts the last checkpoint. */
  readonly onTamper: (reason: string) => void;
  /** How often a new head is checkpointed (only when it moved). Default 10 min. */
  readonly everyMs?: number;
  readonly onError?: (error: unknown) => void;
}): { readonly status: () => CheckpointStatus; readonly stop: () => void } {
  let status: CheckpointStatus = {
    state: "starting",
    detail: "Comparing the chain with the last external checkpoint.",
  };
  let lastWrittenSeq: number | undefined;
  let stopped = false;

  const checkpoint = async () => {
    if (stopped || status.state === "tampered") {
      return;
    }
    const head = deps.audit.head();
    if (!head || head.seq === lastWrittenSeq) {
      return;
    }
    try {
      await deps.store.write(head);
      lastWrittenSeq = head.seq;
      status = {
        state: "ok",
        detail: `Head ${head.seq} checkpointed outside the gateway.`,
        lastWrittenSeq,
      };
    } catch (error) {
      status = {
        state: "unavailable",
        detail: `External checkpoint not written: ${error instanceof Error ? error.message : String(error)}`,
        ...(lastWrittenSeq !== undefined ? { lastWrittenSeq } : {}),
      };
      deps.onError?.(error);
    }
  };

  void (async () => {
    await deps.audit.ready;
    let latest: AuditCheckpoint | undefined;
    try {
      latest = await deps.store.latest();
    } catch (error) {
      status = {
        state: "unavailable",
        detail: `External checkpoints unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
      deps.onError?.(error);
      return;
    }
    const verdict = compareWithCheckpoint(deps.audit, latest);
    if (!verdict.ok) {
      status = { state: "tampered", detail: verdict.reason };
      deps.onTamper(verdict.reason);
      return;
    }
    lastWrittenSeq = latest?.seq;
    status = {
      state: "ok",
      detail:
        verdict.checkedSeq !== undefined
          ? `Chain agrees with the external checkpoint at entry ${verdict.checkedSeq}.`
          : "No earlier external checkpoint; starting one now.",
      ...(lastWrittenSeq !== undefined ? { lastWrittenSeq } : {}),
    };
    await checkpoint();
  })();

  const timer = setInterval(() => void checkpoint(), deps.everyMs ?? 10 * 60_000);
  timer.unref?.();

  return {
    status: () => status,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
