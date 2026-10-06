/**
 * reflection.ts — Lumina looks back at what happened and proposes what to learn.
 *
 * M3GAN spec §17 (reflection) and §25 (online learning is limited). Reads the
 * safety audit and the cognitive loop's recent cycles, finds patterns
 * (actions that keep being refused, failures that repeat, proposals that keep
 * coming back unanswered, a reasoner that errors) and proposes lessons. It
 * never applies them: a person accepts a lesson in the M3GAN tab, so what
 * Lumina learns about her own conduct stays under human review.
 */
import type { AuditLog, AuditRecord } from "../../safety/audit-log.js";
import type { CycleRecord } from "../loop/cognitive-loop.js";

export type ReflectionFinding = {
  readonly kind: "refused" | "failing" | "unanswered" | "reasoner-error";
  readonly subject: string;
  readonly count: number;
  readonly detail: string;
};

export type ProposedLesson = {
  readonly trigger: string;
  readonly claim: string;
  readonly confidence: number;
  readonly evidence: string;
};

export type ReflectionReport = {
  readonly atISO: string;
  readonly window: { readonly audit: number; readonly cycles: number };
  readonly findings: ReadonlyArray<ReflectionFinding>;
  readonly proposedLessons: ReadonlyArray<ProposedLesson>;
};

type AuditAppend = AuditLog["append"];

/** A pattern needs this many occurrences before it means anything. */
const REPEATS = 3;

function countBy<T>(
  items: ReadonlyArray<T>,
  key: (item: T) => string | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k) {
      groups.set(k, [...(groups.get(k) ?? []), item]);
    }
  }
  return groups;
}

/** Repetition raises confidence, but a proposal from reflection never claims certainty. */
const confidenceFor = (count: number) => Math.min(0.85, 0.5 + 0.05 * count);

export function reflect(params: {
  readonly audit: ReadonlyArray<AuditRecord>;
  readonly cycles: ReadonlyArray<CycleRecord>;
  readonly nowISO: string;
}): ReflectionReport {
  const findings: ReflectionFinding[] = [];
  const proposedLessons: ProposedLesson[] = [];

  for (const [action, records] of countBy(params.audit, (r) =>
    r.execution === "refused" ? r.action : undefined,
  )) {
    if (records.length < REPEATS) {
      continue;
    }
    const reason = records[0]?.reason ?? "";
    findings.push({
      kind: "refused",
      subject: action,
      count: records.length,
      detail: `Refused ${records.length} times; latest reason: ${reason}`,
    });
    proposedLessons.push({
      trigger: action,
      claim: `"${action}" is usually refused (${reason}); ask or choose another way before trying it.`,
      confidence: confidenceFor(records.length),
      evidence: `${records.length} refusals in the audit`,
    });
  }

  for (const [action, cycles] of countBy(params.cycles, (c) =>
    c.error || (c.executed === false && c.interrupted) ? (c.action ?? c.event.kind) : undefined,
  )) {
    if (cycles.length < REPEATS) {
      continue;
    }
    findings.push({
      kind: "failing",
      subject: action,
      count: cycles.length,
      detail: `Failed or was interrupted ${cycles.length} times; latest: ${cycles[0]?.error ?? cycles[0]?.reason ?? ""}`,
    });
  }

  for (const [action, cycles] of countBy(params.cycles, (c) =>
    c.outcome === "propose" || c.outcome === "confirm" ? c.action : undefined,
  )) {
    if (cycles.length < REPEATS) {
      continue;
    }
    const trigger = cycles[0]?.event.kind ?? action;
    findings.push({
      kind: "unanswered",
      subject: action,
      count: cycles.length,
      detail: `Proposed ${cycles.length} times without running; the owner may want to pre-authorize it or turn the rule down.`,
    });
    proposedLessons.push({
      trigger,
      claim: `On ${trigger}, "${action}" is a proposal the owner has to answer; do not repeat it insistently.`,
      confidence: confidenceFor(cycles.length),
      evidence: `${cycles.length} unanswered proposals`,
    });
  }

  const errors = params.cycles.filter((c) => c.reason === "reasoner threw; nothing was done");
  if (errors.length > 0) {
    findings.push({
      kind: "reasoner-error",
      subject: "reasoner",
      count: errors.length,
      detail: `The reasoner threw ${errors.length} times; latest: ${errors[0]?.error ?? "unknown"}`,
    });
  }

  return {
    atISO: params.nowISO,
    window: { audit: params.audit.length, cycles: params.cycles.length },
    findings,
    proposedLessons,
  };
}

/** Runs reflection on demand or on a timer and keeps the latest report. */
export function createReflection(deps: {
  readonly audit: { recent(limit: number): ReadonlyArray<AuditRecord>; append: AuditAppend };
  readonly loop: { recent(limit: number): ReadonlyArray<CycleRecord> };
  readonly now: () => number;
}): { readonly run: () => ReflectionReport; readonly latest: () => ReflectionReport | undefined } {
  let latest: ReflectionReport | undefined;
  return {
    run: () => {
      latest = reflect({
        audit: deps.audit.recent(500),
        cycles: deps.loop.recent(256),
        nowISO: new Date(deps.now()).toISOString(),
      });
      deps.audit.append({
        actor: "reflection",
        action: "reflection.run",
        reason: `${latest.findings.length} findings, ${latest.proposedLessons.length} lessons proposed for review`,
        execution: "recorded",
      });
      return latest;
    },
    latest: () => latest,
  };
}
