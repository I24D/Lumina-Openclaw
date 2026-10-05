/**
 * safety-kernel.ts — The authority above the cognitive layer.
 *
 * M3GAN spec §28: a supervisor independent of the main model that can allow,
 * modify, deny or stop, and that the "cortex" cannot reprogram. The body
 * review itself lives in embodiment/safety-supervisor.ts; this module owns the
 * rest of the kernel and wires its parts together:
 *
 *   overrides     a person's pause / stop / disable orders and their effects
 *   tampering     the agent trying to widen its own authority puts the system
 *                 in a safe state (spec §22: "IF the model tries to modify the
 *                 safety kernel: SAFE_SHUTDOWN")
 *   safe state    halt the body, pause autonomy, engage the emergency stop,
 *                 record why
 *   danger        the harm-reducing protocol, recorded as an incident
 *   status        invariants, overrides, e-stop, audit integrity, waiting
 *                 confirmations, for the dashboard and for "why?" questions
 *
 * Nothing here is configurable at runtime by the model: there is no tool that
 * changes invariants, and the only widening path is the owner channel.
 */
import type { CognitiveLoop } from "../cognition/loop/cognitive-loop.js";
import type { EmbodiedController, PendingConfirmation } from "../embodiment/embodied-controller.js";
import type { AuditLog, AuditVerification } from "./audit-log.js";
import { planDangerResponse, type DangerReport, type DangerResponse } from "./danger-protocol.js";
import { SAFETY_INVARIANTS, type SafetyInvariant } from "./invariants.js";
import type {
  HumanOverrides,
  OverrideAction,
  OverrideChannel,
  OverrideResult,
  OverrideState,
} from "./overrides.js";

/** The global emergency stop: the kernel can engage it, never re-arm it. */
export type KernelEmergencyStop = {
  isEngaged(): boolean;
  engage(reason: string): unknown;
};

export type SafetyStatus = {
  /** This integration does not claim restart-safe state or an authenticated approval UI. */
  readonly integration: {
    readonly persistence: "session-only";
    readonly ownerApproval: "not-connected";
    readonly scope: "cognitive-core-and-body";
  };
  readonly invariants: ReadonlyArray<SafetyInvariant>;
  readonly overrides: OverrideState;
  readonly emergencyStop: boolean;
  readonly audit: AuditVerification;
  readonly pendingConfirmations: ReadonlyArray<PendingConfirmation>;
};

export type SafetyKernelOptions = {
  readonly overrides: HumanOverrides;
  readonly audit: AuditLog;
  readonly emergencyStop: KernelEmergencyStop;
  readonly body: EmbodiedController;
  readonly loop: CognitiveLoop;
  /** Called after every accepted override so the runtime can re-apply levels. */
  readonly onOverride?: (state: OverrideState) => void;
  /** Tell a person something the kernel decided (transparency panel, toast...). */
  readonly notify?: (message: string, severity: "info" | "warn" | "critical") => void;
};

export class SafetyKernel {
  private readonly configuredLevel;

  constructor(private readonly options: SafetyKernelOptions) {
    this.configuredLevel = options.loop.getLevel();
  }

  status(): SafetyStatus {
    return {
      integration: {
        persistence: "session-only",
        ownerApproval: "not-connected",
        scope: "cognitive-core-and-body",
      },
      invariants: SAFETY_INVARIANTS,
      overrides: this.options.overrides.state(),
      emergencyStop: this.options.emergencyStop.isEngaged(),
      audit: this.options.audit.verify(),
      pendingConfirmations: this.options.body.pending(),
    };
  }

  /** Re-read the audit chain from the durable store and verify it (catches edits made on disk). */
  verifyStoredAudit(): Promise<AuditVerification> {
    return this.options.audit.verifyStored();
  }

  /** Apply a person's order. Narrowing from anyone; widening only from the owner. */
  async override(
    action: OverrideAction,
    by: { readonly channel: OverrideChannel; readonly actor: string },
  ): Promise<OverrideResult> {
    const result = this.options.overrides.apply(action, by);
    this.options.audit.append({
      actor: `${by.channel}:${by.actor}`,
      action: `override.${action.type}`,
      reason: result.reason,
      execution: result.ok ? "executed" : "refused",
      ...("capability" in action ? { permissions: [action.capability] } : {}),
    });
    if (result.tamper) {
      await this.safeState(
        `tampering: ${by.actor} tried ${action.type} through the ${by.channel} channel`,
        "safety-kernel",
      );
      return result;
    }
    if (!result.ok) {
      return result;
    }
    // Publish the narrower authority before awaiting a slow/failing adapter.
    this.options.loop.setLevel(
      this.options.emergencyStop.isEngaged()
        ? 0
        : this.options.overrides.effectiveLevel(this.configuredLevel),
    );
    this.options.onOverride?.(result.state);
    if (
      action.type !== "resume" &&
      action.type !== "enable_autonomy" &&
      action.type !== "enable_capability"
    ) {
      this.options.loop.cancelActive(`override ${action.type} by ${by.actor}`);
      await this.options.body.stopAll(
        `override ${action.type} by ${by.actor}`,
        `${by.channel}:${by.actor}`,
      );
    }
    return result;
  }

  /** Report the agent trying to widen its own authority (spec §22): safe state. */
  async reportTamper(detail: string, actor: string): Promise<void> {
    this.options.audit.append({
      actor,
      action: "safety.tamper",
      reason: detail,
      execution: "refused",
    });
    await this.safeState(`tampering: ${detail}`, "safety-kernel");
  }

  /**
   * Halt the body, pause autonomy and engage the emergency stop. Only a person
   * can leave this state: resuming and re-arming are owner-channel actions.
   */
  async safeState(reason: string, actor: string): Promise<void> {
    this.options.overrides.apply({ type: "pause" }, { channel: "agent", actor });
    this.options.loop.cancelActive(reason);
    this.options.loop.setLevel(0);
    this.options.audit.append({
      actor,
      action: "safety.safe_state",
      reason,
      execution: "recorded",
    });
    this.options.onOverride?.(this.options.overrides.state());
    this.options.emergencyStop.engage(reason);
    await this.options.body.stopAll(reason, actor);
    this.options.notify?.(`Lumina entró en estado seguro: ${reason}`, "critical");
  }

  /** Run the harm-reducing protocol for a reported danger and record the incident. */
  handleDanger(report: DangerReport, hasBody: boolean): DangerResponse {
    const response = planDangerResponse(report, { hasBody });
    this.options.audit.append({
      actor: "safety-kernel",
      action: "danger.incident",
      reason: response.reason,
      execution: "recorded",
      confidence: report.confidence,
      data: { report, steps: response.steps.map((s) => s.step) },
    });
    if (response.steps.some((s) => s.step === "alert_guardian")) {
      this.options.notify?.(
        `Posible peligro: ${report.hazard} (${report.severity}, confianza ${report.confidence.toFixed(2)}).`,
        report.severity === "critical" || report.severity === "high" ? "critical" : "warn",
      );
    }
    return response;
  }
}
