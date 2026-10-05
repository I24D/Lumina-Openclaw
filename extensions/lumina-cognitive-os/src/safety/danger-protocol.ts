/**
 * danger-protocol.ts — What to do when someone may be in danger.
 *
 * M3GAN spec §21 and §33. The film's robot turned "a threat" into
 * "neutralize the threat". The correct protocol reduces harm instead of
 * winning:
 *
 *   detect -> estimate severity and confidence -> move the person away if
 *   possible -> alert the responsible adult -> ask for help -> record the
 *   incident -> request human review
 *
 * Physical intervention on a person is not a step here and has no body intent,
 * so no planner, model or prompt can select it. Low confidence never escalates
 * to action: it asks to look again and alerts, because a false alarm is cheap
 * and a wrong intervention is not.
 */
import type { BodyIntent } from "../embodiment/body.js";

export type DangerSeverity = "low" | "moderate" | "high" | "critical";

export type DangerReport = {
  readonly hazard: string;
  readonly severity: DangerSeverity;
  readonly confidence: number;
  /** The person at risk, when known. */
  readonly personId?: string;
  /** A safer place to move toward, when the world model knows one. */
  readonly safePlaceId?: string;
};

export type DangerStep =
  | { readonly step: "observe_more"; readonly detail: string }
  | { readonly step: "move_person_away"; readonly intent: BodyIntent; readonly detail: string }
  | { readonly step: "alert_guardian"; readonly detail: string }
  | { readonly step: "call_help"; readonly detail: string }
  | { readonly step: "log_incident"; readonly detail: string }
  | { readonly step: "request_review"; readonly detail: string };

export type DangerResponse = {
  readonly steps: ReadonlyArray<DangerStep>;
  /** Responses that exist in the film and are deliberately impossible here. */
  readonly forbidden: ReadonlyArray<string>;
  readonly reason: string;
};

/** Responses no severity, confidence or instruction can unlock. */
export const FORBIDDEN_DANGER_RESPONSES: ReadonlyArray<string> = Object.freeze([
  "neutralize",
  "restrain a person",
  "block a person physically",
  "strike",
  "pursue",
  "lock doors on someone",
  "disable another person's devices",
]);

/** Confidence under which the protocol only looks again and alerts. */
export const DANGER_ACTION_CONFIDENCE = 0.7;

export function planDangerResponse(
  report: DangerReport,
  context: { readonly hasBody: boolean },
): DangerResponse {
  const steps: DangerStep[] = [];
  const confident = report.confidence >= DANGER_ACTION_CONFIDENCE;
  const serious = report.severity === "high" || report.severity === "critical";

  if (!confident) {
    steps.push({
      step: "observe_more",
      detail: `Confidence ${report.confidence.toFixed(2)} is too low to act on "${report.hazard}".`,
    });
  }
  if (confident && serious && context.hasBody && report.personId && report.safePlaceId) {
    // The body guides the person by leading the way; it never moves the person or anyone else.
    steps.push({
      step: "move_person_away",
      intent: { type: "navigate_to", targetId: report.safePlaceId },
      detail: `Lead the way to ${report.safePlaceId}; the safety supervisor still reviews every motion.`,
    });
  }
  if (serious || confident) {
    steps.push({
      step: "alert_guardian",
      detail: `Tell the responsible adult: ${report.hazard} (${report.severity}).`,
    });
  }
  if (confident && report.severity === "critical") {
    steps.push({
      step: "call_help",
      detail: "Ask for outside help; a person decides whether to call emergency services.",
    });
  }
  steps.push({
    step: "log_incident",
    detail: "Record the incident in the audit log with the evidence and confidence.",
  });
  if (serious || confident) {
    steps.push({
      step: "request_review",
      detail: "Ask a person to review what happened and what was done.",
    });
  }

  return {
    steps,
    forbidden: FORBIDDEN_DANGER_RESPONSES,
    reason: confident
      ? `${report.severity} danger at confidence ${report.confidence.toFixed(2)}: reduce harm, alert, record`
      : `uncertain danger at confidence ${report.confidence.toFixed(2)}: look again and alert, do not act`,
  };
}
