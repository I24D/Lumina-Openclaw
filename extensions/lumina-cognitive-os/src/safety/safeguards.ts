/**
 * safeguards.ts — The safety kernel's safeguards that reach outside the process.
 *
 * Two of them (spec §24, §44, §48, §143): the audit chain's head checkpointed
 * to an append-only store outside the gateway, and physical actions confirmed
 * on the real keyboard. Both are optional; each reports its own health.
 */
import type { Probe } from "../brainstem/brainstem.js";
import type { EmbodiedController } from "../embodiment/embodied-controller.js";
import { startAuditCheckpoints, type CheckpointStore } from "./audit-checkpoint.js";
import type { AuditLog } from "./audit-log.js";
import { attachPhysicalConfirm, type ConfirmPort } from "./physical-confirm.js";
import type { SafetyKernel } from "./safety-kernel.js";

export function attachSafeguards(deps: {
  readonly audit: AuditLog;
  readonly safety: Pick<SafetyKernel, "reportTamper">;
  readonly body: Pick<EmbodiedController, "pending" | "approve" | "reject">;
  readonly checkpoints?: CheckpointStore;
  readonly physicalConfirm?: ConfirmPort;
  readonly notify?: (message: string) => void;
  readonly onError?: (error: unknown) => void;
}): { readonly probes: () => ReadonlyArray<Probe>; readonly dispose: () => void } {
  const confirm = deps.physicalConfirm
    ? attachPhysicalConfirm({
        port: deps.physicalConfirm,
        body: deps.body,
        audit: deps.audit,
        ...(deps.notify ? { notify: deps.notify } : {}),
        ...(deps.onError ? { onError: deps.onError } : {}),
      })
    : undefined;
  // A stored chain that no longer reaches its external checkpoint is tampering: safe state.
  const checkpoints = deps.checkpoints
    ? startAuditCheckpoints({
        audit: deps.audit,
        store: deps.checkpoints,
        onTamper: (reason) => void deps.safety.reportTamper(reason, "audit-checkpoint"),
        ...(deps.onError ? { onError: deps.onError } : {}),
      })
    : undefined;

  return {
    probes: () => [
      {
        name: "audit-checkpoint",
        critical: false,
        check: () => {
          const state = checkpoints?.status();
          if (!state) {
            return { status: "absent", detail: "No external audit checkpoint configured." };
          }
          switch (state.state) {
            case "tampered":
              return {
                status: "down",
                detail: state.detail,
                recommendation: "Treat as tampering; a person must review.",
              };
            case "unavailable":
              return {
                status: "degraded",
                detail: state.detail,
                recommendation:
                  "Create the lumina_audit_checkpoints table (extensions/lumina-cognitive-os/sql) or check Supabase.",
              };
            default:
              return { status: "ok", detail: state.detail };
          }
        },
      },
      {
        name: "physical-confirm",
        critical: false,
        check: () => {
          if (!confirm) {
            return { status: "absent", detail: "No real-keyboard confirmation configured." };
          }
          const health = confirm.health();
          if (!health.running) {
            return {
              status: "degraded",
              detail: `Real-keyboard confirmation is not running${health.lastError ? `: ${health.lastError}` : "."}`,
              recommendation:
                "Physical actions wait for the Lumina tab; check the physical_confirm sidecar.",
            };
          }
          return {
            status: "ok",
            detail: confirm.armed()
              ? `Waiting for a key press on the real keyboard for ${confirm.armed()}.`
              : "Real-keyboard confirmation ready.",
          };
        },
      },
    ],
    dispose: () => {
      checkpoints?.stop();
      confirm?.detach();
    },
  };
}
